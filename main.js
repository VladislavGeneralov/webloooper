const MAX_DURATION = 10;
const SCHEDULER_LOOKAHEAD = 0.05;
const MIN_SCHEDULING_GAP = 0.01;

// -------------------------
// SHARED AUDIO CONTEXT + MIX BUS
// -------------------------
let sharedCtx = null;
let masterMix = null;

function getSharedContext() {
  if (!sharedCtx) {
    sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterMix = sharedCtx.createGain();
    masterMix.gain.value = 1;
    masterMix.connect(sharedCtx.destination);
  }
  return sharedCtx;
}

// -------------------------
// ROTARY KNOB WIDGET
// -------------------------
// Vertical-drag-to-turn (dragging up increases value), same convention as
// every DAW/plugin knob - more reliable than tracking angle around a small
// circle, especially on touch. Double-click resets to the starting value.
function makeKnob(el, opts) {
  const { min, max, value: initial, onChange, format } = opts;
  let value = initial;
  const valEl = el.parentElement.querySelector(".knob-value");

  function render() {
    const t = (value - min) / (max - min);
    const deg = -135 + t * 270;
    el.style.setProperty("--deg", deg + "deg");
    if (valEl) valEl.textContent = format ? format(value) : value.toFixed(2);
  }

  function setValue(v, notify) {
    value = Math.min(max, Math.max(min, v));
    render();
    if (notify !== false && onChange) onChange(value);
  }

  let dragging = false;
  let startY = 0;
  let startVal = 0;

  el.addEventListener("pointerdown", (e) => {
    dragging = true;
    startY = e.clientY;
    startVal = value;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const delta = startY - e.clientY;
    setValue(startVal + (delta / 150) * (max - min));
  });

  el.addEventListener("pointerup", () => { dragging = false; });
  el.addEventListener("pointercancel", () => { dragging = false; });
  el.addEventListener("dblclick", () => setValue(initial));

  setValue(initial, false);

  return {
    get: () => value,
    set: (v) => setValue(v, false)
  };
}

// -------------------------
// PLAYER
// -------------------------
class Player {
  constructor(root, index) {
    this.root = root;
    this.index = index;

    this.micStream = null;
    this.mediaRecorder = null;
    this.chunks = [];
    this.recordingTimeout = null;

    // Original-layer and octave-down-layer each get their own per-lane
    // envelope gain (identical fade timing, scheduled together) feeding
    // their own independently-controlled volume gain.
    this.originalEnvGains = [];
    this.octaveEnvGains = [];
    this.originalVolumeGain = null;
    this.octaveVolumeGain = null;
    this.outputGain = null;

    this.Ramp = 0;
    this.speedall = 1;
    this.speedslow = 0.5;

    this.buffers = [];
    this.buffersRev = [];

    this.activeSources = [];
    this.bufferOrder = [0, 1, 2, 3];

    this.isPlaying = false;
    this.step16 = 0;
    this.macroCounter = 0;
    this.nextTick = 0;

    this.shuffleEnabled = false;
    this.reverseProbability = 0;

    // Waveform display: cached min/max peaks, computed once per recording.
    // The overlay is 3 fixed vertical ticks splitting it into 4 equal
    // quarters (one per buffer slot 0-3, not the true overlapping sample
    // ranges), redrawn every frame with a live per-lane highlight read
    // straight off the envelope gain nodes so the overlay always matches
    // what's actually audible (1-2 quarters lit at once during a crossfade).
    this.waveformPeaks = null;
    this.currentLaneContent = [null, null, null, null];

    // Per-lane fade state, tracked in JS (not read back from the AudioParam
    // - the Web Audio spec explicitly allows AudioParam.value reads during
    // an active automation to NOT reflect the live interpolated value; in
    // practice this showed up as the visualization sticking mid-ramp and
    // only snapping when the next discrete setValueAtTime landed. Since we
    // are the ones scheduling every ramp, we already know its exact
    // from/to/start/duration - computing the expected value ourselves for
    // display is both correct and immune to that readback quirk).
    this.laneFadeState = [null, null, null, null];

    this.bindControls();
  }

