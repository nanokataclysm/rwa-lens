// RWA Lens - zero-dependency HTTP server.
//   GET /                      the UI
//   GET /api/investigate?q=    the Parity Report as JSON
//   GET /api/health            key present / not present

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { CmcError, createClient, loadApiKey } from "./lib/cmc.mjs";
import { investigate } from "./lib/investigate.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const PORT = Number(process.env.PORT) || 8787;

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/api/health") {
    return json(res, 200, {
      ok: true,
      api_key_present: Boolean(loadApiKey(join(ROOT, ".env"))),
    });
  }

  if (url.pathname === "/api/investigate") {
    return handleInvestigate(url, res);
  }

  return serveStatic(url.pathname, res);
});

async function handleInvestigate(url, res) {
  const query = url.searchParams.get("q");
  if (!query) return json(res, 400, { error: "Pass ?q=NVDA" });

  let client;
  try {
    client = createClient({ apiKey: loadApiKey(join(ROOT, ".env")) });
  } catch (err) {
    return json(res, 503, { error: err.message, code: err.code ?? null });
  }

  try {
    const report = await investigate(client, query);
    return json(res, 200, report);
  } catch (err) {
    const status = err instanceof CmcError && err.code === "NOT_FOUND" ? 404 : 502;
    return json(res, status, {
      error: err.message,
      code: err.code ?? null,
      // Partial evidence still shows which calls were made before the failure.
      evidence: client.evidence,
    });
  }
}

async function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) return json(res, 403, { error: "Forbidden" });

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

server.listen(PORT, () => {
  const keyed = loadApiKey(join(ROOT, ".env"));
  console.log(`RWA Lens on http://localhost:${PORT}`);
  console.log(
    keyed
      ? "CMC API key loaded."
      : "No CMC API key yet - set CMC_API_KEY or add it to .env",
  );
});
