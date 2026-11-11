// Shared by the test files. The name is chosen so that `node --test` does not run this
// file as a test of its own: it picks up *.test.ts, but also names starting with "test-".

import { readFileSync } from "node:fs";

export type Raw = { [name: string]: unknown };

// A clean raw record; each test overrides only the fields it is about.
export function record(overrides: Raw = {}): Raw {
  return {
    id: "T-1",
    caseId: "C-1",
    entity: "example.test",
    type: "domain",
    sourceUrl: "https://example.test/page",
    observedAt: "2026-09-01T00:00:00Z",
    notes: "plain note",
    ...overrides,
  };
}

// The same with a given id. The entity follows the id, so two records are never mistaken
// for a re-import unless a test says so.
export function recordWithId(id: string, overrides: Raw = {}): Raw {
  return record({ id, entity: `${id}.example.test`, ...overrides });
}

// The raw records of the real dataset, read anew on every call. Always the file in the
// repository, never FINDINGS_PATH: a variable set in the shell must not change a test.
// The data is untrusted: tests assert on ids, keys and counts only, never on note texts.
export function loadRawFindings(): unknown[] {
  const dataPath = new URL("../data/findings.json", import.meta.url);
  const data: { findings: unknown[] } = JSON.parse(readFileSync(dataPath, "utf8"));
  return data.findings;
}