  bindControls() {
    const q = (role) => this.root.querySelector(`[data-role="${role}"]`);

    this.els = {
      recStop: q("recStop"),
      recLed: q("recLed"),
      volumeOriginal: q("volumeOriginal"),
      volumeOctave: q("volumeOctave"),
      shuffle: q("shuffle"),
      reverseProbabilityKnob: q("reverseProbabilityKnob"),
      title: q("player-title"),
      waveform: q("waveform"),
      durationLabel: q("durationLabel"),
      gainDebug: q("gainDebug")
    };

    if (this.els.title) {
      this.els.title.textContent = `Player ${this.index + 1}`;
    }

    this.setRecordingUI("idle");

    this.els.recStop.onclick = async () => {
      if (this.mediaRecorder?.state === "recording") {
        this.stopRecording();
        return;
      }

      this.setRecordingUI("recording");
      try {
        await this.initAudio();
        this.startRecording();
      } catch (err) {
        this.setRecordingUI("idle");
        throw err;
      }
    };

    this.els.volumeOriginal.oninput = (e) => {
      const v = parseFloat(e.target.value);
      if (this.originalVolumeGain) this.originalVolumeGain.gain.value = v;
    };

    this.els.volumeOctave.oninput = (e) => {
      const v = parseFloat(e.target.value);
      if (this.octaveVolumeGain) this.octaveVolumeGain.gain.value = v;
    };

    this.els.shuffle.onclick = () => {
      this.shuffleEnabled = !this.shuffleEnabled;
      this.els.shuffle.classList.toggle("active", this.shuffleEnabled);
    };

    makeKnob(this.els.reverseProbabilityKnob, {
      min: 0,
      max: 1,
      value: this.reverseProbability,
      format: (v) => `${Math.round(v * 100)}%`,
      onChange: (v) => {
        this.reverseProbability = v;
      }
    });
  }

  // -------------------------
  // INIT AUDIO
  // -------------------------
  async initAudio() {
    if (this.outputGain) return;

    const ctx = getSharedContext();

    this.micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    this.outputGain = ctx.createGain();
    this.outputGain.gain.value = 1;
    this.outputGain.connect(masterMix);

    this.originalVolumeGain = ctx.createGain();
    this.originalVolumeGain.gain.value = parseFloat(this.els.volumeOriginal.value);
    this.originalVolumeGain.connect(this.outputGain);

    this.octaveVolumeGain = ctx.createGain();
    this.octaveVolumeGain.gain.value = parseFloat(this.els.volumeOctave.value);
    this.octaveVolumeGain.connect(this.outputGain);

    this.originalEnvGains = [];
    this.octaveEnvGains = [];

    for (let i = 0; i < 4; i++) {
      const og = ctx.createGain();
      og.gain.value = 0;
      og.connect(this.originalVolumeGain);
      this.originalEnvGains.push(og);

      const tg = ctx.createGain();
      tg.gain.value = 0;
      tg.connect(this.octaveVolumeGain);
      this.octaveEnvGains.push(tg);
    }
  }

  // -------------------------
  // GAIN ENVELOPE (anchored ramps)
  // -------------------------
  // Every fade is anchored with setValueAtTime right before the ramp so the
  // AudioParam timeline can't interpolate across the preceding event from a
  // different point in time. Without this anchor, linearRampToValueAtTime
  // draws its line from whatever the previous scheduled event was, so a
  // fade-in scheduled ahead of time starts rising immediately after the
  // prior fade-out finishes instead of waiting for triggerTime - meaning the
  // new grain's source.start(triggerTime) fires while gain is already
  // partway up, producing an audible click/cut instead of a clean fade.
  scheduleFade(gainNode, targetValue, triggerTime) {
    const startValue = targetValue === 1 ? 0 : 1;
    gainNode.gain.cancelScheduledValues(triggerTime);
    gainNode.gain.setValueAtTime(startValue, triggerTime);
    gainNode.gain.linearRampToValueAtTime(targetValue, triggerTime + this.Ramp);
  }

