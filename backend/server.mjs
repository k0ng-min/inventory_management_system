import "./env.mjs";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { handleApi, json } from "./api.mjs";

const rootDir = fileURLToPath(new URL("..", import.meta.url));
const frontendDir = join(rootDir, "frontend");
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".woff2": "font/woff2",
};

async function serveStatic(response, pathname) {
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  const filePath = join(frontendDir, normalize(requested));
  if (filePath !== frontendDir && !filePath.startsWith(frontendDir + sep)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const file = await readFile(filePath);
    response.writeHead(200, {
      "content-type": mimeTypes[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-cache",
    });
    response.end(file);
  } catch {
    // SPA fallback — unknown paths render the shell and the client routes them.
    const fallback = await readFile(join(frontendDir, "index.html"));
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(fallback);
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) await handleApi(request, response, url);
    else await serveStatic(response, url.pathname);
  } catch (error) {
    if (response.headersSent) { response.end(); return; }
    const status = Number(error?.status) >= 400 ? Number(error.status) : 500;
    if (status >= 500) console.error(`[${request.method} ${url.pathname}]`, error);
    json(response, status, { message: error.message || "서버 오류가 발생했습니다." });
  }
});

server.listen(port, host, () => {
  console.log(`\n  재고관리시스템  →  http://${host}:${port}`);
  console.log(`  나라장터 연동: ${process.env.G2B_SERVICE_KEY ? "인증키 확인됨" : "샘플 모드 (G2B_SERVICE_KEY 미설정)"}\n`);
});
