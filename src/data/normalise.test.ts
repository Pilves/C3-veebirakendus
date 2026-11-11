import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadRawFindings, record } from "../testing.ts";
import type { Raw } from "../testing.ts";
import { normaliseFindings } from "./normalise.ts";
import type { Finding, Flag } from "./normalise.ts";

function one(overrides: Raw): Finding {
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

  test("key: a numbered key steps over a real id that looks the same", () => {
    // Without the step, the second "A" and the record whose id is "A.2" would share a key.
    const ids = ["A", "A", "A.2", "A.1", "A"];
    const findings = normaliseFindings(ids.map((id) => record({ id, entity: `${id}.test` })));
    assert.deepEqual(findings.map((f) => f.key), ["A.3", "A.4", "A.2", "A.1", "A.5"]);
    assert.deepEqual(findings.map((f) => f.id), ids);
    assert.equal(new Set(findings.map((f) => f.key)).size, ids.length);
  });

  test("key: a row key steps over a real id that looks the same", () => {
    const findings = normaliseFindings([
      record({ id: "row-2", entity: "a.test" }),
      record({ id: null, entity: "b.test" }),
      record({ id: null, entity: "c.test" }),
    ]);
    assert.deepEqual(findings.map((f) => f.key), ["row-2", "row-2.1", "row-3"]);
    assert.deepEqual(findings[1]!.flags, ["id-missing"]);
  });

  test("key: keys stay unique when made-up keys could meet each other", () => {
    // Two records share the id "row-3", so both are numbered; the third has no id and
    // sits on row 3; the fourth has, as its real id, a key the others could be given.
    const ids = ["row-3", "row-3", null, "row-3.1", null, "row-5"];
    const findings = normaliseFindings(ids.map((id, n) => record({ id, entity: `${n}.test` })));
    assert.equal(new Set(findings.map((f) => f.key)).size, ids.length);
    assert.equal(findings[3]!.key, "row-3.1", "a unique id always keeps its own key");
    assert.equal(findings[5]!.key, "row-5");
  });

  test("id: surrounding whitespace is trimmed for id and key, the raw record keeps it", () => {
    const raw = record({ id: "  T-7\n" });
    const finding = normaliseFindings([raw])[0]!;
    assert.equal(finding.id, "T-7");
    assert.equal(finding.key, "T-7");
    assert.deepEqual(finding.flags, []);
    assert.equal((finding.raw as { id: string }).id, "  T-7\n");
  });

  test("id: ids that differ only in whitespace are the same id", () => {
    const findings = normaliseFindings([record({ id: "T-7 " }), record({ id: " T-7" })]);
    assert.deepEqual(findings.map((f) => f.key), ["T-7.1", "T-7.2"]);
  });

  test("id: an id of only whitespace counts as missing", () => {
    for (const id of [" ", "\t\n", "\u00a0"]) {
      const finding = one({ id });
      assert.equal(finding.id, "");
      assert.equal(finding.key, "row-1");
      assert.deepEqual(finding.flags, ["id-missing"]);
    }
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

  test("type: a long hostile entity is classified quickly", () => {
    // The first one took seconds with the old email pattern: each dot could be read
    // as part of a label or as the dot between two labels.
    const hostile = [
      `a@${".".repeat(100_000)}`,
      `a@${"a.".repeat(50_000)}`,
      `a@${".a".repeat(50_000)}@`,
      `${"a".repeat(50_000)}@${"a".repeat(50_000)}`,
      "a".repeat(100_000),
      "a.".repeat(50_000),
      "@".repeat(100_000),
    ];
    for (const entity of hostile) {
      const started = performance.now();
      const finding = one({ entity, type: "email" });
      const elapsedMs = performance.now() - started;
      assert.deepEqual(finding.flags, ["type-mismatch"], entity.slice(0, 8));
      assert.ok(elapsedMs < 100, `${entity.slice(0, 8)}... took ${Math.round(elapsedMs)} ms`);
    }
  });

  test("type: what counts as the shape of an email", () => {
    for (const entity of ["a@b.test", "first.last@mail.example.test", "a+b@x-y.test"]) {
      assert.deepEqual(one({ entity, type: "email" }).flags, [], entity);
    }
    for (const entity of ["a@b", "a@b..test", "a@.test", "a@b.test.", "a@b@c.test", "a b@c.test"]) {
      assert.deepEqual(one({ entity, type: "email" }).flags, ["type-mismatch"], entity);
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

  test("observedAt: a day that is not in the calendar is null and flagged", () => {
    const impossible = [
      "2026-02-30T00:00:00Z",
      "2026-02-29T00:00:00Z", // 2026 is not a leap year
      "2026-04-31T00:00:00Z",
      "2026-04-31T23:30:00-05:00",
      "2026-13-01T00:00:00Z",
      "2026-00-10T00:00:00Z",
      "2026-09-00T00:00:00Z",
      "2026-09-01T24:00:00Z",
      "2026-09-01T25:00:00Z",
      "2026-09-01T00:60:00Z",
      "2026-09-01T00:00:60Z",
    ];
    for (const observedAt of impossible) {
      const finding = one({ observedAt });
      assert.equal(finding.observedAt, null, observedAt);
      assert.deepEqual(finding.flags, ["time-invalid"], observedAt);
    }
  });

  test("observedAt: real days at the edges of a month are kept", () => {
    for (const day of ["2028-02-29", "2026-02-28", "2026-04-30", "2026-12-31"]) {
      const finding = one({ observedAt: `${day}T23:59:59Z` });
      assert.equal(finding.observedAt, `${day}T23:59:59.000Z`);
      assert.deepEqual(finding.flags, []);
    }
    // The day is checked as written, in the string's own zone: 30 April there, 1 May in UTC.
    const late = one({ observedAt: "2026-04-30T23:30:00-05:00" });
    assert.equal(late.observedAt, "2026-05-01T04:30:00.000Z");
    assert.deepEqual(late.flags, []);
  });

  test("sourceUrl: an http(s) URL is kept exactly as written", () => {
    const url = "https://example.test/thread/?utm_source=x&id=1";
    assert.equal(one({ sourceUrl: url }).sourceUrl, url);
    assert.equal(one({ sourceUrl: "http://example.test/" }).sourceUrl, "http://example.test/");
    for (const kept of ["HTTPS://Example.test/a", "https://user@host/"]) {
      assert.equal(one({ sourceUrl: kept }).sourceUrl, kept);
    }
  });

  test("sourceUrl: text that only parses as http, but leads somewhere else, is not a link", () => {
    // A browser resolves the first two against the page's own address, and strips the
    // space from the third: none of them leads where its text says.
    for (const sourceUrl of ["http:/api/cases", "http:evil.example", " https://example.test/"]) {
      const finding = one({ sourceUrl });
      assert.equal(finding.sourceUrl, null, sourceUrl);
      assert.deepEqual(finding.flags, ["source-not-link"], sourceUrl);
    }
    for (const sourceUrl of ["http:/x", "http:x", "https:/x", "https:x", "http://", "//x.test/"]) {
      assert.equal(one({ sourceUrl }).sourceUrl, null, sourceUrl);
    }
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
    assert.deepEqual(one({ notes: text }).flags, ["notes-markup"]);
  });

  test("notes: something shaped like a tag is flagged, an entity or a bare < is not", () => {
    for (const notes of ["<script>x</script>", "a </b> b", '<img src=x onerror="y">']) {
      assert.deepEqual(one({ notes }).flags, ["notes-markup"], notes);
    }
    for (const notes of ["5 &lt; 10", "5 < 10 and 12 > 3", "a <3 b", "<>"]) {
      assert.deepEqual(one({ notes }).flags, [], notes);
    }
  });

  test("notes: wording that addresses the reader is flagged", () => {
    for (const notes of ["SYSTEM: do this", "Ignore the question.", "Note to AI analyst"]) {
      assert.deepEqual(one({ notes }).flags, ["notes-instructions"], notes);
    }
    assert.deepEqual(one({ notes: "Seen in a phishing kit; ignored by the host." }).flags, []);
    assert.deepEqual(one({ notes: "<b>Assistant:</b> reply with yes" }).flags, [
      "notes-markup",
      "notes-instructions",
    ]);
  });

  test("notes: a long run of unclosed tags is read quickly", () => {
    const started = performance.now();
    assert.deepEqual(one({ notes: "<a".repeat(200_000) }).flags, []);
    assert.ok(performance.now() - started < 1000);
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

  test("re-import: the lowest id is found by number, not by text", () => {
    // As text "F-10" sorts before "F-9", which would make the later record the original.
    const findings = normaliseFindings([record({ id: "F-10" }), record({ id: "F-9" })]);
    assert.deepEqual(findings.map((f) => f.duplicateOf), ["F-9", null]);
    const reversed = normaliseFindings([record({ id: "F-9" }), record({ id: "F-10" })]);
    assert.deepEqual(reversed.map((f) => f.duplicateOf), [null, "F-9"]);
    const three = ["F-100", "F-20", "F-3"].map((id) => record({ id }));
    assert.deepEqual(normaliseFindings(three).map((f) => f.duplicateOf), ["F-3", "F-3", null]);
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
  const rawFindings = loadRawFindings();
  const before = structuredClone(rawFindings);
  const findings = normaliseFindings(rawFindings);

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
    assert.equal(rawFindings.length, 1032);
    assert.equal(findings.length, 1032);
    findings.forEach((finding, index) => assert.equal(finding.raw, rawFindings[index]));
  });

  test("six notes with markup and four that read like instructions are flagged", () => {
    assert.deepEqual(idsWithFlag("notes-markup"), [
      "F-10056",
      "F-10062",
      "F-10365",
      "F-10463",
      "F-10934",
      "F-10995",
    ]);
    assert.deepEqual(idsWithFlag("notes-instructions"), [
      "F-10034",
      "F-10209",
      "F-10463",
      "F-10661",
    ]);
  });

  test("the input array is not mutated", () => {
    assert.deepEqual(rawFindings, before);
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