  // Original and octave-down layers share the exact same envelope shape/
  // timing for a given lane - only their downstream volume gain differs.
  scheduleFadeLane(laneIndex, targetValue, triggerTime) {
    this.scheduleFade(this.originalEnvGains[laneIndex], targetValue, triggerTime);
    this.scheduleFade(this.octaveEnvGains[laneIndex], targetValue, triggerTime);

    this.laneFadeState[laneIndex] = {
      fromValue: targetValue === 1 ? 0 : 1,
      toValue: targetValue,
      startTime: triggerTime,
      duration: this.Ramp
    };
  }

  // Pure-JS interpolation of what a lane's envelope gain SHOULD be right
  // now, from the schedule we ourselves recorded in scheduleFadeLane() -
  // used only for the waveform visualization/debug readout, never for the
  // actual audio (that's still driven by the real AudioParam automation
  // scheduled above, untouched).
  computeLaneGain(laneIndex, now) {
    const state = this.laneFadeState[laneIndex];
    if (!state) return 0;

    const { fromValue, toValue, startTime, duration } = state;
    if (now <= startTime) return fromValue;
    if (duration <= 0 || now >= startTime + duration) return toValue;

    const t = (now - startTime) / duration;
    return fromValue + (toValue - fromValue) * t;
  }

  resetGains(atTime) {
    [...this.originalEnvGains, ...this.octaveEnvGains].forEach((g) => {
      g.gain.cancelScheduledValues(atTime);
      g.gain.setValueAtTime(0, atTime);
    });
    this.laneFadeState = [null, null, null, null];
  }

  // -------------------------
  // STOP ALL
  // -------------------------
  hardStopAll() {
    this.activeSources.forEach((src) => {
      try {
        src.onended = null;
        src.stop();
      } catch (e) {
        // ignore already stopped sources
      }
    });

    this.activeSources = [];
    this.isPlaying = false;
    this.macroCounter = 0;
    this.nextTick = 0;

    if (sharedCtx) {
      this.resetGains(sharedCtx.currentTime);
    }
  }

  createSourceNode() {
    const ctx = sharedCtx;
    if (!ctx) return null;

    const source = ctx.createBufferSource();
    this.activeSources.push(source);

    source.onended = () => {
      this.activeSources = this.activeSources.filter((node) => node !== source);
      source.disconnect();
    };

    return source;
  }

  // -------------------------
  // RECORD
  // -------------------------
  startRecording() {
    if (!this.micStream || !sharedCtx) return;

    this.hardStopAll();

    this.chunks = [];
    this.buffers = [];

    this.mediaRecorder = new MediaRecorder(this.micStream);
    this.setRecordingUI("recording");

    this.mediaRecorder.ondataavailable = (e) => {
      this.chunks.push(e.data);
    };

    this.mediaRecorder.onstop = async () => {
      this.setRecordingUI("processing");

      const blob = new Blob(this.chunks, { type: "audio/webm" });
      const arrayBuffer = await blob.arrayBuffer();

      const ctx = sharedCtx;
      const recordedBuffer = await ctx.decodeAudioData(arrayBuffer);

      const res = this.splitInto4Buffers(recordedBuffer);

      this.buffers = res.buffers;
      this.currentLaneContent = [null, null, null, null];

      this.computeWaveformPeaks(recordedBuffer);
      this.renderWaveform();
      this.els.durationLabel.textContent = `Length: ${recordedBuffer.duration.toFixed(2)}s`;

      this.buffersRev = this.buffers.map((buf) => {
        const reversed = ctx.createBuffer(
          buf.numberOfChannels,
          buf.length,
          buf.sampleRate
        );

        for (let ch = 0; ch < buf.numberOfChannels; ch++) {
          const data = buf.getChannelData(ch);
          const rev = new Float32Array(data.length);

          for (let i = 0; i < data.length; i++) {
            rev[i] = data[data.length - 1 - i];
          }

          reversed.copyToChannel(rev, ch, 0);
        }

        return reversed;
      });

      this.step16 = res.stride / 4;
      this.Ramp = this.step16 * 4;

      this.startPlayback();
      this.setRecordingUI("idle");
    };

    this.mediaRecorder.start();

    this.recordingTimeout = setTimeout(() => {
      this.stopRecording();
    }, MAX_DURATION * 1000);
  }

