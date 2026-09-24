import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadFeed } from "./lib/feed.js";

const port = Number(process.env.PORT) || 4173;
const publicDir = path.join(import.meta.dirname, "public");
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
};

function send(response, status, body, headers) {
  response.writeHead(status, headers);
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
  if (url.pathname === "/api/feed") {
    try {
      const body = await loadFeed({
        fresh: url.searchParams.has("fresh"),
        fomoKey: process.env.FOMO_API_KEY || "",
      });
      send(response, 200, JSON.stringify(body), {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
    } catch (error) {
      send(response, 200, JSON.stringify({ ok: false, error: error.message || "Feed failed", traders: [], routes: [] }), {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
    }
    return;
  }

  const relative = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const filePath = path.normalize(path.join(publicDir, relative));
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    send(response, 404, "Not found", { "content-type": "text/plain; charset=utf-8" });
    return;
  }
  let body = fs.readFileSync(filePath);
  if (filePath.endsWith("index.html")) {
    const feed = await loadFeed().catch((error) => ({ ok: false, error: error.message || "Feed failed", traders: [], routes: [] }));
    const inline = JSON.stringify(feed).replace(/</g, "\\u003c");
    body = Buffer.from(body.toString("utf8").replace("/*__FEED__*/null", inline));
  }
  send(response, 200, body, { "content-type": types[path.extname(filePath)] || "application/octet-stream" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`paper copy trader on http://127.0.0.1:${port}`);
});
