import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadRawFindings, recordWithId as record } from "../testing.ts";
import type { Raw } from "../testing.ts";
import { normaliseFindings } from "./normalise.ts";
import { createStore } from "./store.ts";
import type { CaseSummary, Store } from "./store.ts";

function storeOf(records: Raw[]): Store {
  return createStore(normaliseFindings(records));
}

function keysOf(store: Store, idOrKey: string): string[] {
  return store.findById(idOrKey).map((finding) => finding.key);
}

function caseOf(store: Store, caseId: string): CaseSummary {
  const summary = store.listCases().cases.find((item) => item.caseId === caseId);
  assert.ok(summary !== undefined, `case ${caseId} is listed`);
  return summary;
}

// ======================================================================================
// Part 1: small synthetic records, one rule at a time
// ======================================================================================

describe("findById", () => {
  const store = storeOf([
    record("T-1"),
    record("T-2", { entity: "first.example.test" }),
    record("T-2", { entity: "second.example.test" }),
    record("", { entity: "nameless.example.test" }),
  ]);

  test("a unique id returns that one finding", () => {
    assert.deepEqual(keysOf(store, "T-1"), ["T-1"]);
  });

  test("a shared id returns every record that has it", () => {
    assert.deepEqual(keysOf(store, "T-2"), ["T-2.1", "T-2.2"]);
  });

  test("a key returns exactly one of the records sharing an id", () => {
    assert.deepEqual(keysOf(store, "T-2.2"), ["T-2.2"]);
    assert.equal(store.findById("T-2.2")[0]?.entity, "second.example.test");
  });

  test("a record without an id is found by its row key", () => {
    assert.deepEqual(keysOf(store, "row-4"), ["row-4"]);
  });

  test("an unknown id returns an empty list", () => {
    assert.deepEqual(store.findById("T-999"), []);
    assert.deepEqual(store.findById("T-2.3"), []);
  });

  test("the argument is trimmed", () => {
    assert.deepEqual(keysOf(store, "  T-1\n"), ["T-1"]);
  });

  test("a record whose id was written with whitespace around it is still reached", () => {
    const padded = storeOf([record("T-1"), { ...record("T-8"), id: " T-8\t" }]);
    assert.deepEqual(keysOf(padded, "T-8"), ["T-8"]);
    assert.deepEqual(keysOf(padded, " T-8 "), ["T-8"]);
  });

  test("ids are case-sensitive", () => {
    assert.deepEqual(store.findById("t-1"), []);
  });

  test("an empty argument finds nothing, not the records without an id", () => {
    assert.deepEqual(store.findById(""), []);
    assert.deepEqual(store.findById("   "), []);
  });

  test("names of built-in object properties find nothing", () => {
    for (const name of ["__proto__", "constructor", "toString", "hasOwnProperty"]) {
      assert.deepEqual(store.findById(name), []);
    }
  });

  test("a re-imported copy is found by its own id", () => {
    const same = { entity: "copy.example.test" };
    const copies = storeOf([record("T-1", same), record("T-9", same)]);
    assert.equal(copies.findById("T-9")[0]?.duplicateOf, "T-1");
  });
});