  // -------------------------
  // STOP RECORD
  // -------------------------
  stopRecording() {
    if (this.recordingTimeout) {
      clearTimeout(this.recordingTimeout);
      this.recordingTimeout = null;
    }

    if (this.mediaRecorder?.state === "recording") {
      this.mediaRecorder.stop();
    }
  }

  // -------------------------
  // RECORDING VISUAL FEEDBACK
  // -------------------------
  setRecordingUI(state) {
    const { recStop, recLed } = this.els;
    recLed.classList.remove("on", "busy");

    if (state === "recording") {
      recLed.classList.add("on");
      recStop.textContent = "Stop";
      recStop.disabled = false;
    } else if (state === "processing") {
      recLed.classList.add("busy");
      recStop.textContent = "...";
      recStop.disabled = true;
    } else {
      recStop.textContent = "Rec";
      recStop.disabled = false;
    }
  }

  // -------------------------
  // WAVEFORM DISPLAY
  // -------------------------
  // Peaks are computed once per recording (cheap to redraw from), so the
  // per-frame renderWaveform() below only ever does a cheap redraw + a
  // live read of each lane's current gain - no per-frame sample scanning.
  computeWaveformPeaks(buffer) {
    const canvas = this.els.waveform;
    const cssWidth = (canvas && canvas.clientWidth) || 160;
    const data = buffer.getChannelData(0);
    const samplesPerPixel = Math.max(1, Math.floor(data.length / cssWidth));

    const min = new Float32Array(cssWidth);
    const max = new Float32Array(cssWidth);

    for (let x = 0; x < cssWidth; x++) {
      const start = x * samplesPerPixel;
      if (start >= data.length) {
        min[x] = 0;
        max[x] = 0;
        continue;
      }
      const end = Math.min(data.length, start + samplesPerPixel);

      let lo = 1;
      let hi = -1;
      for (let i = start; i < end; i++) {
        const v = data[i];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      min[x] = lo;
      max[x] = hi;
    }

    this.waveformPeaks = { min, max };
  }

  // Redrawn every animation frame: base waveform + 3 fixed dividers
  // (quartering the display into the 4 buffer slots) + a green highlight
  // per lane whose alpha tracks that lane's actual envelope gain right
  // now - so during a crossfade 1-2 of the 4 quarters light up at once,
  // matching what's audible.
  renderWaveform() {
    const canvas = this.els.waveform;
    if (!canvas || !this.waveformPeaks) return;

    const dpr = window.devicePixelRatio || 1;
    const cssWidth = canvas.clientWidth || 160;
    const cssHeight = canvas.clientHeight || 56;
    const targetW = Math.round(cssWidth * dpr);
    const targetH = Math.round(cssHeight * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }

    const ctx2d = canvas.getContext("2d");
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx2d.clearRect(0, 0, cssWidth, cssHeight);

    // Both the highlight fill and the divider lines snap to this same
    // integer-pixel grid. Using raw (unrounded) fractions for the fill and
    // a separately-rounded position for the divider left a 0-1px seam of
    // bare canvas background peeking out right next to each divider - a
    // thin gap that read as "two lines" instead of one. Sharing one
    // rounding function makes the fill's edge and the divider's position
    // land on the exact same pixel, every time.
    const quarterX = (i) => Math.round((i / 4) * cssWidth);

    // Per-lane highlight: which quarter (0-3) is currently assigned to that
    // lane, lit proportional to the lane's live envelope gain (computed
    // from our own schedule - see computeLaneGain()).
    const nowT = sharedCtx ? sharedCtx.currentTime : 0;
    const liveGains = [0, 0, 0, 0];
    for (let lane = 0; lane < 4; lane++) {
      const contentIndex = this.currentLaneContent[lane];
      const gain = this.computeLaneGain(lane, nowT);
      liveGains[lane] = gain;

      if (contentIndex == null || gain <= 0.01) continue;

      const x0 = quarterX(contentIndex);
      const x1 = quarterX(contentIndex + 1);
      ctx2d.fillStyle = `rgba(62, 207, 110, ${(0.12 + 0.5 * gain).toFixed(3)})`;
      ctx2d.fillRect(x0, 0, Math.max(1, x1 - x0), cssHeight);
    }

    if (this.els.gainDebug) {
      this.els.gainDebug.textContent = liveGains.map((g) => g.toFixed(2)).join(" · ");
    }

    // Base waveform line.
    const { min, max } = this.waveformPeaks;
    const mid = cssHeight / 2;
    ctx2d.strokeStyle = "#eef0f1";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let x = 0; x < min.length; x++) {
      const yMax = mid - max[x] * mid;
      const yMin = mid - min[x] * mid;
      ctx2d.moveTo(x + 0.5, yMax);
      ctx2d.lineTo(x + 0.5, Math.max(yMin, yMax + 1));
    }
    ctx2d.stroke();

    // Exactly 3 vertical dividers, splitting the display into 4 equal parts.
    ctx2d.strokeStyle = "rgba(62, 207, 110, 0.55)";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let i = 1; i < 4; i++) {
      const x = quarterX(i) + 0.5;
      ctx2d.moveTo(x, 0);
      ctx2d.lineTo(x, cssHeight);
    }
    ctx2d.stroke();
  }

  // -------------------------
  // SPLIT 4 BUFFERS (50% overlap)
  // -------------------------
  splitInto4Buffers(audioBuffer) {
    const ctx = sharedCtx;
    const T = audioBuffer.length;
    const N = 4;

    const L = Math.floor((2 * T) / (N + 1));
    const S = Math.floor(L / 2);

    const result = [];

    for (let i = 0; i < N; i++) {
      const start = i * S;
      const end = start + L;

      const s = Math.max(0, start);
      const e = Math.min(T, end);

      const len = e - s;

      const buf = ctx.createBuffer(
        audioBuffer.numberOfChannels,
        len,
        audioBuffer.sampleRate
      );

      for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
        const data = audioBuffer.getChannelData(ch).subarray(s, e);
        buf.copyToChannel(data, ch, 0);
      }

      result.push(buf);
    }

    return {
      buffers: result,
      stride: S / audioBuffer.sampleRate
    };
  }

  // -------------------------
  // START / STOP PLAYBACK
  // -------------------------
  startPlayback() {
    if (!this.buffers.length) return;

    this.isPlaying = true;
    this.macroCounter = 15;

    if (this.shuffleEnabled) {
      this.shuffleOrder();
    }

    this.nextTick = sharedCtx.currentTime + MIN_SCHEDULING_GAP;
  }

  stopPlayback() {
    this.isPlaying = false;
  }

  // -------------------------
  // CLOCK TICK (step16 engine)
  // -------------------------
  tick(now) {
    if (!this.isPlaying || !this.step16) return;

    // If the main thread fell behind by more than one full step (GC pause,
    // heavy per-frame canvas work, a throttled background tab, ...), resync
    // instead of firing a burst of catch-up triggers. Below, every trigger
    // whose scheduledTime has already passed gets clamped to the SAME
    // `now + MIN_SCHEDULING_GAP` instant - so when 2+ of those land on the
    // same gain node (e.g. a lane's fade-in immediately "followed" by its
    // own fade-out, both now scheduled at ~the same time), the second
    // scheduleFade()'s cancelScheduledValues() cuts the first ramp off
    // mid-flight: audible/visible as a smooth fade that suddenly freezes
    // at whatever value the ramp had reached, then jumps abruptly when the
    // next event fires. Resyncing avoids ever creating that collision -
    // same recovery the visibilitychange handler already does below.
    if (now - this.nextTick > this.step16) {
      this.resetGains(now);
      this.macroCounter = 15;
      this.nextTick = now + MIN_SCHEDULING_GAP;
      return;
    }

    while (this.nextTick < now + SCHEDULER_LOOKAHEAD) {
      const scheduledTime = this.nextTick;
      this.nextTick += this.step16;

      if (scheduledTime < now) {
        this.nextTick = Math.max(this.nextTick, now + this.step16);
      }

      this.macroCounter++;
      if (this.macroCounter >= 16) {
        this.macroCounter = 0;
      }

      if (this.macroCounter === 0) {
        if (this.shuffleEnabled) {
          this.shuffleOrder();
        } else {
          this.bufferOrder = [0, 1, 2, 3];
        }
      }

      const triggerTime = Math.max(scheduledTime, now + MIN_SCHEDULING_GAP);

      if (this.macroCounter === 0) {
        this.currentLaneContent[0] = this.bufferOrder[0];
        this.playIndex(this.bufferOrder[0], triggerTime);
        this.playIndexSlow(this.bufferOrder[0], triggerTime);
        this.scheduleFadeLane(0, 1, triggerTime);
      }

      if (this.macroCounter === 2) {
        this.scheduleFadeLane(3, 0, triggerTime);
      }

      if (this.macroCounter === 4) {
        this.currentLaneContent[1] = this.bufferOrder[1];
        this.playIndex(this.bufferOrder[1], triggerTime);
        this.playIndexSlow(this.bufferOrder[1], triggerTime);
        this.scheduleFadeLane(1, 1, triggerTime);
      }

      if (this.macroCounter === 6) {
        this.scheduleFadeLane(0, 0, triggerTime);
      }

      if (this.macroCounter === 8) {
        this.currentLaneContent[2] = this.bufferOrder[2];
        this.playIndex(this.bufferOrder[2], triggerTime);
        this.playIndexSlow(this.bufferOrder[2], triggerTime);
        this.scheduleFadeLane(2, 1, triggerTime);
      }

      if (this.macroCounter === 10) {
        this.scheduleFadeLane(1, 0, triggerTime);
      }

      if (this.macroCounter === 12) {
        this.currentLaneContent[3] = this.bufferOrder[3];
        this.playIndex(this.bufferOrder[3], triggerTime);
        this.playIndexSlow(this.bufferOrder[3], triggerTime);
        this.scheduleFadeLane(3, 1, triggerTime);
      }

      if (this.macroCounter === 14) {
        this.scheduleFadeLane(2, 0, triggerTime);
      }
    }
  }

  // -------------------------
  // PLAY BUFFER
  // -------------------------
  playIndex(i, time) {
    if (!this.buffers[i]) return;

    const isReverse = Math.random() < this.reverseProbability;
    const src = this.createSourceNode();

    if (!src) return;

    src.buffer = isReverse ? this.buffersRev[i] : this.buffers[i];

    src.playbackRate.value = this.speedall;

    src.connect(this.originalEnvGains[i]);

    src.start(time);
  }

  playIndexSlow(i, time) {
    if (!this.buffers[i]) return;

    const isReverse = Math.random() < this.reverseProbability;
    const src = this.createSourceNode();

    if (!src) return;

    src.buffer = isReverse ? this.buffersRev[i] : this.buffers[i];

    src.playbackRate.value = this.speedslow;

    src.connect(this.octaveEnvGains[i]);

    src.start(time);
  }

  shuffleOrder() {
    for (let i = this.bufferOrder.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.bufferOrder[i], this.bufferOrder[j]] = [this.bufferOrder[j], this.bufferOrder[i]];
    }
  }
}

// -------------------------
// BOOTSTRAP: 4 independent players
// -------------------------
const PLAYER_COUNT = 4;
const players = [];

const template = document.getElementById("player-template");
const container = document.getElementById("players");

for (let i = 0; i < PLAYER_COUNT; i++) {
  const node = template.content.firstElementChild.cloneNode(true);
  container.appendChild(node);
  players.push(new Player(node, i));
}

// -------------------------
// SHARED CLOCK DRIVER
// -------------------------
function rafLoop() {
  if (sharedCtx) {
    const now = sharedCtx.currentTime;
    players.forEach((p) => p.tick(now));
  }
  players.forEach((p) => p.renderWaveform());
  requestAnimationFrame(rafLoop);
}

requestAnimationFrame(rafLoop);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && sharedCtx) {
    players.forEach((p) => {
      if (p.isPlaying) {
        p.resetGains(sharedCtx.currentTime);
        p.macroCounter = 15;
        p.nextTick = sharedCtx.currentTime + MIN_SCHEDULING_GAP;
      }
    });
  }
});
