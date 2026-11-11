// The entry point: load the data once, build the Express app, listen.
// Run with: npm start (PORT, HOST, FINDINGS_PATH and MCP_ALLOWED_ORIGINS are optional
// environment variables).

import express from "express";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { loadFindings } from "./data/load.ts";
import type { Finding } from "./data/normalise.ts";
import { createStore } from "./data/store.ts";
import { createApiRouter } from "./http/api.ts";
import { parseAllowedOrigins } from "./mcp/protocol.ts";
import { createMcpRouter } from "./mcp/router.ts";
import { createSearch } from "./search/search.ts";

const PORT = Number(process.env.PORT ?? 3000);
// Loopback by default, so a plain `npm start` is not reachable from the network.
// The container sets HOST=0.0.0.0, where the published port decides who can connect.
const HOST = process.env.HOST ?? "127.0.0.1";
// Web origins that may call /mcp from a browser, besides pages served from this machine.
// Exact origins separated by commas, e.g. MCP_ALLOWED_ORIGINS=https://tools.example
const MCP_ALLOWED_ORIGINS = parseAllowedOrigins(process.env.MCP_ALLOWED_ORIGINS);

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const setSecurityHeaders: RequestHandler = (_request, response, next) => {
  // The dataset contains script payloads. If an escaping bug ever slipped into the UI,
  // this policy still stops inline script from running and the page from being framed.
  response.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
  // Stops a browser from guessing that a JSON answer full of HTML-looking notes is HTML.
  response.set("X-Content-Type-Options", "nosniff");
  // Analysts click through to source sites; those sites must not learn the address of
  // the investigation tool from the Referer header.
  response.set("Referrer-Policy", "no-referrer");
  next();
};

// Without data the server would start and answer every search with nothing, so a load
// failure ends the process with a clear message and a non-zero exit code instead.
function loadOrExit(): Finding[] {
  try {
    return loadFindings();
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`Cannot load findings: ${reason}`);
    process.exit(1);
  }
}

// Reached only when nothing mounted below answered. Without it Express would send its
// own HTML "Cannot GET /path" page, which repeats the requested path.
const handleNotFound: RequestHandler = (_request, response) => {
  response.status(404).json({ error: "Not found" });
};

// The last resort for an error no router handled. Four parameters mark this as an error
// handler for Express, so `next` stays. The details go to the log; the client gets a
// fixed message and never a stack trace.
const handleError: ErrorRequestHandler = (error, _request, response, _next) => {
  console.error(error);
  response.status(500).json({ error: "Internal error" });
};

const findings = loadOrExit();
const store = createStore(findings);
const search = createSearch(findings);

const app = express();
// The header would tell every client which framework to look up exploits for.
app.disable("x-powered-by");
app.use(setSecurityHeaders);
app.use("/api", createApiRouter(store, search));
// The same store and search as the API, so the two interfaces cannot disagree.
app.use("/mcp", createMcpRouter(store, search, MCP_ALLOWED_ORIGINS));
// A later step mounts the static UI here: after the routers above and before the two
// handlers below, which must stay last. No CORS headers on purpose: the only browser
// client is the same-origin UI.
app.use(handleNotFound);
app.use(handleError);

app.listen(PORT, HOST, (error) => {
  if (error !== undefined) {
    console.error(`Cannot listen on ${HOST}:${PORT}: ${error.message}`);
    process.exit(1);
  }
  console.log(`Listening on http://${HOST}:${PORT} with ${findings.length} findings loaded`);
});
