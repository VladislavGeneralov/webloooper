const fs = require("fs");
const path = require("path");

const filePath = path.join(__dirname, "captured-output.f32");
const buf = fs.readFileSync(filePath);
const samples = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const sr = 44100;

console.log(`loaded ${samples.length} samples (${(samples.length / sr).toFixed(2)}s)`);

// --- 1) Short-window RMS envelope, to find real dropout/click blips
// distinct from the sawtooth's own natural -1..1 wrap jumps or noise's
// normal roughness. Window ~5.8ms, 50% overlap.
const win = 256;
const hop = 128;
const envelope = [];
for (let start = 0; start + win <= samples.length; start += hop) {
  let sumSq = 0;
  for (let i = start; i < start + win; i++) sumSq += samples[i] * samples[i];
  envelope.push({ t: start / sr, rms: Math.sqrt(sumSq / win) });
}

const rmsValues = envelope.map((e) => e.rms);
const meanRms = rmsValues.reduce((a, b) => a + b, 0) / rmsValues.length;
console.log(`mean RMS across whole capture: ${meanRms.toFixed(4)}`);

// Flag any dropout: RMS falls below 10% of the meanRms then recovers
// above 50% of meanRms within <20ms (far shorter than our shortest real
// fade, DecayRamp, which for this test recording is on the order of
// hundreds of ms).
const dropoutMaxMs = 20;
const dropoutMaxWindows = Math.ceil((dropoutMaxMs / 1000) * sr / hop);
const lowThresh = meanRms * 0.10;
const recoverThresh = meanRms * 0.5;

const dropouts = [];
for (let i = 0; i < envelope.length; i++) {
  if (envelope[i].rms < lowThresh) {
    // find how far until it recovers
    let j = i + 1;
    while (j < envelope.length && j - i <= dropoutMaxWindows && envelope[j].rms < recoverThresh) j++;
    if (j < envelope.length && j - i <= dropoutMaxWindows && envelope[j].rms >= recoverThresh) {
      dropouts.push({ startT: envelope[i].t, durationMs: ((j - i) * hop / sr * 1000).toFixed(1) });
      i = j; // skip past this one
    }
  }
}

console.log(`\nfast dropout blips (<${dropoutMaxMs}ms, RMS<10% then recovers): ${dropouts.length}`);
dropouts.slice(0, 20).forEach((d) => console.log(`  t=${d.startT.toFixed(3)}s  duration=${d.durationMs}ms`));

// --- 2) Outlier single-sample jumps: |x[n]-x[n-1]| far larger than what
// the LOCAL signal statistics would predict (z-score against a local
// rolling window of deltas), which is what a genuine hard-cut/click looks
// like on top of noise (as opposed to noise's own uniformly-distributed
// sample-to-sample jumpiness).
const deltaWin = 2048;
let outlierCount = 0;
const outlierSamples = [];
for (let start = 0; start + deltaWin <= samples.length; start += deltaWin) {
  const deltas = [];
  for (let i = start + 1; i < start + deltaWin; i++) deltas.push(Math.abs(samples[i] - samples[i - 1]));
  const meanD = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const varD = deltas.reduce((a, b) => a + (b - meanD) * (b - meanD), 0) / deltas.length;
  const stdD = Math.sqrt(varD);
  const threshold = meanD + 8 * stdD; // very conservative - only extreme outliers
  for (let i = 0; i < deltas.length; i++) {
    if (deltas[i] > threshold && deltas[i] > 0.3) { // also require an absolute floor (0.3 out of [-1,1] range)
      outlierCount++;
      if (outlierSamples.length < 30) {
        outlierSamples.push({ t: (start + 1 + i) / sr, delta: deltas[i].toFixed(3) });
      }
    }
  }
}

console.log(`\nextreme single-sample jump outliers (>8 local-sigma AND >0.3 abs): ${outlierCount}`);
outlierSamples.forEach((o) => console.log(`  t=${o.t.toFixed(4)}s  |delta|=${o.delta}`));

console.log("\n=== SUMMARY ===");
console.log(dropouts.length === 0 && outlierCount === 0
  ? "No dropout blips or extreme jump outliers detected - consistent with clean fades under shuffle."
  : "Found candidate artifacts above - needs listening/inspection to confirm they're real clicks vs. false positives.");
