# Audio regression test: real amplitude-discontinuity detector

A real end-to-end test that runs the **actual, unmodified** webloooper app
in headless Chrome, feeds it a synthetic signal through a faked microphone,
records/plays it back (with Shuffle on), captures the **real** mixed audio
output, and scans it for amplitude discontinuities (clicks/dropouts). It
does not reimplement or approximate the scheduling/gain logic — nothing
here can drift from what's actually shipped, because it's exercising the
shipped code directly.

## Why this exists

During a debugging session, several fixes were made to the granular
playback engine's envelope scheduling. Reasoning about the fix "on paper"
(and even simulating the AudioParam automation timeline in isolation) had
already produced one wrong diagnosis earlier in that session. This test
was built to stop guessing and get a real, falsifiable answer instead:
record a loop with Shuffle on, capture what's actually produced, and look
for genuine amplitude jumps.

## How it works

1. **`make_test_wav.js`** generates `test-signal.wav`: white noise plus a
   220Hz **sawtooth** (deliberately *not* a sine wave — a pure tone can
   produce beating/interference patterns that look like amplitude
   variation but aren't a real discontinuity; noise + a non-sine periodic
   component gives every sample enough independent information that a
   genuine hard cut is unambiguous).
2. **`server.js`** serves the app directory over plain HTTP (`file://`
   works too in Chrome, but a local server avoids any secure-context
   edge cases with `getUserMedia`).
3. **`run_test.js`** launches Chrome/Edge with
   `--use-fake-device-for-media-stream --use-file-for-fake-audio-capture=<wav>
   --use-fake-ui-for-media-stream` - the browser thinks that WAV file *is*
   the microphone, and auto-grants the permission prompt. It then:
   - Injects (via `page.evaluateOnNewDocument`, so it's in place before
     `main.js` runs) a monkey-patch on `AudioNode.prototype.connect` that
     detects the one call in the app that connects directly to
     `ctx.destination` (that's `masterMix.connect(sharedCtx.destination)`)
     and taps it with a `ScriptProcessorNode`, capturing every raw
     Float32 output block into `window.__capturedChunks`. This is the
     **real, final mixed signal** - not a re-derivation of it.
   - Clicks Shuffle on, clicks Rec, waits ~3.5s, clicks Stop (letting the
     app's own record → decode → split → startPlayback pipeline run
     untouched), then lets it play for ~20s while capturing.
   - Pulls the captured samples back out of the page (base64-encoded in
     chunks - a naive single `String.fromCharCode(...bigArray)` blows the
     JS engine's argument-count limit on anything more than a couple
     seconds of audio) and writes them to `captured-output.f32` (raw
     32-bit float PCM, mono, 44100Hz).
4. **`analyze.js`** loads that raw capture and runs two independent
   detectors:
   - **Dropout blips**: short-window (~5.8ms) RMS envelope; flags any
     spot where RMS falls below 10% of the capture's mean RMS and
     recovers above 50% of it again within 20ms. Real fades in this app
     are hundreds of ms (`DecayRamp`/`Ramp`), so a full silence-and-back
     cycle faster than 20ms cannot be an intentional fade - it's a
     genuine dropout.
   - **Extreme single-sample jumps**: per 2048-sample window, flags any
     sample-to-sample delta more than 8 local standard deviations above
     that window's mean delta (and >0.3 in absolute terms) - a real hard
     cut standing out from noise's own normal roughness, not just noise
     being noisy.

## Running it

```bash
cd test/audiotest
npm install
npm run generate   # writes test-signal.wav (only needed once, or after editing make_test_wav.js)
npm test           # runs the app (default target: ../.. = the webloooper folder) for ~25s, writes captured-output.f32
npm run analyze    # prints the discontinuity report
```

`run_test.js` takes the app directory as its one argument (`npm test`
already passes `../..`) - point it at any folder with the same
`index.html`/`main.js` layout to test a different copy/branch.

It looks for Chrome or Edge at their default Windows install paths
(see `CHROME_PATHS` in `run_test.js`); edit that list if yours lives
elsewhere.

## Validating the detector itself

A detector that never flags anything is only useful if it's also capable
of flagging something real. Before trusting a clean run, this was checked
by intentionally reverting the exact fix being verified (routing
`playIndex`/`playIndexSlow`'s source connection back to
`*EnvGains[contentIndex]` instead of `*EnvGains[laneIndex]` - see main.js)
in a throwaway copy and re-running the same test against it.

## Results (recorded here for reference)

Run against the app as of the commit that added this test, Shuffle
enabled throughout, ~25.45s of captured playback:

**Fixed (current) code:**
```
mean RMS: 0.3110
fast dropout blips (<20ms): 0
extreme single-sample jump outliers: 0
```

**Intentionally-reverted code** (source connected to
`*EnvGains[contentIndex]` instead of `*EnvGains[laneIndex]` - the bug
that made Shuffle route audio through a gain node whose automation
belonged to a completely different, unrelated trigger):
```
mean RMS: 0.1763          (noticeably quieter - audio often routed through a closed gain node)
fast dropout blips (<20ms): 8
extreme single-sample jump outliers: 0
  t=4.560s   duration=20.3ms
  t=5.300s   duration=14.5ms
  t=16.440s  duration=20.3ms
  t=17.180s  duration=11.6ms
  t=17.920s  duration=17.4ms
  t=20.892s  duration=20.3ms
  t=21.638s  duration=17.4ms
  t=23.124s  duration=20.3ms
```

The detector reliably catches the known bug and reports clean on the
fixed code, over a real ~25s Shuffle-enabled playback session using the
actual shipped app.
