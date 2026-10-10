// Loop recorder: captures whatever is connected to it (masterMix - the final
// mix, dry + delay + reverb) as 16-bit stereo PCM, converted and batched
// inside the audio thread so the main thread only receives one ready-to-save
// Int16 block per CHUNK_FRAMES instead of a message every 128 frames.
//
// Same wrapper-function convention as reverb-worklet.js (loaded by main.js
// via loadWorkletFunction, so it runs straight from file:// too).
//
// Messages in:  "start", "stop"
// Messages out: Int16Array (interleaved L/R, transferred) while recording,
//               then "done" once the partial last block has been flushed.
function loopRecorderWorklet() {
  const CHUNK_FRAMES = 16384;

  class LoopRecorder extends AudioWorkletProcessor {
    constructor() {
      super();
      this.recording = false;
      this.newChunk();
      this.port.onmessage = (e) => {
        if (e.data === "start") {
          this.newChunk();
          this.recording = true;
        } else if (e.data === "stop") {
          this.recording = false;
          this.flush();
          this.port.postMessage("done");
        }
      };
    }

    newChunk() {
      this.chunk = new Int16Array(CHUNK_FRAMES * 2);
      this.frames = 0;
    }

    flush() {
      if (this.frames === 0) return;
      const out = this.chunk.slice(0, this.frames * 2);
      this.port.postMessage(out, [out.buffer]);
      this.newChunk();
    }

    process(inputs) {
      if (!this.recording) return true;

      // Nothing connected / silent input arrives as 0 channels - still
      // write the frames (as silence) so the file's length matches the
      // time actually recorded.
      const input = inputs[0];
      const left = input[0];
      const right = input[1] || input[0];
      const n = left ? left.length : 128;

      for (let i = 0; i < n; i++) {
        const l = left ? Math.max(-1, Math.min(1, left[i])) : 0;
        const r = right ? Math.max(-1, Math.min(1, right[i])) : 0;
        this.chunk[this.frames * 2] = l < 0 ? l * 0x8000 : l * 0x7fff;
        this.chunk[this.frames * 2 + 1] = r < 0 ? r * 0x8000 : r * 0x7fff;
        this.frames++;
        if (this.frames === CHUNK_FRAMES) this.flush();
      }
      return true;
    }
  }

  registerProcessor("LoopRecorder", LoopRecorder);
}
