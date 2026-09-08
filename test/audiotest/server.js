const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = process.argv[2];
const PORT = process.argv[3] || 8791;

const MIME = { ".html": "text/html", ".js": "text/javascript", ".ico": "image/x-icon" };

http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]);
  if (p === "/") p = "/index.html";
  const full = path.join(ROOT, p);
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    const ext = path.extname(full);
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}).listen(PORT, () => console.log(`serving ${ROOT} on http://localhost:${PORT}`));
