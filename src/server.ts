// The entry point: load the data once, build the Express app, listen.
// Run with: npm start (PORT, HOST, FINDINGS_PATH and ALLOWED_HOSTS are optional
// environment variables).

import { fileURLToPath } from "node:url";
import express from "express";
import type { ErrorRequestHandler, RequestHandler } from "express";
import { loadFindings } from "./data/load.ts";
import type { Finding } from "./data/normalise.ts";
import { createStore } from "./data/store.ts";
import { parsePort, valueOr } from "./env.ts";
import { createApiRouter } from "./http/api.ts";
import { isAllowedHost, parseAllowedHosts } from "./http/host.ts";
import { createMcpRouter } from "./mcp/router.ts";
import { createSearch } from "./search/search.ts";

// A port that is not a port ends the process with one clear line, like a load failure
// below, instead of a stack trace from deep inside listen().
function portOrExit(): number {
  const port = parsePort(valueOr(process.env.PORT, "3000"));
  if (port === undefined) {
    console.error("Cannot listen: PORT must be a whole number from 1 to 65535");
    process.exit(1);
  }
  return port;
}

const PORT = portOrExit();
// Loopback by default, so a plain `npm start` is not reachable from the network.
// The container sets HOST=0.0.0.0, where the published port decides who can connect.
const HOST = valueOr(process.env.HOST, "127.0.0.1");
// Hostnames this tool may be reached under, besides the local ones. Names only, separated
// by commas, e.g. ALLOWED_HOSTS=findings.internal.example
const ALLOWED_HOSTS = parseAllowedHosts(process.env.ALLOWED_HOSTS);

// Resolved from this file's own location, not from the directory the server was started
// in, so `node src/server.ts` serves the same files from anywhere.
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  // The UI builds the page from text nodes only. With this directive the browser itself
  // refuses innerHTML and similar calls that would turn a string into markup or script.
  "require-trusted-types-for 'script'",
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
  // A source site opened from here gets no handle on this window, and no other site can
  // load this tool's files or answers into its own pages.
  response.set("Cross-Origin-Opener-Policy", "same-origin");
  response.set("Cross-Origin-Resource-Policy", "same-origin");
  next();
};

// The tool has no login, so the only thing that keeps a web page elsewhere from reading
// it through the analyst's browser is this check (DNS rebinding, see http/host.ts).
// The message is fixed: the header is request text and is never sent back.
const refuseForeignHost: RequestHandler = (request, response, next) => {
  if (isAllowedHost(request.headers.host, ALLOWED_HOSTS)) {
    next();
    return;
  }
  response.status(403).json({ error: "Forbidden: Host not allowed" });
};

// Findings are investigation data: an answer must not stay in the browser's disk cache
// after the tool is closed. The three static files hold no data and keep the default.
const forbidCaching: RequestHandler = (_request, response, next) => {
  response.set("Cache-Control", "no-store");
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
// Before every router and the static files, so nothing answers a foreign Host. After
// the headers above, so the refusal carries them too.
app.use(refuseForeignHost);
app.use(["/api", "/mcp"], forbidCaching);
app.use("/api", createApiRouter(store, search));
// The same store and search as the API, so the two interfaces cannot disagree.
app.use("/mcp", createMcpRouter(store, search));
// The browser UI: three static files. Mounted after the routers above, so a file can
// never shadow /api or /mcp, and before the two handlers below, which must stay last.
// No CORS headers on purpose: the only browser client is this same-origin UI.
app.use(express.static(PUBLIC_DIR));
app.use(handleNotFound);
app.use(handleError);

app.listen(PORT, HOST, (error) => {
  if (error !== undefined) {
    console.error(`Cannot listen on ${HOST}:${PORT}: ${error.message}`);
    process.exit(1);
  }
  console.log(`Listening on http://${HOST}:${PORT} with ${findings.length} findings loaded`);
});
