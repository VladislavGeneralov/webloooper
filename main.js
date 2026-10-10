const MAX_DURATION = 10;

// The 4/8 switch above each player's REC LED: how many grains a recording is
// cut into. Lane/envelope nodes are always built for the maximum, so the
// switch never has to rebuild the audio graph - unused lanes just stay at 0.
const SLICE_OPTIONS = [4, 8];
const MAX_SLICES = 8;
// Fade-out of the player's output before a re-slice (see setSliceCount).
const SLICE_SWITCH_FADE = 0.03;
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
// Sum of all 4 players (their outputGains), before the send FX: goes to
// masterMix dry and to each send's own "Send in" gain.
let playersBus = null;

function getSharedContext() {
  if (!sharedCtx) {
    sharedCtx = new (window.AudioContext || window.webkitAudioContext)();
    masterMix = sharedCtx.createGain();
    masterMix.gain.value = 1;
    masterMix.connect(sharedCtx.destination);

    playersBus = sharedCtx.createGain();
    playersBus.gain.value = 1;
    playersBus.connect(masterMix);

    buildSendFx(sharedCtx);
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

    // PITCH knob (semitones -> playback-rate multiplier) and the step length
    // the recording itself implies at rate 1 - see applyPitch().
    this.pitchRate = 1;
    this.baseStep16 = 0;

    this.buffers = [];
    this.buffersRev = [];

    this.activeSources = [];

    // How many grains the recording is cut into (the 4/8 switch). Every
    // per-grain thing - buffers, lanes in use, the macro cycle length, the
    // waveform segments - is sized from this; see loadSlices() and tick().
    this.sliceCount = 4;
    this.bufferOrder = [0, 1, 2, 3];

    // The decoded take, kept whole (untrimmed, unsliced), so flipping the
    // 4/8 switch re-slices the same recording instead of needing a new one.
    // sliceSwitchToken guards the switch's short fade-out/re-slice delay
    // against overlapping flips or a new recording starting meanwhile.
    this.recordedBuffer = null;
    this.sliceSwitchToken = 0;

    this.isPlaying = false;
    this.step16 = 0;
    this.macroCounter = 0;
    this.nextTick = 0;

    this.shuffleEnabled = false;
    this.reverseProbability = 0;

    // Waveform display: cached min/max peaks, computed once per slicing.
    // The overlay is sliceCount-1 fixed vertical ticks splitting it into
    // sliceCount equal segments (one per buffer slot, not the true
    // overlapping sample ranges), redrawn every frame with a live per-lane
    // highlight read straight off the envelope gain nodes so the overlay
    // always matches what's actually audible (1-2 segments lit at once
    // during a crossfade).
    this.waveformPeaks = null;
    this.currentLaneContent = new Array(this.sliceCount).fill(null);

    this.bindControls();
  }

  bindControls() {
    const q = (role) => this.root.querySelector(`[data-role="${role}"]`);

    this.els = {
      recStop: q("recStop"),
      recLed: q("recLed"),
      sliceSwitch: q("sliceSwitch"),
      volumeOriginal: q("volumeOriginal"),
      volumeOriginalValue: q("volumeOriginalValue"),
      volumeOctave: q("volumeOctave"),
      volumeOctaveValue: q("volumeOctaveValue"),
      shuffle: q("shuffle"),
      reverseProbabilityKnob: q("reverseProbabilityKnob"),
      pitchKnob: q("pitchKnob"),
      title: q("player-title"),
      waveform: q("waveform"),
      durationLabel: q("durationLabel"),
      gainDebug: q("gainDebug")
    };

    if (this.els.title) {
      this.els.title.textContent = `Player ${this.index + 1}`;
    }

    this.setRecordingUI("idle");
    this.renderSliceSwitch();
    this.setGainDebugSlots();

    this.els.sliceSwitch.onclick = () => {
      const next = SLICE_OPTIONS[(SLICE_OPTIONS.indexOf(this.sliceCount) + 1) % SLICE_OPTIONS.length];
      this.setSliceCount(next);
    };

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
    // real audio gain there is 4x/400% (was 8x - halved, both faders, for
    // a quieter overall level). The user isn't meant to know/care about the raw gain
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

    makeKnob(this.els.pitchKnob, {
      min: -12,
      max: 12,
      value: 0,
      format: (v) => (Math.abs(v) < 0.05 ? "0 st" : `${v > 0 ? "+" : ""}${v.toFixed(1)} st`),
      onChange: (v) => {
        this.pitchRate = Math.pow(2, v / 12);
        this.applyPitch();
      }
    });
  }

  // -------------------------
  // PITCH (varispeed)
  // -------------------------
  // Like a tape: every grain plays at pitchRate (the octave-down layer at
  // half of it) and the step clock runs pitchRate times faster, so the
  // slicing stays exactly the same - the whole loop just gets higher+faster
  // or lower+slower. Ramp/DecayRamp scale with the step, keeping the
  // DecayRamp guarantee (decay ends when the grain's content ends, see
  // scheduleFadeLane()) at any rate. Grains already playing are retuned at
  // the same instant, so their remaining content stays in step with the
  // new step length their fade-out will be scheduled on - left at the old
  // rate, slowing down mid-grain would push that fade-out past the end of
  // the buffer: the same truncation click DecayRamp exists to prevent.
  applyPitch() {
    this.speedall = this.pitchRate;
    this.speedslow = this.pitchRate * 0.5;

    if (this.baseStep16) {
      this.step16 = this.baseStep16 / this.pitchRate;
      this.Ramp = this.step16 * 4;
      this.DecayRamp = this.step16 * 2;
    }

    if (sharedCtx) {
      const now = sharedCtx.currentTime;
      this.activeSources.forEach((src) => {
        src.playbackRate.setValueAtTime(this.pitchRate * src.rateFactor, now);
      });
    }
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

    // MediaRecorder can only record a MediaStream, not a Web Audio node, so
    // any input gain has to happen via a real audio-graph detour: mic ->
    // GainNode -> MediaStreamDestination, then MediaRecorder records *that*
    // stream instead of the raw mic stream. Currently unity (1x, was 1.3x) -
    // the node stays in place so the input level is one number to change.
    this.micSource = ctx.createMediaStreamSource(this.micStream);
    this.inputGain = ctx.createGain();
    this.inputGain.gain.value = 1;
    this.micSource.connect(this.inputGain);
    this.micDestination = ctx.createMediaStreamDestination();
    this.inputGain.connect(this.micDestination);

    this.outputGain = ctx.createGain();
    this.outputGain.gain.value = 1;
    this.outputGain.connect(playersBus);

    this.originalVolumeGain = ctx.createGain();
    this.originalVolumeGain.gain.value = parseFloat(this.els.volumeOriginal.value);
    this.originalVolumeGain.connect(this.outputGain);

    this.octaveVolumeGain = ctx.createGain();
    this.octaveVolumeGain.gain.value = parseFloat(this.els.volumeOctave.value);
    this.octaveVolumeGain.connect(this.outputGain);

    this.originalEnvGains = [];
    this.octaveEnvGains = [];

    for (let i = 0; i < MAX_SLICES; i++) {
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
    this.recordedBuffer = null;
    this.sliceSwitchToken++; // cancels a 4/8 re-slice still waiting on its fade-out
    if (this.outputGain) {
      // ...and reopens the output that re-slice may have been fading out
      this.outputGain.gain.cancelScheduledValues(sharedCtx.currentTime);
      this.outputGain.gain.setValueAtTime(1, sharedCtx.currentTime);
    }

    this.clearWaveform();

    this.mediaRecorder = new MediaRecorder(this.micDestination.stream);
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

      this.recordedBuffer = await sharedCtx.decodeAudioData(arrayBuffer);
      this.loadSlices();

      this.startPlayback();
      this.setRecordingUI("idle");
    };

    this.mediaRecorder.start();

    this.recordingTimeout = setTimeout(() => {
      this.stopRecording();
    }, MAX_DURATION * 1000);
  }

  // -------------------------
  // SLICE THE TAKE
  // -------------------------
  // Trim + cut this.recordedBuffer into this.sliceCount grains and reset
  // everything that's sized per grain. Called after every recording and on
  // every 4/8 flip (with playback stopped in both cases - see setSliceCount).
  loadSlices() {
    const ctx = sharedCtx;
    const N = this.sliceCount;
    const recordedBuffer = this.trimToExactDivision(this.recordedBuffer, N);

    const res = this.splitIntoBuffers(recordedBuffer, N);

    this.buffers = res.buffers;
    this.bufferOrder = Array.from({ length: N }, (_, i) => i);
    this.currentLaneContent = new Array(N).fill(null);
    this.setGainDebugSlots();

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

    // step16 = a quarter of the stride between grain starts, for any N -
    // so a grain's content (L = 2*stride) is always 8 steps long, which is
    // what the fade schedule in tick() and DecayRamp are built around.
    this.baseStep16 = res.stride / 4;
    this.applyPitch();
  }

  // -------------------------
  // 4/8 SWITCH
  // -------------------------
  // With no loop playing (nothing recorded yet, or mid-recording/decoding)
  // the new count is just stored - the next loadSlices() picks it up. With
  // a loop playing, re-slicing means stopping every source, and a bare
  // hardStopAll() would cut the audio mid-waveform (a click). So the
  // player's own outputGain fades out first (SLICE_SWITCH_FADE), then the
  // take is re-sliced and restarted from the top behind the closed gain,
  // and outputGain opens again - the restart always begins with lane 0's
  // normal Ramp fade-in from 0, so there's no click on the way back in.
  setSliceCount(count) {
    if (count === this.sliceCount) return;
    this.sliceCount = count;
    this.renderSliceSwitch();

    if (!this.recordedBuffer || !this.isPlaying || !sharedCtx) {
      this.currentLaneContent = new Array(count).fill(null);
      this.setGainDebugSlots();
      return;
    }

    // Stop scheduling new grains right away: tick() already sizes its cycle
    // from the new sliceCount, but buffers/bufferOrder are still the old
    // slicing until loadSlices() runs. Grains already sounding play on
    // under the fade. A second flip during the wait lands in the branch
    // above (not playing), and this pending re-slice picks up its count.
    this.isPlaying = false;

    const token = ++this.sliceSwitchToken;
    const gain = this.outputGain.gain;
    const now = sharedCtx.currentTime;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, now + SLICE_SWITCH_FADE);

    setTimeout(() => {
      if (token !== this.sliceSwitchToken || !this.recordedBuffer) return;
      this.hardStopAll();
      this.loadSlices();
      const t = sharedCtx.currentTime;
      gain.cancelScheduledValues(t);
      gain.setValueAtTime(1, t);
      this.startPlayback();
    }, (SLICE_SWITCH_FADE + 0.015) * 1000);
  }

  renderSliceSwitch() {
    const sw = this.els.sliceSwitch;
    sw.classList.toggle("on", this.sliceCount === 8);
    sw.setAttribute("aria-label", `Slices: ${this.sliceCount}`);
  }

  // One gain readout per grain under the waveform, in as many columns as
  // there are segments, so each number sits under its own segment.
  setGainDebugSlots() {
    const el = this.els.gainDebug;
    if (!el) return;
    el.style.gridTemplateColumns = `repeat(${this.sliceCount}, 1fr)`;
    el.replaceChildren(...Array.from({ length: this.sliceCount }, () => document.createElement("span")));
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
    this.currentLaneContent = new Array(this.sliceCount).fill(null);

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

  // Redrawn every animation frame: base waveform + sliceCount-1 fixed
  // dividers (splitting the display into the sliceCount buffer slots) + a
  // green highlight per lane whose alpha tracks that lane's actual envelope
  // gain right now - so during a crossfade 1-2 segments light up at once,
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
    const N = this.sliceCount;
    const segmentX = (i) => Math.round((i / N) * WAVEFORM_CANVAS_W);

    // Per-lane highlight: which segment (0..N-1) is currently assigned to that
    // lane, lit proportional to the lane's live envelope gain - read
    // straight off the real AudioParam. (We briefly switched this to a
    // self-computed prediction, suspecting the readback itself was
    // unreliable mid-ramp - it wasn't; the real bug was DecayRamp running
    // 2 steps past the end of the source's own buffer content, see
    // scheduleFadeLane(). Reading the real value is what surfaced that,
    // and is what actually verifies the fix.)
    //
    // The fill is positioned by contentIndex (which segment of the
    // RECORDING this lane is currently playing), not by lane number - so
    // the debug numbers underneath must be indexed the same way. Indexing
    // them by lane instead (as before) matched the color only when
    // shuffle is off (contentIndex === lane then); with shuffle on, the
    // number under a given segment could belong to a totally different
    // lane than the one whose gain is actually painting that quarter.
    const gainByContent = new Array(N).fill(0);
    for (let lane = 0; lane < N; lane++) {
      const contentIndex = this.currentLaneContent[lane];
      const envGain = this.originalEnvGains[lane];
      const gain = envGain ? envGain.gain.value : 0;

      if (contentIndex == null) continue;
      gainByContent[contentIndex] = Math.max(gainByContent[contentIndex], gain);

      if (gain <= 0.01) continue;

      const x0 = segmentX(contentIndex);
      const x1 = segmentX(contentIndex + 1);
      ctx2d.fillStyle = `rgba(62, 207, 110, ${(0.12 + 0.5 * gain).toFixed(3)})`;
      ctx2d.fillRect(x0, 0, Math.max(1, x1 - x0), WAVEFORM_CANVAS_H);
    }

    if (this.els.gainDebug) {
      const spans = this.els.gainDebug.children;
      for (let i = 0; i < N && i < spans.length; i++) {
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

    // Exactly N-1 vertical dividers, splitting the display into N equal parts.
    ctx2d.strokeStyle = "rgba(62, 207, 110, 0.55)";
    ctx2d.lineWidth = 1;
    ctx2d.beginPath();
    for (let i = 1; i < N; i++) {
      const x = segmentX(i) + 0.5;
      ctx2d.moveTo(x, 0);
      ctx2d.lineTo(x, WAVEFORM_CANVAS_H);
    }
    ctx2d.stroke();
  }

  // -------------------------
  // TRIM TO EXACT DIVISION
  // -------------------------
  // splitIntoBuffers() below derives L=floor(2T/(N+1)), S=floor(L/2) - any
  // remainder gets silently dropped by those floors. Trimming the recording
  // to a multiple of 2*(N+1) samples (10 for 4 slices, 18 for 8) first makes
  // both divisions land on exact integers, so there's no rounding remainder
  // at all (already sub-millisecond in practice, but this removes it
  // outright for the cost of at most 17 samples, <0.4ms, off the very end).
  trimToExactDivision(buffer, N) {
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
  // SPLIT INTO N BUFFERS (50% overlap)
  // -------------------------
  // N grains of length L = 2T/(N+1), each starting S = L/2 after the
  // previous one - so they tile the whole take with 50% overlap, and the
  // last one ends exactly at T. 8 slices = same rule, grains half as long.
  splitIntoBuffers(audioBuffer, N) {
    const ctx = sharedCtx;
    const T = audioBuffer.length;

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
    this.macroCounter = this.cycleSteps() - 1; // next tick wraps to step 0

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
      this.macroCounter = this.cycleSteps() - 1;
      this.nextTick = now + MIN_SCHEDULING_GAP;
      return;
    }

    const N = this.sliceCount;
    const cycle = this.cycleSteps();

    while (this.nextTick < now + SCHEDULER_LOOKAHEAD) {
      const scheduledTime = this.nextTick;
      this.nextTick += this.step16;

      if (scheduledTime < now) {
        this.nextTick = Math.max(this.nextTick, now + this.step16);
      }

      this.macroCounter++;
      if (this.macroCounter >= cycle) {
        this.macroCounter = 0;
      }

      if (this.macroCounter === 0) {
        if (this.shuffleEnabled) {
          this.shuffleOrder();
        } else {
          this.bufferOrder = Array.from({ length: N }, (_, i) => i);
        }
      }

      const triggerTime = Math.max(scheduledTime, now + MIN_SCHEDULING_GAP);

      // Lane k starts (grain + fade-in) on step 4k...
      if (this.macroCounter % 4 === 0) {
        const lane = this.macroCounter / 4;
        this.currentLaneContent[lane] = this.bufferOrder[lane];
        this.playIndex(this.bufferOrder[lane], lane, triggerTime);
        this.playIndexSlow(this.bufferOrder[lane], lane, triggerTime);
        this.scheduleFadeLane(lane, 1, triggerTime);
      }

      // ...and fades out 6 steps later, on step 4k+6 (wrapping around the
      // cycle - the last lane's fade-out lands on step 2 of the next one).
      // For 4 slices this is exactly the original fixed schedule:
      // fade-outs on 2 (lane 3), 6 (lane 0), 10 (lane 1), 14 (lane 2).
      const sinceFadeOut = (this.macroCounter - 6 + cycle) % cycle;
      if (sinceFadeOut % 4 === 0) {
        this.scheduleFadeLane(sinceFadeOut / 4, 0, triggerTime);
      }
    }
  }

  // One full pass over all grains: 4 steps per grain (16 for 4 slices, as
  // the step16 name comes from; 32 for 8).
  cycleSteps() {
    return this.sliceCount * 4;
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
    src.rateFactor = 1;

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
    src.rateFactor = 0.5;

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
// SEND FX: DELAY + REVERB
// -------------------------
// playersBus -> delaySendGain ("Send in") -> DelayNode -> masterMix, with a
// feedback loop through a fixed 80Hz rumble cut and the FILTER knob's tilt
// pair. playersBus -> reverbSendGain ("Send in") -> Dattorro plate (wet
// only, dry = 0 - it's a send, the dry signal already reaches masterMix
// straight from playersBus) -> masterMix.
//
// The AudioContext only exists after the first Rec press, so the controls
// below keep their own state in fxState and buildSendFx() reads it when the
// graph is created; before that, moving them just updates the readouts.
const SMOOTH_TIME = 0.02;
const DELAY_MAX_TIME = 2;      // also the longest gap between two taps that still counts
const DELAY_FEEDBACK = 0.5;    // fixed - only TAP and FILTER are on the panel
const TAP_HISTORY = 4;         // average over the last 4 taps (3 intervals)
const REVERB_WET = 0.6;

const fxState = {
  delaySend: 0,
  delayTime: 0.375,
  delayFilter: 0.5,
  reverbSend: 0,
  reverbDecay: 0.9,
  reverbDamp: 0.3
};

let delaySendGain = null;
let delayNode = null;
let delayTiltLowpass = null;
let delayTiltHighpass = null;
let reverbSendGain = null;
let reverbNode = null;

// Feedback-loop tilt filter - same one SendS/NEWRACK use for the delay's
// tone control. Knob centered (0.5) = both filters parked at their
// transparent extreme; left sweeps a lowpass down (darkens each repeat),
// right sweeps a highpass up (thins each repeat).
const TILT_Q = 0.2;
const TILT_LP_OFF = 20000, TILT_LP_DARK = 400;
const TILT_HP_OFF = 20, TILT_HP_BRIGHT = 2600;

function tiltFilterFreqs(knob) {
  if (knob <= 0.5) {
    const t = (0.5 - knob) / 0.5;
    return { lowpassFreq: TILT_LP_OFF * Math.pow(TILT_LP_DARK / TILT_LP_OFF, t), highpassFreq: TILT_HP_OFF };
  }
  const t = (knob - 0.5) / 0.5;
  return { lowpassFreq: TILT_LP_OFF, highpassFreq: TILT_HP_OFF * Math.pow(TILT_HP_BRIGHT / TILT_HP_OFF, t) };
}

function formatHz(f) {
  return f >= 1000 ? `${(f / 1000).toFixed(1)}k` : `${Math.round(f)}`;
}

function formatTilt(knob) {
  if (Math.abs(knob - 0.5) < 0.03) return "—";
  const { lowpassFreq, highpassFreq } = tiltFilterFreqs(knob);
  return knob < 0.5 ? `LP ${formatHz(lowpassFreq)}` : `HP ${formatHz(highpassFreq)}`;
}

// setTargetAtTime when the param is already live (no zipper noise while
// dragging), plain .value assignment while building the graph.
function setParam(param, value, ramp) {
  if (ramp) param.setTargetAtTime(value, sharedCtx.currentTime, SMOOTH_TIME);
  else param.value = value;
}

function applyDelayFilter(ramp) {
  if (!delayTiltLowpass) return;
  const { lowpassFreq, highpassFreq } = tiltFilterFreqs(fxState.delayFilter);
  setParam(delayTiltLowpass.frequency, lowpassFreq, ramp);
  setParam(delayTiltHighpass.frequency, highpassFreq, ramp);
}

// Loads a worklet module from a wrapper function (see reverb-worklet.js for
// why the processors live inside functions instead of their own module
// files). data: URL first - the only form Chrome accepts when the page is
// opened from file:// - then blob: as a fallback for browsers that refuse a
// data: module (served over http(s), blob: is the widely supported one).
// Memoized per function, so both callers can ask without double-loading.
const workletLoads = new Map();

function loadWorkletFunction(ctx, fn) {
  if (!workletLoads.has(fn)) {
    const source = `(${fn.toString()})();`;
    const dataUrl = "data:application/javascript;charset=utf-8," + encodeURIComponent(source);
    workletLoads.set(fn, ctx.audioWorklet.addModule(dataUrl).catch(() => {
      const blobUrl = URL.createObjectURL(new Blob([source], { type: "application/javascript" }));
      return ctx.audioWorklet.addModule(blobUrl);
    }));
  }
  return workletLoads.get(fn);
}

function buildSendFx(ctx) {
  // Delay
  delaySendGain = ctx.createGain();
  delaySendGain.gain.value = fxState.delaySend;

  delayNode = ctx.createDelay(DELAY_MAX_TIME);
  delayNode.delayTime.value = fxState.delayTime;

  const feedback = ctx.createGain();
  feedback.gain.value = DELAY_FEEDBACK;

  const fixedHipass = ctx.createBiquadFilter();
  fixedHipass.type = "highpass";
  fixedHipass.frequency.value = 80;
  fixedHipass.Q.value = Math.SQRT1_2; // flat passband, so loop gain stays DELAY_FEEDBACK

  delayTiltHighpass = ctx.createBiquadFilter();
  delayTiltHighpass.type = "highpass";
  delayTiltHighpass.Q.value = TILT_Q;
  delayTiltLowpass = ctx.createBiquadFilter();
  delayTiltLowpass.type = "lowpass";
  delayTiltLowpass.Q.value = TILT_Q;
  applyDelayFilter(false);

  playersBus.connect(delaySendGain);
  delaySendGain.connect(delayNode);
  delayNode.connect(feedback);
  feedback.connect(fixedHipass).connect(delayTiltHighpass).connect(delayTiltLowpass).connect(delayNode);
  delayNode.connect(masterMix);

  // Reverb - the worklet module loads asynchronously; until it's ready the
  // reverb send simply isn't connected to anything (silent), the rest of
  // the app runs normally.
  reverbSendGain = ctx.createGain();
  reverbSendGain.gain.value = fxState.reverbSend;
  playersBus.connect(reverbSendGain);

  loadWorkletFunction(ctx, dattorroReverbWorklet).then(() => {
    reverbNode = new AudioWorkletNode(ctx, "DattorroReverb", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2]
    });
    reverbNode.parameters.get("dry").value = 0;
    reverbNode.parameters.get("wet").value = REVERB_WET;
    reverbNode.parameters.get("decay").value = fxState.reverbDecay;
    reverbNode.parameters.get("damping").value = fxState.reverbDamp;

    reverbSendGain.connect(reverbNode);
    reverbNode.connect(masterMix);
  }).catch((err) => {
    console.error("Reverb worklet failed to load:", err);
  });
}

function bindSendFader(inputId, valueId, stateKey, getGainNode) {
  const input = document.getElementById(inputId);
  const valueEl = document.getElementById(valueId);
  input.addEventListener("input", () => {
    const v = parseFloat(input.value);
    fxState[stateKey] = v;
    valueEl.textContent = `${Math.round(v * 100)}%`;
    const node = getGainNode();
    if (node) setParam(node.gain, v, true);
  });
}

bindSendFader("delaySend", "delaySendValue", "delaySend", () => delaySendGain);
bindSendFader("reverbSend", "reverbSendValue", "reverbSend", () => reverbSendGain);

// TAP: delay time = average interval of the last few taps. A gap longer
// than DELAY_MAX_TIME starts a fresh tap sequence instead of averaging in a
// pause. pointerdown, not click - click fires on release, which would put
// the tap timing at the mercy of how long the finger stays down.
const delayTimeValueEl = document.getElementById("delayTimeValue");
let tapTimes = [];

function setDelayTime(seconds) {
  fxState.delayTime = Math.min(DELAY_MAX_TIME, Math.max(0.01, seconds));
  delayTimeValueEl.textContent = `${Math.round(fxState.delayTime * 1000)} ms`;
  if (delayNode) delayNode.delayTime.setTargetAtTime(fxState.delayTime, sharedCtx.currentTime, 0.05);
}

document.getElementById("delayTap").addEventListener("pointerdown", () => {
  const t = performance.now() / 1000;
  if (tapTimes.length && t - tapTimes[tapTimes.length - 1] > DELAY_MAX_TIME) tapTimes = [];
  tapTimes.push(t);
  if (tapTimes.length > TAP_HISTORY) tapTimes.shift();
  if (tapTimes.length < 2) return;
  setDelayTime((tapTimes[tapTimes.length - 1] - tapTimes[0]) / (tapTimes.length - 1));
});

setDelayTime(fxState.delayTime);

makeKnob(document.getElementById("delayFilterKnob"), {
  min: 0,
  max: 1,
  value: fxState.delayFilter,
  format: formatTilt,
  onChange: (v) => {
    fxState.delayFilter = v;
    applyDelayFilter(true);
  }
});

makeKnob(document.getElementById("reverbDecayKnob"), {
  min: 0,
  max: 0.95,
  value: fxState.reverbDecay,
  format: (v) => `${Math.round(v * 100)}%`,
  onChange: (v) => {
    fxState.reverbDecay = v;
    if (reverbNode) setParam(reverbNode.parameters.get("decay"), v, true);
  }
});

makeKnob(document.getElementById("reverbDampKnob"), {
  min: 0,
  max: 1,
  value: fxState.reverbDamp,
  format: (v) => `${Math.round(v * 100)}%`,
  onChange: (v) => {
    fxState.reverbDamp = v;
    if (reverbNode) setParam(reverbNode.parameters.get("damping"), v, true);
  }
});

// -------------------------
// LOOP RECORDER (WAV, up to 8 min)
// -------------------------
// Records masterMix - exactly what's heard: all players + delay + reverb -
// through the LoopRecorder worklet (recorder-worklet.js), which hands back
// ready 16-bit stereo blocks. On stop they're wrapped in a WAV header and
// downloaded as <date>_<time>_loop.wav (time = when recording started).
const LOOP_REC_MAX_SEC = 8 * 60;

const loopRec = {
  btn: document.getElementById("loopRecBtn"),
  led: document.getElementById("loopRecLed"),
  timeEl: document.getElementById("loopRecTime"),
  node: null,
  chunks: [],
  state: "idle", // idle | starting | recording | saving
  startedAt: 0,
  startDate: null,
  maxTimer: null
};

function formatClock(sec) {
  const s = Math.floor(sec);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function setLoopRecUI(state) {
  loopRec.state = state;
  loopRec.led.classList.toggle("on", state === "recording");
  loopRec.led.classList.toggle("busy", state === "starting" || state === "saving");
  loopRec.btn.textContent = state === "recording" ? "Stop" : state === "idle" ? "Rec" : "...";
  loopRec.btn.disabled = state === "starting" || state === "saving";
  if (state === "idle") loopRec.timeEl.textContent = `00:00 / ${formatClock(LOOP_REC_MAX_SEC)}`;
}

function updateLoopRecTime() {
  if (loopRec.state !== "recording") return;
  const elapsed = Math.min(LOOP_REC_MAX_SEC, (performance.now() - loopRec.startedAt) / 1000);
  loopRec.timeEl.textContent = `${formatClock(elapsed)} / ${formatClock(LOOP_REC_MAX_SEC)}`;
}

async function startLoopRec() {
  setLoopRecUI("starting");
  try {
    const ctx = getSharedContext();
    if (ctx.state === "suspended") await ctx.resume();

    if (!loopRec.node) {
      await loadWorkletFunction(ctx, loopRecorderWorklet);
      loopRec.node = new AudioWorkletNode(ctx, "LoopRecorder", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 2,
        channelCountMode: "explicit"
      });
      loopRec.node.port.onmessage = (e) => {
        if (e.data === "done") finishLoopRec();
        else loopRec.chunks.push(e.data);
      };
      // The node only needs to be pulled by the graph, not heard: route its
      // (silent) output to the destination through a 0-gain node.
      const sink = ctx.createGain();
      sink.gain.value = 0;
      masterMix.connect(loopRec.node);
      loopRec.node.connect(sink);
      sink.connect(ctx.destination);
    }

    loopRec.chunks = [];
    loopRec.startDate = new Date();
    loopRec.startedAt = performance.now();
    loopRec.node.port.postMessage("start");
    setLoopRecUI("recording");
    loopRec.maxTimer = setTimeout(stopLoopRec, LOOP_REC_MAX_SEC * 1000);
  } catch (err) {
    console.error("Loop recorder failed to start:", err);
    setLoopRecUI("idle");
  }
}

function stopLoopRec() {
  if (loopRec.state !== "recording") return;
  clearTimeout(loopRec.maxTimer);
  updateLoopRecTime();
  setLoopRecUI("saving");
  loopRec.node.port.postMessage("stop"); // worklet flushes, then replies "done"
}

function finishLoopRec() {
  const sampleRate = sharedCtx.sampleRate;
  const dataBytes = loopRec.chunks.reduce((sum, c) => sum + c.byteLength, 0);

  // 44-byte canonical PCM WAV header: 16-bit, 2 channels.
  const header = new DataView(new ArrayBuffer(44));
  const writeStr = (offset, str) => { for (let i = 0; i < str.length; i++) header.setUint8(offset + i, str.charCodeAt(i)); };
  writeStr(0, "RIFF");
  header.setUint32(4, 36 + dataBytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  header.setUint32(16, 16, true);              // fmt chunk size
  header.setUint16(20, 1, true);               // PCM
  header.setUint16(22, 2, true);               // channels
  header.setUint32(24, sampleRate, true);
  header.setUint32(28, sampleRate * 4, true);  // byte rate = rate * channels * 2 bytes
  header.setUint16(32, 4, true);               // block align
  header.setUint16(34, 16, true);              // bits per sample
  writeStr(36, "data");
  header.setUint32(40, dataBytes, true);

  const blob = new Blob([header, ...loopRec.chunks], { type: "audio/wav" });
  loopRec.chunks = [];

  const d = loopRec.startDate;
  const pad = (n) => String(n).padStart(2, "0");
  const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_` +
    `${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}_loop.wav`;

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);

  setLoopRecUI("idle");
}

loopRec.btn.addEventListener("click", () => {
  if (loopRec.state === "idle") startLoopRec();
  else if (loopRec.state === "recording") stopLoopRec();
});

setLoopRecUI("idle");

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
  updateLoopRecTime();
  requestAnimationFrame(rafLoop);
}

requestAnimationFrame(rafLoop);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && sharedCtx) {
    players.forEach((p) => {
      if (p.isPlaying) {
        p.resetGains(sharedCtx.currentTime);
        p.macroCounter = p.cycleSteps() - 1;
        p.nextTick = sharedCtx.currentTime + MIN_SCHEDULING_GAP;
      }
    });
  }
});
