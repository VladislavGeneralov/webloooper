// Synthetic test signal: white noise + a non-sine periodic component
// (sawtooth), deliberately avoiding a pure sine so that any amplitude
// discontinuity shows up as a genuine sample-to-sample jump rather than
// getting confused with beating/interference between coherent tones.
const fs = require("fs");

const sampleRate = 44100;
const durationSec = 4; // fake-mic loops this; the app only records MAX_DURATION=10s anyway
const numSamples = sampleRate * durationSec;

const sawFreq = 220; // Hz, non-sine periodic component
const noiseAmp = 0.5;
const sawAmp = 0.4;

const data = new Float32Array(numSamples);
for (let i = 0; i < numSamples; i++) {
  const t = i / sampleRate;
  const noise = (Math.random() * 2 - 1) * noiseAmp;
  const phase = (t * sawFreq) % 1;
  const saw = (phase * 2 - 1) * sawAmp; // sawtooth, -1..1
  let v = noise + saw;
  if (v > 1) v = 1;
  if (v < -1) v = -1;
  data[i] = v;
}

function writeWav(filename, floatData, sampleRate) {
  const numChannels = 1;
  const bytesPerSample = 2;
  const blockAlign = numChannels * bytesPerSample;
  const byteRate = sampleRate * blockAlign;
  const dataSize = floatData.length * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bytesPerSample * 8, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < floatData.length; i++) {
    let s = Math.max(-1, Math.min(1, floatData[i]));
    s = s < 0 ? s * 32768 : s * 32767;
    buffer.writeInt16LE(Math.round(s), offset);
    offset += 2;
  }

  fs.writeFileSync(filename, buffer);
}

writeWav(__dirname + "/test-signal.wav", data, sampleRate);
console.log("wrote test-signal.wav:", numSamples, "samples,", durationSec, "s");
