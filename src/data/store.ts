// Lookups over the normalised findings that are not a search: one record by id, and the
// list of cases. The HTTP API and the MCP tools both use this store, so they cannot disagree.
// Everything is worked out once in createStore; the data never changes while running.

import type { Finding, FindingType } from "./normalise.ts";

export type TypeCounts = { [type in FindingType]: number };

export type CaseSummary = {
  caseId: string;
  findings: number; // re-imported copies are not counted, as in the default search
  duplicates: number; // the re-imported copies in this case
  firstObservedAt: string | null; // null when no counted finding has a valid time
  lastObservedAt: string | null;
  types: TypeCounts; // counts per type, re-imports not counted; adds up to `findings`
};

export type CaseList = {
  cases: CaseSummary[]; // sorted by caseId
  findingsWithoutCase: number; // re-imports not counted; these belong to no case above
};

export type Store = {
  findById(idOrKey: string): Finding[];
  listCases(): CaseList;
};

// ---------- by id ----------

function addTo(index: Map<string, Finding[]>, name: string, finding: Finding): void {
  const list = index.get(name);
  if (list === undefined) index.set(name, [finding]);
  else list.push(finding);
}

// A Map, not a plain object: the lookup text comes from a URL, and on an object a name
// like "__proto__" or "constructor" would find something that is not a finding.
function indexByIdAndKey(findings: Finding[]): Map<string, Finding[]> {
  const index = new Map<string, Finding[]>();
  for (const finding of findings) {
    addTo(index, finding.key, finding);
    // Most findings have key === id and must not be listed twice. A missing id is ""
    // and is not indexed: "" is not a name anyone can look a record up by.
    if (finding.id !== finding.key && finding.id !== "") addTo(index, finding.id, finding);
  }
  return index;
}

// ---------- cases ----------

// Every type is present, with 0 when a case has none, so a client can read any type
// without first checking that the name exists.
function emptyTypeCounts(): TypeCounts {
  return { domain: 0, ip: 0, email: 0, handle: 0, alias: 0, wallet: 0, unknown: 0 };
}

function emptyCase(caseId: string): CaseSummary {
  return {
    caseId,
    findings: 0,
    duplicates: 0,
    firstObservedAt: null,
    lastObservedAt: null,
    types: emptyTypeCounts(),
  };
}

function addToCase(summary: CaseSummary, finding: Finding): void {
  if (finding.duplicateOf !== null) {
    summary.duplicates++;
    return;
  }
  summary.findings++;
  summary.types[finding.type]++;
  // observedAt is always the same UTC ISO format, which compares correctly as text.
  const time = finding.observedAt;
  if (time === null) return;
  if (summary.firstObservedAt === null || time < summary.firstObservedAt) {
    summary.firstObservedAt = time;
  }
  if (summary.lastObservedAt === null || time > summary.lastObservedAt) {
    summary.lastObservedAt = time;
  }
}

function summariseCases(findings: Finding[]): CaseList {
  const byCaseId = new Map<string, CaseSummary>();
  let findingsWithoutCase = 0;
  for (const finding of findings) {
    if (finding.caseIds.length === 0 && finding.duplicateOf === null) findingsWithoutCase++;
    // A finding with two case ids belongs to both cases and is counted in each.
    for (const caseId of finding.caseIds) {
      let summary = byCaseId.get(caseId);
      if (summary === undefined) {
        summary = emptyCase(caseId);
        byCaseId.set(caseId, summary);
      }
      addToCase(summary, finding);
    }
  }
  // Plain comparison, not localeCompare: the order must not depend on the machine's locale.
  const cases = [...byCaseId.values()].sort((a, b) => (a.caseId < b.caseId ? -1 : 1));
  return { cases, findingsWithoutCase };
}

// ---------- the store ----------

export function createStore(findings: Finding[]): Store {
  const byIdOrKey = indexByIdAndKey(findings);
  const caseList = summariseCases(findings);

  return {
    // Always a list. An id shared by two unrelated records returns both, so the caller
    // sees the clash instead of the store silently picking one.
    findById(idOrKey: string): Finding[] {
      return byIdOrKey.get(idOrKey.trim()) ?? [];
    },
    listCases(): CaseList {
      return caseList;
    },
  };
}
