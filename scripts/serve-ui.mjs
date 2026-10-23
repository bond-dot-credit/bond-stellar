// Serves ui/ on http://localhost:$PORT (default 8080). No dependencies.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../ui");
const port = Number(process.env.PORT ?? 8080);
const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
};

createServer(async (req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(root, urlPath === "/" ? "index.html" : urlPath);
  if (!file.startsWith(root)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, () => console.log(`UI on http://localhost:${port}`));
