// The entry point: load the data once, build the Express app, listen.
// Run with: npm start (PORT, HOST, FINDINGS_PATH and ALLOWED_HOSTS are optional
// environment variables).

import { createApp } from "./app.ts";
import { loadFindings } from "./data/load.ts";
import type { Finding } from "./data/normalise.ts";
import { createStore } from "./data/store.ts";
import { parsePort, valueOr } from "./env.ts";
import { parseAllowedHosts } from "./http/host.ts";
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

const findings = loadOrExit();
const store = createStore(findings);
const search = createSearch(findings);

const app = createApp(store, search, ALLOWED_HOSTS);

app.listen(PORT, HOST, (error) => {
  if (error !== undefined) {
    console.error(`Cannot listen on ${HOST}:${PORT}: ${error.message}`);
    process.exit(1);
  }
  console.log(`Listening on http://${HOST}:${PORT} with ${findings.length} findings loaded`);
});
