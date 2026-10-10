# Loooooper

A browser-based granular looper. Four independent players, each records a
short clip from the microphone, slices it into 4 or 8 overlapping grains, and
loops them back with fades, shuffle, reverse and an octave-down layer — all
in plain Web Audio, no build step, no dependencies.

Open `index.html` directly in a browser (Chrome/Edge recommended) to run it.

## What each player does

1. **Record** — press the round **Rec** button to grant mic access and start
   recording (up to 10s, or press it again — it becomes **Stop** while
   recording — to stop earlier). The REC LED lights red while recording,
   amber while the clip is being decoded/sliced, and goes dark once playback
   starts.
2. **Slice** — the recorded clip is split into 4 or 8 grains (the **4/8**
   switch) with 50% overlap: N grains of length 2T/(N+1), each starting
   half a grain after the previous one.
3. **Loop** — the N grains are triggered in a 4N-step round-robin cycle
   (16 steps for 4 grains, 32 for 8) with
   trapezoid fade-in/hold/fade-out envelopes (anchored `setValueAtTime` +
   `linearRampToValueAtTime`, so gain is always exactly 0 at the moment a new
   grain starts — no clicks/cuts at the crossfade points).
4. **Waveform + length** — the recorded clip's waveform and duration are
   shown above the controls.

## Controls per player

- **4/8** (slide switch at the bottom of the left column, level with the
  Orig/Low fader labels) — how many grains the take is
  cut into. Flipping it while a loop plays re-slices the same recording:
  the player's output fades out over 30ms, the take is re-cut and the loop
  restarts from the top with its normal fade-in (no click). Flipped before
  or during recording, it just applies to the next take.
- **Rec / Stop** — one round transport button; its label swaps between
  `Rec` → `Stop` → `...` (processing) → `Rec`. The input's left and right
  channels are summed (L+R) into one mono signal at unity gain, so a
  source on only one input (e.g. interface input 1) records at full level
  in the center; the same signal on both channels comes out +6dB.
- **Orig / Low** — two independent vertical faders: volume of the
  original-pitch layer and volume of the octave-down copy layer (gain 0–4x,
  Orig starts at the middle = 2x). `Low` at 0 means the octave-down layer
  is silent (its own layer + envelope always runs, the fader is what
  controls whether you hear it).
- **Shuffle** (round toggle, lights green when on) — randomizes grain
  playback order each cycle instead of the fixed 0-1-2-3 sequence.
- **Rev prob** (rotary knob, drag up/down to turn, double-click resets) —
  probability that any given grain plays backward instead of forward.
- **Pitch** (rotary knob above the Orig/Low faders, ±12 semitones,
  double-click resets to 0) —
  varispeed, like a tape: every grain plays faster/higher or slower/lower
  and the step clock runs at the same rate, so the slicing stays identical
  and the loop just plays through it faster or slower.

All 4 players share one `AudioContext` and mix into a single master bus, so
they can be layered/performed together.

## Send FX (under the players)

The sum of all 4 players goes to the master dry and, in parallel, to two
send effects, each with its own horizontal **Send in** fader:

- **Delay** — **Tap** sets the delay time (average of the last few taps,
  up to 2s; a longer pause starts a new tap sequence). **Filter** is a tilt
  filter inside the feedback loop: left = lowpass (darker repeats), right =
  highpass (thinner repeats), center = off. Feedback is fixed at 50%.
- **Reverb** — Dattorro plate (same processor as SendS/NEWRACK), **Decay**
  and **Damp** knobs.

Each block is as wide as two player columns: on a desktop wide enough for
4 players in a row they sit side by side, on a phone one under the other.

## WAV rec (bottom of the page)

Records the final mix (all players + delay + reverb, exactly what's heard)
for up to 8 minutes. **Rec** starts it, the counter shows elapsed / 8:00,
**Stop** (or reaching 8:00) saves it as `YYYY-MM-DD_HH-MM-SS_loop.wav`
(16-bit stereo, the time is when recording started).

The block also holds a horizontal stereo VU meter (L over R, green from the
left → yellow → red at the right end), metering the same final mix the same
way SCDJ's mixer meters do: per-frame peak ×1.4, small ~6px square LED
segments (as many as fit the bar's length).

## Phone layout

The page is sized to fit 390x664 CSS px (an iPhone 12–15 Safari viewport
with both toolbars) without scrolling; page scrolling is locked on purpose.
The per-lane gain readout under each waveform is hidden on phones.

## Files

- `index.html` — markup + styling (rack-module skin: brushed-metal panels,
  flat rectangular buttons, mixer-style rotated vertical faders, a rotary
  knob, recessed waveform display — visual language adapted from the
  NEWRACK project).
- `main.js` — all the audio engine + UI logic (`Player` class + a small
  `makeKnob` widget, send FX, WAV recorder), no dependencies.
- `reverb-worklet.js` — the Dattorro reverb AudioWorklet, wrapped in a
  function that `main.js` loads as a `data:` URL, so the app still runs
  straight from `file://` without a server.
- `recorder-worklet.js` — the WAV recorder's AudioWorklet (same loading
  trick): converts the mix to 16-bit stereo in the audio thread.

## Design notes

- Original and octave-down layers each have their own set of 8 per-lane
  envelope gain nodes (enough for either slice count, so the 4/8 switch
  never rebuilds the graph; identical fade timing, scheduled together) feeding
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
