# Loooooper

A browser-based granular looper. Four independent players, each records a
short clip from the microphone, slices it into four overlapping grains, and
loops them back with fades, shuffle, reverse and an octave-down layer — all
in plain Web Audio, no build step, no dependencies.

Open `index.html` directly in a browser (Chrome/Edge recommended) to run it.

## What each player does

1. **Record** — press the round **Rec** button to grant mic access and start
   recording (up to 10s, or press it again — it becomes **Stop** while
   recording — to stop earlier). The REC LED lights red while recording,
   amber while the clip is being decoded/sliced, and goes dark once playback
   starts.
2. **Slice** — the recorded clip is split into 4 grains with 50% overlap.
3. **Loop** — the 4 grains are triggered in a 16-step round-robin cycle with
   trapezoid fade-in/hold/fade-out envelopes (anchored `setValueAtTime` +
   `linearRampToValueAtTime`, so gain is always exactly 0 at the moment a new
   grain starts — no clicks/cuts at the crossfade points).
4. **Waveform + length** — the recorded clip's waveform and duration are
   shown above the controls.

## Controls per player

- **Rec / Stop** — one round transport button; its label swaps between
  `Rec` → `Stop` → `...` (processing) → `Rec`.
- **Orig / Low** — two independent vertical faders: volume of the
  original-pitch layer and volume of the octave-down copy layer. `Low` at 0
  means the octave-down layer is silent (its own layer + envelope always
  runs, the fader is what controls whether you hear it).
- **Shuffle** (round toggle, lights green when on) — randomizes grain
  playback order each cycle instead of the fixed 0-1-2-3 sequence.
- **Reverse** (rotary knob, drag up/down to turn, double-click resets to
  0.5) — probability that any given grain plays backward instead of forward.

All 4 players share one `AudioContext` and mix into a single master bus, so
they can be layered/performed together.

## Files

- `index.html` — markup + styling (rack-module skin: brushed-metal panels,
  flat rectangular buttons, mixer-style rotated vertical faders, a rotary
  knob, recessed waveform display — visual language adapted from the
  NEWRACK project).
- `main.js` — all the audio engine + UI logic (`Player` class + a small
  `makeKnob` widget), no dependencies.

## Design notes

- Original and octave-down layers each have their own set of 4 per-lane
  envelope gain nodes (identical fade timing, scheduled together) feeding
  into their own volume gain — so the two faders are true independent volume
  controls, not just a balance knob.
- The envelope engine anchors every fade with `setValueAtTime` right before
  `linearRampToValueAtTime`. Without that anchor, Web Audio's automation
  timeline interpolates from whatever the *previous* scheduled event was,
  so a fade-in scheduled ahead of time can start rising before its intended
  trigger time — this was verified with a small standalone simulation of the
  AudioParam automation spec before/after the fix.
- LED-style state indicators (REC light, shuffle toggle) are flat color
  swaps only — no glow/box-shadow halo, consistent with the borrowed rack
  design language.
