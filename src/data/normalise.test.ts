import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { normaliseFindings } from "./normalise.ts";
import type { Finding, Flag } from "./normalise.ts";

// A clean record; each test overrides only the field it is about.
function record(overrides: { [name: string]: unknown } = {}): { [name: string]: unknown } {
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

function one(overrides: { [name: string]: unknown }): Finding {
  return normaliseFindings([record(overrides)])[0]!;
}

// ======================================================================================
// Part 1: small synthetic records, one rule at a time
// ======================================================================================

describe("synthetic records", () => {
  test("a clean record passes through with no flags", () => {
    const raw = record();
    const finding = normaliseFindings([raw])[0]!;
    assert.deepEqual(finding, {
      key: "T-1",
      id: "T-1",
      entity: "example.test",
      type: "domain",
      caseIds: ["C-1"],
      observedAt: "2026-09-01T00:00:00.000Z",
      sourceUrl: "https://example.test/page",
      notes: "plain note",
      duplicateOf: null,
      flags: [],
      raw,
    });
    assert.equal(finding.raw, raw);
  });

  test("key: every record sharing an id gets a numbered key", () => {
    const findings = normaliseFindings([
      record({ id: "T-1", entity: "a.test" }),
      record({ id: "T-2", entity: "b.test" }),
      record({ id: "T-1", entity: "c.test" }),
    ]);
    assert.deepEqual(findings.map((f) => f.key), ["T-1.1", "T-2", "T-1.2"]);
    assert.deepEqual(findings.map((f) => f.id), ["T-1", "T-2", "T-1"]);
    assert.deepEqual(findings[0]!.flags, ["duplicate-id"]);
    assert.deepEqual(findings[1]!.flags, []);
    assert.deepEqual(findings[2]!.flags, ["duplicate-id"]);
  });

  test("key: a record without an id is keyed by its position", () => {
    const findings = normaliseFindings([record(), record({ id: 7 }), record({ id: "" })]);
    assert.deepEqual(findings.map((f) => f.key), ["T-1", "row-2", "row-3"]);
    assert.deepEqual(findings[1]!.flags, ["id-missing"]);
    assert.equal(findings[1]!.id, "");
  });

  test("type: a valid type in another spelling is accepted and flagged", () => {
    assert.deepEqual(one({ type: "Domain" }).flags, ["type-nonstandard"]);
    assert.equal(one({ type: "Domain" }).type, "domain");
    const email = one({ type: " email ", entity: "a@b.test" });
    assert.equal(email.type, "email");
    assert.deepEqual(email.flags, ["type-nonstandard"]);
  });

  test("type: any other type becomes unknown and is never guessed from the entity", () => {
    const finding = one({ type: "ipv4", entity: "192.0.2.1" });
    assert.equal(finding.type, "unknown");
    assert.deepEqual(finding.flags, ["type-unknown"]);
    assert.equal(one({ type: null }).type, "unknown");
  });

  test("type: an entity shape that fits its label is not flagged", () => {
    const fitting = [
      { type: "domain", entity: "sub.example.test" },
      { type: "ip", entity: "192.0.2.1" },
      { type: "ip", entity: "2001:db8::1" },
      { type: "email", entity: "someone@example.test" },
      { type: "wallet", entity: "0x00000000000000000000000000000000000000aa" },
      { type: "handle", entity: "night_owl" },
      { type: "handle", entity: "@night_owl" },
      { type: "alias", entity: "night_owl" },
      { type: "alias", entity: "The Night Owl" },
    ];
    for (const fields of fitting) {
      assert.deepEqual(one(fields).flags, [], `${fields.type} ${fields.entity}`);
    }
  });

  test("type: an entity shape that contradicts its label is flagged, type unchanged", () => {
    const contradicting = [
      { type: "domain", entity: "192.0.2.1" },
      { type: "ip", entity: "night_owl" },
      { type: "handle", entity: "someone@example.test" },
      { type: "alias", entity: "example.test" },
      { type: "email", entity: "example.test" },
      { type: "wallet", entity: "night_owl" },
      { type: "domain", entity: "https://example.test/" },
    ];
    for (const fields of contradicting) {
      const finding = one(fields);
      assert.deepEqual(finding.flags, ["type-mismatch"], `${fields.type} ${fields.entity}`);
      assert.equal(finding.type, fields.type);
    }
  });

  test("caseIds: caseId becomes an array of trimmed uppercase ids", () => {
    assert.deepEqual(one({ caseId: "C-9" }).caseIds, ["C-9"]);
    const odd = one({ caseId: " c-9" });
    assert.deepEqual(odd.caseIds, ["C-9"]);
    assert.deepEqual(odd.flags, ["case-nonstandard"]);
  });

  test("caseIds: an array keeps its string members and is flagged as multiple", () => {
    const two = one({ caseId: ["C-1", "C-2"] });
    assert.deepEqual(two.caseIds, ["C-1", "C-2"]);
    assert.deepEqual(two.flags, ["case-multiple"]);
    const messy = one({ caseId: ["c-1", 5, "C-1", null] });
    assert.deepEqual(messy.caseIds, ["C-1"]);
    assert.deepEqual(messy.flags, ["case-nonstandard"]);
  });

  test("caseIds: null, missing and other values give no cases", () => {
    const { caseId: _removed, ...withoutCase } = record();
    const inputs = [{ caseId: null }, { caseId: 12 }, { caseId: [] }].map((o) => record(o));
    for (const finding of normaliseFindings([withoutCase, ...inputs])) {
      assert.deepEqual(finding.caseIds, []);
      assert.ok(finding.flags.includes("case-missing"));
    }
  });

  test("observedAt: Z, offset and epoch milliseconds all become the same UTC string", () => {
    const expected = "2026-09-01T00:27:17.000Z";
    assert.equal(one({ observedAt: "2026-09-01T00:27:17Z" }).observedAt, expected);
    assert.equal(one({ observedAt: "2026-09-01T03:27:17+03:00" }).observedAt, expected);
    assert.equal(one({ observedAt: Date.parse(expected) }).observedAt, expected);
    assert.deepEqual(one({ observedAt: Date.parse(expected) }).flags, []);
  });

  test("observedAt: anything else is null and flagged", () => {
    const invalid = ["yesterday", "2026-09-01", "2026-09-01T00:27:17", "", 12, NaN, null, {}];
    for (const observedAt of invalid) {
      const finding = one({ observedAt });
      assert.equal(finding.observedAt, null, String(observedAt));
      assert.deepEqual(finding.flags, ["time-invalid"]);
    }
  });

  test("sourceUrl: an http(s) URL is kept exactly as written", () => {
    const url = "https://example.test/thread/?utm_source=x&id=1";
    assert.equal(one({ sourceUrl: url }).sourceUrl, url);
    assert.equal(one({ sourceUrl: "http://example.test/" }).sourceUrl, "http://example.test/");
  });

  test("sourceUrl: everything else is not a link, and the raw value survives", () => {
    const notLinks = ["javascript:void(0)", "data:text/plain,hi", "", "example.test/a", 5, null];
    for (const sourceUrl of notLinks) {
      const raw = record({ sourceUrl });
      const finding = normaliseFindings([raw])[0]!;
      assert.equal(finding.sourceUrl, null, String(sourceUrl));
      assert.deepEqual(finding.flags, ["source-not-link"]);
      assert.equal(finding.raw, raw);
    }
  });

  test("notes: notes are kept byte-for-byte", () => {
    const text = "  5 &lt; 10 <b>bold</b>\n ";
    assert.equal(one({ notes: text }).notes, text);
    assert.deepEqual(one({ notes: text }).flags, []);
  });

  test("notes: missing or null notes are null and flagged", () => {
    const { notes: _removed, ...withoutNotes } = record();
    const withNull = record({ id: "T-2", entity: "other.test", notes: null });
    for (const finding of normaliseFindings([withNull, withoutNotes])) {
      assert.equal(finding.notes, null);
      assert.deepEqual(finding.flags, ["notes-missing"]);
    }
  });

  test("re-import: the record with the higher id is the re-import", () => {
    const findings = normaliseFindings([
      record({ id: "T-9", entity: " EXAMPLE.test ", observedAt: 1788220800000, caseId: "c-1" }),
      record({ id: "T-1", sourceUrl: "https://other.test/" }),
    ]);
    assert.equal(findings[0]!.duplicateOf, "T-1");
    assert.ok(findings[0]!.flags.includes("reimport"));
    assert.equal(findings[1]!.duplicateOf, null);
    assert.deepEqual(findings[1]!.flags, []);
  });

  test("re-import: a difference in case, time, notes or entity means a separate finding", () => {
    const findings = normaliseFindings([
      record({ id: "T-1" }),
      record({ id: "T-2", caseId: "C-2" }),
      record({ id: "T-3", observedAt: "2026-09-01T00:00:01Z" }),
      record({ id: "T-4", notes: "another note" }),
      record({ id: "T-5", entity: "other.test" }),
    ]);
    for (const finding of findings) {
      assert.equal(finding.duplicateOf, null, finding.id);
    }
  });

  test("re-import: records sharing an id are not re-imports of each other", () => {
    const findings = normaliseFindings([record(), record()]);
    assert.deepEqual(findings.map((f) => f.duplicateOf), [null, null]);
    assert.deepEqual(findings.map((f) => f.flags), [["duplicate-id"], ["duplicate-id"]]);
  });

  test("re-import: duplicateOf holds the key, also when the original has a duplicated id", () => {
    const findings = normaliseFindings([
      record({ id: "T-1", entity: "unrelated.test" }),
      record({ id: "T-1" }),
      record({ id: "T-2" }),
    ]);
    assert.equal(findings[2]!.duplicateOf, "T-1.2");
  });

  test("entity: the entity is trimmed, keeps its letter case, and the padding is flagged", () => {
    const finding = one({ entity: "  Example.TEST ", type: "domain" });
    assert.equal(finding.entity, "Example.TEST");
    assert.deepEqual(finding.flags, ["entity-whitespace"]);
  });

  test("entity: a missing entity is flagged once, without a type mismatch on top", () => {
    assert.deepEqual(one({ entity: "   " }).flags, ["entity-missing"]);
    assert.equal(one({ entity: 5 }).entity, "");
  });

  test("malformed records do not throw and are flagged", () => {
    const wrongTypes = {
      id: 7,
      caseId: { nested: true },
      entity: ["list"],
      type: 3,
      sourceUrl: 5,
      observedAt: "soon",
      notes: 9,
    };
    const input: unknown[] = [null, undefined, "text", 42, [], {}, wrongTypes, record()];
    const findings = normaliseFindings(input);
    const allMissing: Flag[] = [
      "id-missing",
      "entity-missing",
      "type-unknown",
      "case-missing",
      "time-invalid",
      "source-not-link",
      "notes-missing",
    ];
    assert.equal(findings.length, input.length);
    for (let index = 0; index < 7; index++) {
      const finding = findings[index]!;
      assert.equal(finding.key, `row-${index + 1}`);
      assert.deepEqual(finding.flags, allMissing);
      assert.equal(finding.raw, input[index]);
      assert.equal(finding.duplicateOf, null);
    }
    assert.deepEqual(findings[7]!.flags, []);
  });

  test("the input is not mutated and the order is kept", () => {
    const input = [record({ id: "T-3", caseId: [" c-1 "] }), record({ id: "T-1", entity: " x " })];
    const before = structuredClone(input);
    const findings = normaliseFindings(input);
    assert.deepEqual(input, before);
    assert.deepEqual(findings.map((f) => f.id), ["T-3", "T-1"]);
  });
});

// ======================================================================================
// Part 2: the real dataset. Asserts on ids and counts only, never on note texts.
// ======================================================================================

describe("real dataset", () => {
  const dataPath = new URL("../../data/findings.json", import.meta.url);
  const data: { findings: unknown[] } = JSON.parse(readFileSync(dataPath, "utf8"));
  const before = structuredClone(data.findings);
  const findings = normaliseFindings(data.findings);

  function withId(id: string): Finding[] {
    return findings.filter((f) => f.id === id);
  }

  function onlyWithId(id: string): Finding {
    const matches = withId(id);
    assert.equal(matches.length, 1, `expected exactly one record with id ${id}`);
    return matches[0]!;
  }

  function idsWithFlag(flag: Flag): string[] {
    return findings.filter((f) => f.flags.includes(flag)).map((f) => f.id).sort();
  }

  test("1032 records in, 1032 out, in the same order", () => {
    assert.equal(data.findings.length, 1032);
    assert.equal(findings.length, 1032);
    findings.forEach((finding, index) => assert.equal(finding.raw, data.findings[index]));
  });

  test("the input array is not mutated", () => {
    assert.deepEqual(data.findings, before);
  });

  test("all keys are unique", () => {
    assert.equal(new Set(findings.map((f) => f.key)).size, 1032);
  });

  test("the two duplicated ids each produce .1 and .2", () => {
    for (const id of ["F-10578", "F-10401"]) {
      assert.deepEqual(withId(id).map((f) => f.key), [`${id}.1`, `${id}.2`]);
      assert.deepEqual(withId(id).map((f) => f.duplicateOf), [null, null]);
    }
    assert.deepEqual(idsWithFlag("duplicate-id"), ["F-10401", "F-10401", "F-10578", "F-10578"]);
  });

  test("exactly the 30 records F-20000..F-20029 are re-imports of an existing key", () => {
    const reimports = findings.filter((f) => f.duplicateOf !== null);
    const expectedIds: string[] = [];
    for (let n = 0; n < 30; n++) expectedIds.push(`F-${20000 + n}`);
    assert.deepEqual(reimports.map((f) => f.id).sort(), expectedIds);
    assert.deepEqual(idsWithFlag("reimport"), expectedIds);

    const keys = new Set(findings.map((f) => f.key));
    for (const reimport of reimports) {
      assert.ok(keys.has(reimport.duplicateOf!), `${reimport.id} points at a missing key`);
      assert.match(reimport.duplicateOf!, /^F-10\d\d\d$/);
    }
  });

  test("the two off-spec types are unknown", () => {
    assert.equal(onlyWithId("F-10788").type, "unknown");
    assert.equal(onlyWithId("F-10142").type, "unknown");
    assert.deepEqual(idsWithFlag("type-unknown"), ["F-10142", "F-10788"]);
  });

  test("five valid types were written in a non-standard way", () => {
    const expected = ["F-10276", "F-10380", "F-10582", "F-10819", "F-10917"];
    assert.deepEqual(idsWithFlag("type-nonstandard"), expected);
  });

  test("exactly three records have an entity that contradicts its type", () => {
    assert.deepEqual(idsWithFlag("type-mismatch"), ["F-10380", "F-10582", "F-10819"]);
    // The flag never changes the type.
    assert.equal(onlyWithId("F-10819").type, "domain");
    assert.equal(onlyWithId("F-10582").type, "ip");
    assert.equal(onlyWithId("F-10380").type, "handle");
  });

  test("the three odd caseIds are normalised", () => {
    assert.deepEqual(onlyWithId("F-10335").caseIds, ["C-117"]);
    assert.deepEqual(onlyWithId("F-10767").caseIds, []);
    assert.deepEqual(onlyWithId("F-10906").caseIds, ["C-104", "C-122"]);
    assert.deepEqual(idsWithFlag("case-nonstandard"), ["F-10335"]);
    assert.deepEqual(idsWithFlag("case-missing"), ["F-10767"]);
    assert.deepEqual(idsWithFlag("case-multiple"), ["F-10906"]);
  });

  test("every observedAt is a valid UTC ISO string ending in Z", () => {
    for (const finding of findings) {
      assert.ok(finding.observedAt !== null, finding.key);
      assert.match(finding.observedAt, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      assert.equal(new Date(finding.observedAt).toISOString(), finding.observedAt);
    }
    assert.deepEqual(idsWithFlag("time-invalid"), []);
  });

  test("exactly four records have no usable source link", () => {
    const withoutLink = findings.filter((f) => f.sourceUrl === null).map((f) => f.id).sort();
    const expected = ["F-10381", "F-10748", "F-10930", "F-10968"];
    assert.deepEqual(withoutLink, expected);
    assert.deepEqual(idsWithFlag("source-not-link"), expected);
  });

  test("every source link is the untouched raw http(s) value", () => {
    for (const finding of findings) {
      if (finding.sourceUrl === null) continue;
      assert.match(finding.sourceUrl, /^https?:\/\//);
      assert.equal(finding.sourceUrl, (finding.raw as { sourceUrl: unknown }).sourceUrl);
    }
  });

  test("seven records have no notes", () => {
    assert.equal(findings.filter((f) => f.notes === null).length, 7);
    assert.equal(idsWithFlag("notes-missing").length, 7);
  });

  test("four entities had surrounding whitespace and none is missing", () => {
    const expected = ["F-20000", "F-20005", "F-20007", "F-20017"];
    assert.deepEqual(idsWithFlag("entity-whitespace"), expected);
    assert.deepEqual(idsWithFlag("entity-missing"), []);
    assert.deepEqual(idsWithFlag("id-missing"), []);
    for (const finding of findings) assert.equal(finding.entity, finding.entity.trim());
  });
});