describe("listCases", () => {
  test("no findings gives no cases", () => {
    assert.deepEqual(storeOf([]).listCases(), { cases: [], findingsWithoutCase: 0 });
  });

  test("one finding gives one complete summary", () => {
    assert.deepEqual(storeOf([record("T-1")]).listCases(), {
      cases: [
        {
          caseId: "C-1",
          findings: 1,
          duplicates: 0,
          firstObservedAt: "2026-09-01T00:00:00.000Z",
          lastObservedAt: "2026-09-01T00:00:00.000Z",
          types: { domain: 1, ip: 0, email: 0, handle: 0, alias: 0, wallet: 0, unknown: 0 },
        },
      ],
      findingsWithoutCase: 0,
    });
  });

  test("cases are sorted by case id", () => {
    const store = storeOf([
      record("T-1", { caseId: "C-30" }),
      record("T-2", { caseId: "C-10" }),
      record("T-3", { caseId: "C-20" }),
    ]);
    const caseIds = store.listCases().cases.map((item) => item.caseId);
    assert.deepEqual(caseIds, ["C-10", "C-20", "C-30"]);
  });

  test("differently written case ids are one case", () => {
    const store = storeOf([record("T-1", { caseId: "c-1 " }), record("T-2", { caseId: "C-1" })]);
    assert.equal(store.listCases().cases.length, 1);
    assert.equal(caseOf(store, "C-1").findings, 2);
  });

  test("a finding with two case ids counts in both cases", () => {
    const store = storeOf([record("T-1", { caseId: ["C-1", "C-2"] }), record("T-2")]);
    assert.equal(caseOf(store, "C-1").findings, 2);
    assert.equal(caseOf(store, "C-2").findings, 1);
  });

  test("a re-imported copy counts as a duplicate, not as a finding or a type", () => {
    const same = { entity: "copy.example.test" };
    const store = storeOf([record("T-1", same), record("T-9", same), record("T-2")]);
    const summary = caseOf(store, "C-1");
    assert.equal(summary.findings, 2);
    assert.equal(summary.duplicates, 1);
    assert.equal(summary.types.domain, 2);
  });

  test("types are counted per case, unknown included", () => {
    const store = storeOf([
      record("T-1"),
      record("T-2", { type: "wallet" }),
      record("T-3", { type: "wallet" }),
      record("T-4", { type: "url" }),
    ]);
    assert.deepEqual(caseOf(store, "C-1").types, {
      domain: 1,
      ip: 0,
      email: 0,
      handle: 0,
      alias: 0,
      wallet: 2,
      unknown: 1,
    });
  });

  test("first and last observed are the earliest and latest valid times", () => {
    const store = storeOf([
      record("T-1", { observedAt: "2026-09-02T00:00:00Z" }),
      record("T-2", { observedAt: "2026-09-01T00:00:00Z" }),
      record("T-3", { observedAt: "2026-09-03T00:00:00Z" }),
      record("T-4", { observedAt: "not a time" }),
    ]);
    const summary = caseOf(store, "C-1");
    assert.equal(summary.findings, 4);
    assert.equal(summary.firstObservedAt, "2026-09-01T00:00:00.000Z");
    assert.equal(summary.lastObservedAt, "2026-09-03T00:00:00.000Z");
  });

  test("a case with no valid time has null for both", () => {
    const summary = caseOf(storeOf([record("T-1", { observedAt: null })]), "C-1");
    assert.equal(summary.firstObservedAt, null);
    assert.equal(summary.lastObservedAt, null);
  });

  test("findings without a case are counted once and are not a case", () => {
    const store = storeOf([
      record("T-1", { caseId: null }),
      record("T-2", { caseId: "" }),
      record("T-3"),
    ]);
    const list = store.listCases();
    assert.equal(list.findingsWithoutCase, 2);
    assert.deepEqual(list.cases.map((item) => item.caseId), ["C-1"]);
  });

  test("a re-imported copy without a case is not counted as without a case", () => {
    const same = { caseId: null, entity: "copy.example.test" };
    const store = storeOf([record("T-1", same), record("T-9", same)]);
    assert.equal(store.listCases().findingsWithoutCase, 1);
  });
});

// ======================================================================================
// Part 2: the real dataset
// ======================================================================================

describe("real dataset", () => {
  const findings = normaliseFindings(loadRawFindings());
  const store = createStore(findings);
  const list = store.listCases();

  test("the shared id F-10578 returns both records, each key returns one", () => {
    assert.deepEqual(keysOf(store, "F-10578"), ["F-10578.1", "F-10578.2"]);
    assert.deepEqual(keysOf(store, "F-10578.1"), ["F-10578.1"]);
  });

  test("every finding is found by its key, alone", () => {
    for (const finding of findings) {
      assert.deepEqual(store.findById(finding.key), [finding]);
    }
  });

  test("there are 40 cases, sorted", () => {
    const caseIds = list.cases.map((item) => item.caseId);
    assert.equal(caseIds.length, 40);
    assert.deepEqual(caseIds, [...caseIds].sort());
  });

  test("in every case the type counts add up to the findings count", () => {
    for (const summary of list.cases) {
      const typed = Object.values(summary.types).reduce((sum, count) => sum + count, 0);
      assert.equal(typed, summary.findings, summary.caseId);
    }
  });

  // Each finding is counted once per case it is in, or once as "without a case".
  test("the counts account for every finding", () => {
    const originals = findings.filter((finding) => finding.duplicateOf === null);
    const copies = findings.filter((finding) => finding.duplicateOf !== null);
    const memberships = (group: typeof findings) =>
      group.reduce((sum, finding) => sum + finding.caseIds.length, 0);

    const counted = list.cases.reduce((sum, item) => sum + item.findings, 0);
    const duplicates = list.cases.reduce((sum, item) => sum + item.duplicates, 0);
    assert.equal(counted, memberships(originals));
    assert.equal(duplicates, memberships(copies));
    const withoutCase = originals.filter((finding) => finding.caseIds.length === 0).length;
    assert.equal(list.findingsWithoutCase, withoutCase);
  });
});
