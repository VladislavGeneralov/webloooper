const MAX_DURATION = 10;
const SCHEDULER_LOOKAHEAD = 0.05;
const MIN_SCHEDULING_GAP = 0.01;

// Fixed internal resolution for the waveform canvas - see renderWaveform()
// for why this is deliberately NOT derived from clientWidth/devicePixelRatio.
const WAVEFORM_CANVAS_W = 320;
const WAVEFORM_CANVAS_H = 112;

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
    this.recordingStartedAt = null;

    // Original-layer and octave-down-layer each get their own per-lane
    // envelope gain (identical fade timing, scheduled together) feeding
    // their own independently-controlled volume gain.
    this.originalEnvGains = [];
    this.octaveEnvGains = [];
    this.originalVolumeGain = null;
    this.octaveVolumeGain = null;
    this.outputGain = null;

    this.Ramp = 0;
    this.DecayRamp = 0;
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

    this.bindControls();
  }

  bindControls() {
    const q = (role) => this.root.querySelector(`[data-role="${role}"]`);

    this.els = {
      recStop: q("recStop"),
      recLed: q("recLed"),
      volumeOriginal: q("volumeOriginal"),
      volumeOriginalValue: q("volumeOriginalValue"),
      volumeOctave: q("volumeOctave"),
      volumeOctaveValue: q("volumeOctaveValue"),
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

    // Displayed % is relative to the fader's own top (max), not to unity
    // gain - the top of the fader always reads "100%" even though the
    // real audio gain there is 8x/800% (the actual usable ceiling, fine
    // sound-wise). The user isn't meant to know/care about the raw gain
    // scale - the fader's own travel is the whole story: middle = 50%.
    this.els.volumeOriginal.oninput = (e) => {
      const v = parseFloat(e.target.value);
      const max = parseFloat(e.target.max);
      if (this.originalVolumeGain) this.originalVolumeGain.gain.value = v;
      if (this.els.volumeOriginalValue) this.els.volumeOriginalValue.textContent = `${Math.round((v / max) * 100)}%`;
    };

    this.els.volumeOctave.oninput = (e) => {
      const v = parseFloat(e.target.value);
      const max = parseFloat(e.target.max);
      if (this.octaveVolumeGain) this.octaveVolumeGain.gain.value = v;
      if (this.els.volumeOctaveValue) this.els.volumeOctaveValue.textContent = `${Math.round((v / max) * 100)}%`;
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
  scheduleFade(gainNode, targetValue, triggerTime, duration) {
    const startValue = targetValue === 1 ? 0 : 1;
    gainNode.gain.cancelScheduledValues(triggerTime);
    gainNode.gain.setValueAtTime(startValue, triggerTime);
    gainNode.gain.linearRampToValueAtTime(targetValue, triggerTime + duration);
  }

  // Original and octave-down layers share the exact same envelope shape/
  // timing for a given lane - only their downstream volume gain differs.
  //
  // Attack uses the full this.Ramp, but decay uses the shorter
  // this.DecayRamp: the original-layer source's own buffer only contains
  // L = 2D/(N+1) worth of real audio (D = recording length), which in
  // step16 units is 8 steps - but fade-out TRIGGERS 6 steps after fade-in
  // (hardcoded by the macroCounter schedule below) and used to ramp for a
  // further this.Ramp = 4 steps, finishing at step 10. That's 2 steps
  // *past* the point the buffer's content actually runs out, so the source
  // was going silent mid-decay, at gain ~0.5, with whatever raw sample
  // value the slice happened to end on - an audible truncation click,
  // structurally guaranteed on every single fade-out regardless of any
  // scheduling/timing jitter. DecayRamp = 2 steps makes decay finish
  // exactly when the fade-out-triggering lane's content ends (6+2=8),
  // so gain is already at/near 0 by the time there's nothing left to play.
  scheduleFadeLane(laneIndex, targetValue, triggerTime) {
    const duration = targetValue === 1 ? this.Ramp : this.DecayRamp;
    this.scheduleFade(this.originalEnvGains[laneIndex], targetValue, triggerTime, duration);
    this.scheduleFade(this.octaveEnvGains[laneIndex], targetValue, triggerTime, duration);
  }

  resetGains(atTime) {
    [...this.originalEnvGains, ...this.octaveEnvGains].forEach((g) => {
      g.gain.cancelScheduledValues(atTime);
      g.gain.setValueAtTime(0, atTime);
    });
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

    this.clearWaveform();

    this.mediaRecorder = new MediaRecorder(this.micStream);
    this.setRecordingUI("recording");
    this.recordingStartedAt = performance.now();
    this.els.durationLabel.textContent = "Recording: 0.0s";

    this.mediaRecorder.ondataavailable = (e) => {
      this.chunks.push(e.data);
    };

    this.mediaRecorder.onstop = async () => {
      this.setRecordingUI("processing");

      const blob = new Blob(this.chunks, { type: "audio/webm" });
      const arrayBuffer = await blob.arrayBuffer();

      const ctx = sharedCtx;
      const decodedBuffer = await ctx.decodeAudioData(arrayBuffer);
      const recordedBuffer = this.trimToExactDivision(decodedBuffer);

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
      this.DecayRamp = this.step16 * 2;

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

  // Live "Recording: X.Xs" readout, ticking every frame while a recording
  // is actually in progress - independent of renderWaveform() (which only
  // runs once there's a previous recording's waveformPeaks to draw).
  updateRecordingLabel() {
    if (this.mediaRecorder?.state !== "recording" || this.recordingStartedAt == null) return;
    const elapsed = (performance.now() - this.recordingStartedAt) / 1000;
    this.els.durationLabel.textContent = `Recording: ${elapsed.toFixed(1)}s`;
  }

  // -------------------------
  // WAVEFORM DISPLAY
  // -------------------------
  // Wipes the canvas and drops the previous recording's peaks/highlight
  // state - called when a new recording starts, so the old waveform
  // doesn't linger on screen while the new one is being captured.
  clearWaveform() {
    this.waveformPeaks = null;
    this.currentLaneContent = [null, null, null, null];

    const canvas = this.els.waveform;
    if (canvas) {
      const ctx2d = canvas.getContext("2d");
      ctx2d.setTransform(1, 0, 0, 1, 0, 0);
      ctx2d.clearRect(0, 0, canvas.width, canvas.height);
    }

    if (this.els.gainDebug) {
      const spans = this.els.gainDebug.children;
      for (let i = 0; i < spans.length; i++) spans[i].textContent = "";
    }
  }

  // Fixed internal resolution, deliberately decoupled from any live layout
  // measurement (canvas.clientWidth, devicePixelRatio). CSS alone scales
  // the finished bitmap down to whatever the container's actual size is.
  // Previously canvas.width/height were set from clientWidth*dpr every
  // frame - on a high-DPI phone that intrinsic buffer size can reach
  // 300-450px+, and grid/flex items floor at their content's intrinsic
  // size by default, so that oversized buffer forced the whole card to
  // grow wide instead of the canvas shrinking via width:100% as intended.
  // A canvas whose width/height never change after the first draw can't
  // trigger that regardless of any ancestor's min-width handling.
  computeWaveformPeaks(buffer) {
    const data = buffer.getChannelData(0);
    const samplesPerPixel = Math.max(1, Math.floor(data.length / WAVEFORM_CANVAS_W));

    const min = new Float32Array(WAVEFORM_CANVAS_W);
    const max = new Float32Array(WAVEFORM_CANVAS_W);

    for (let x = 0; x < WAVEFORM_CANVAS_W; x++) {
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

    if (canvas.width !== WAVEFORM_CANVAS_W || canvas.height !== WAVEFORM_CANVAS_H) {
      canvas.width = WAVEFORM_CANVAS_W;
      canvas.height = WAVEFORM_CANVAS_H;
    }

    const ctx2d = canvas.getContext("2d");
    ctx2d.setTransform(1, 0, 0, 1, 0, 0);
    ctx2d.clearRect(0, 0, WAVEFORM_CANVAS_W, WAVEFORM_CANVAS_H);

    // Both the highlight fill and the divider lines snap to this same
    // integer-pixel grid, so the fill's edge and the divider's position
    // always land on the exact same pixel (no 0-1px seam between them).
    const quarterX = (i) => Math.round((i / 4) * WAVEFORM_CANVAS_W);

    // Per-lane highlight: which quarter (0-3) is currently assigned to that
    // lane, lit proportional to the lane's live envelope gain - read
    // straight off the real AudioParam. (We briefly switched this to a
    // self-computed prediction, suspecting the readback itself was
    // unreliable mid-ramp - it wasn't; the real bug was DecayRamp running
    // 2 steps past the end of the source's own buffer content, see
    // scheduleFadeLane(). Reading the real value is what surfaced that,
    // and is what actually verifies the fix.)
    //
    // The fill is positioned by contentIndex (which quarter of the
    // RECORDING this lane is currently playing), not by lane number - so
    // the debug numbers underneath must be indexed the same way. Indexing
    // them by lane instead (as before) matched the color only when
    // shuffle is off (contentIndex === lane then); with shuffle on, the
    // number under a given quarter could belong to a totally different
    // lane than the one whose gain is actually painting that quarter.
    const gainByContent = [0, 0, 0, 0];
    for (let lane = 0; lane < 4; lane++) {
      const contentIndex = this.currentLaneContent[lane];
      const envGain = this.originalEnvGains[lane];
      const gain = envGain ? envGain.gain.value : 0;

      if (contentIndex == null) continue;
      gainByContent[contentIndex] = Math.max(gainByContent[contentIndex], gain);

      if (gain <= 0.01) continue;

      const x0 = quarterX(contentIndex);
      const x1 = quarterX(contentIndex + 1);
      ctx2d.fillStyle = `rgba(62, 207, 110, ${(0.12 + 0.5 * gain).toFixed(3)})`;
      ctx2d.fillRect(x0, 0, Math.max(1, x1 - x0), WAVEFORM_CANVAS_H);
    }

    if (this.els.gainDebug) {
      const spans = this.els.gainDebug.children;
      for (let i = 0; i < 4 && i < spans.length; i++) {
        spans[i].textContent = gainByContent[i].toFixed(2);
      }
    }

    // Base waveform line.
    const { min, max } = this.waveformPeaks;
    const mid = WAVEFORM_CANVAS_H / 2;
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
      ctx2d.lineTo(x, WAVEFORM_CANVAS_H);
    }
    ctx2d.stroke();
  }

  // -------------------------
  // TRIM TO EXACT DIVISION
  // -------------------------
  // splitInto4Buffers() below derives L=floor(2T/(N+1)), S=floor(L/2) - any
  // remainder gets silently dropped by those floors. Trimming the recording
  // to a multiple of 2*(N+1)=10 samples first makes both divisions land on
  // exact integers, so there's no rounding remainder at all (already
  // sub-millisecond in practice, but this removes it outright for the cost
  // of at most 9 samples, <0.2ms, trimmed off the very end).
  trimToExactDivision(buffer) {
    const N = 4;
    const unit = 2 * (N + 1);
    const total = buffer.length;
    const trimmedLength = total - (total % unit);

    if (trimmedLength === total || trimmedLength === 0) return buffer;

    const ctx = sharedCtx;
    const trimmed = ctx.createBuffer(buffer.numberOfChannels, trimmedLength, buffer.sampleRate);

    for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
      trimmed.copyToChannel(buffer.getChannelData(ch).subarray(0, trimmedLength), ch, 0);
    }

    return trimmed;
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
        this.playIndex(this.bufferOrder[0], 0, triggerTime);
        this.playIndexSlow(this.bufferOrder[0], 0, triggerTime);
        this.scheduleFadeLane(0, 1, triggerTime);
      }

      if (this.macroCounter === 2) {
        this.scheduleFadeLane(3, 0, triggerTime);
      }

      if (this.macroCounter === 4) {
        this.currentLaneContent[1] = this.bufferOrder[1];
        this.playIndex(this.bufferOrder[1], 1, triggerTime);
        this.playIndexSlow(this.bufferOrder[1], 1, triggerTime);
        this.scheduleFadeLane(1, 1, triggerTime);
      }

      if (this.macroCounter === 6) {
        this.scheduleFadeLane(0, 0, triggerTime);
      }

      if (this.macroCounter === 8) {
        this.currentLaneContent[2] = this.bufferOrder[2];
        this.playIndex(this.bufferOrder[2], 2, triggerTime);
        this.playIndexSlow(this.bufferOrder[2], 2, triggerTime);
        this.scheduleFadeLane(2, 1, triggerTime);
      }

      if (this.macroCounter === 10) {
        this.scheduleFadeLane(1, 0, triggerTime);
      }

      if (this.macroCounter === 12) {
        this.currentLaneContent[3] = this.bufferOrder[3];
        this.playIndex(this.bufferOrder[3], 3, triggerTime);
        this.playIndexSlow(this.bufferOrder[3], 3, triggerTime);
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
  // contentIndex (which recorded grain to play) and laneIndex (which fixed
  // schedule slot / envelope gain node is fading it in right now) are two
  // independent things - only equal by coincidence when shuffle is off
  // (bufferOrder is [0,1,2,3] then). With shuffle on they diverge, so both
  // must be passed explicitly: connecting to originalEnvGains[contentIndex]
  // instead of originalEnvGains[laneIndex] used to route the new source
  // into whatever OTHER slot's envelope happened to share that array index
  // - silenced/clicked by a completely unrelated trigger's automation
  // instead of the one actually scheduled for it.
  playIndex(contentIndex, laneIndex, time) {
    if (!this.buffers[contentIndex]) return;

    const isReverse = Math.random() < this.reverseProbability;
    const src = this.createSourceNode();

    if (!src) return;

    src.buffer = isReverse ? this.buffersRev[contentIndex] : this.buffers[contentIndex];

    src.playbackRate.value = this.speedall;

    src.connect(this.originalEnvGains[laneIndex]);

    src.start(time);
  }

  playIndexSlow(contentIndex, laneIndex, time) {
    if (!this.buffers[contentIndex]) return;

    const isReverse = Math.random() < this.reverseProbability;
    const src = this.createSourceNode();

    if (!src) return;

    src.buffer = isReverse ? this.buffersRev[contentIndex] : this.buffers[contentIndex];

    src.playbackRate.value = this.speedslow;

    src.connect(this.octaveEnvGains[laneIndex]);

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
// FIT THE 2-COLUMN GRID TO NARROW VIEWPORTS
// -------------------------
// Scales #players down uniformly (via transform, not CSS `zoom` - that
// was tried first but has inconsistent browser support, confirmed broken
// on iOS Safari, where it rendered the grid full-size and let it overflow
// the screen instead of shrinking). transform:scale doesn't affect layout
// on its own, so #players-wrap's own box is resized in JS to match the
// visually-scaled size - otherwise the page would reserve the full
// unscaled height/width, leaving blank space or a stray scrollbar.
function fitPlayersToViewport() {
  const wrap = document.getElementById("players-wrap");
  if (!wrap || !container) return;

  // #players-wrap is a normal block div - width:auto would otherwise
  // stretch/shrink it to match ITS OWN parent (body's content width),
  // which then constrains #players (also width:auto) to that same
  // already-narrow width before it's ever measured below - so
  // offsetWidth would report the pre-shrunk size, not the grid's true
  // 2-column min-content width. max-content here lets the wrapper (and
  // therefore #players) grow to its real natural size first.
  wrap.style.width = "max-content";
  container.style.transform = "none";
  const naturalWidth = container.offsetWidth;
  const naturalHeight = container.offsetHeight;
  if (!naturalWidth || !naturalHeight) return;

  const bodyStyle = getComputedStyle(document.body);
  const availableWidth = window.innerWidth
    - parseFloat(bodyStyle.paddingLeft || 0)
    - parseFloat(bodyStyle.paddingRight || 0);
  const availableHeight = window.innerHeight
    - parseFloat(bodyStyle.paddingTop || 0)
    - parseFloat(bodyStyle.paddingBottom || 0);

  // Constrained by whichever dimension is tighter, so the grid never
  // overflows either axis (cards are already sized to need little/no
  // scaling on common phones - this just covers unusually short viewports
  // too, e.g. with a lot of browser chrome eating vertical space).
  const scale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);

  container.style.transform = scale < 1 ? `scale(${scale})` : "none";
  wrap.style.width = `${naturalWidth * scale}px`;
  wrap.style.height = `${naturalHeight * scale}px`;
}

window.addEventListener("resize", fitPlayersToViewport);
window.addEventListener("orientationchange", fitPlayersToViewport);
fitPlayersToViewport();

// -------------------------
// SHARED CLOCK DRIVER
// -------------------------
function rafLoop() {
  if (sharedCtx) {
    const now = sharedCtx.currentTime;
    players.forEach((p) => p.tick(now));
  }
  players.forEach((p) => p.renderWaveform());
  players.forEach((p) => p.updateRecordingLabel());
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
