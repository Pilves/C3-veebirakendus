// Reads the findings file once, at startup, and hands the records to the normaliser.
// The file is untrusted: it is parsed as JSON and passed on, never interpreted or run.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { normaliseFindings } from "./normalise.ts";
import type { Finding } from "./normalise.ts";

// Resolved against this file, not the current directory, so the server finds its data
// no matter where it is started from.
const DEFAULT_PATH = fileURLToPath(new URL("../../data/findings.json", import.meta.url));

// Throws on a missing file, broken JSON or an unexpected top level. That is on purpose:
// the server must fail at boot rather than run and answer every search with nothing.
export function loadFindings(path: string = process.env.FINDINGS_PATH ?? DEFAULT_PATH): Finding[] {
  const data: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof data !== "object" || data === null || !("findings" in data)) {
    throw new Error(`${path}: expected an object with a "findings" array`);
  }
  if (!Array.isArray(data.findings)) {
    throw new Error(`${path}: "findings" is not an array`);
  }
  return normaliseFindings(data.findings);
}
