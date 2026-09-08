// Real end-to-end test: runs the ACTUAL webloooper app (unmodified) in
// headless Chrome with a fake microphone fed from our synthetic
// noise+sawtooth WAV file, enables Shuffle, records, lets it play back for
// a while, and captures the REAL summed output tapped straight off
// masterMix (before ctx.destination) - no reimplementation of the
// scheduling/gain logic, so nothing here can drift from what's actually
// shipped.
const puppeteer = require("puppeteer-core");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const APP_DIR = process.argv[2];
const WAV_PATH = path.resolve(__dirname, "test-signal.wav");
const PORT = 8791;
const CHROME_PATHS = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];

function findChrome() {
  for (const p of CHROME_PATHS) if (fs.existsSync(p)) return p;
  throw new Error("no chrome/edge found");
}

async function main() {
  const server = spawn("node", [path.join(__dirname, "server.js"), APP_DIR, String(PORT)], { stdio: "inherit" });
  await new Promise((r) => setTimeout(r, 800));

  const executablePath = findChrome();
  const browser = await puppeteer.launch({
    executablePath,
    headless: "new",
    args: [
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${WAV_PATH}`,
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
      "--no-sandbox",
    ],
  });

  try {
    const page = await browser.newPage();
    page.on("console", (msg) => console.log("[page]", msg.text()));
    page.on("pageerror", (err) => console.log("[pageerror]", err.message));

    // Installed BEFORE main.js runs: capture whatever connects directly to
    // ctx.destination (that's masterMix.connect(sharedCtx.destination) in
    // main.js) via a ScriptProcessorNode tap, storing raw Float32 samples.
    await page.evaluateOnNewDocument(() => {
      window.__capturedChunks = [];
      window.__captureInstalled = false;

      const origConnect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (...args) {
        const dest = args[0];
        if (!window.__captureInstalled && dest && this.context && dest === this.context.destination) {
          window.__captureInstalled = true; // set FIRST - the two connect() calls below re-enter this same patched function
          const ctx = this.context;
          const processor = ctx.createScriptProcessor(4096, 1, 1);
          this.connect(processor);
          processor.connect(ctx.destination);
          processor.onaudioprocess = (e) => {
            window.__capturedChunks.push(Float32Array.from(e.inputBuffer.getChannelData(0)));
          };
          window.__scriptProcessorRef = processor;
        }
        return origConnect.apply(this, args);
      };
    });

    await page.goto(`http://localhost:${PORT}/`, { waitUntil: "load" });

    // Enable shuffle on player 1 BEFORE recording, so it's active for the
    // very first playback cycle onward.
    await page.click('.controls:nth-of-type(1) [data-role="shuffle"]');

    await page.click('.controls:nth-of-type(1) [data-role="recStop"]'); // start recording
    console.log("recording...");
    await new Promise((r) => setTimeout(r, 3500));

    await page.click('.controls:nth-of-type(1) [data-role="recStop"]'); // stop -> decode -> split -> startPlayback
    console.log("stopped, now playing back with shuffle for 20s...");
    await new Promise((r) => setTimeout(r, 20000));

    const meta = await page.evaluate(() => {
      const chunks = window.__capturedChunks;
      const total = chunks.reduce((a, c) => a + c.length, 0);
      const out = new Float32Array(total);
      let o = 0;
      for (const c of chunks) { out.set(c, o); o += c.length; }

      const bytes = new Uint8Array(out.buffer);
      let binary = "";
      const chunkSize = 0x8000;
      for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
      }
      return { length: out.length, base64: btoa(binary) };
    });

    const raw = Buffer.from(meta.base64, "base64");
    const samples = new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
    console.log("captured samples:", samples.length, `(${(samples.length / 44100).toFixed(2)}s)`);

    const outPath = path.join(__dirname, "captured-output.f32");
    fs.writeFileSync(outPath, Buffer.from(samples.buffer));
    console.log("saved:", outPath);
  } finally {
    await browser.close();
    server.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
