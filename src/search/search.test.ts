import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { normaliseFindings, VALID_TYPES } from "../data/normalise.ts";
import type { Finding, FindingType } from "../data/normalise.ts";
import { createSearch, foldText } from "./search.ts";
import type { HighlightRange, Search, SearchResult } from "./search.ts";

type Raw = { [name: string]: unknown };

// Builds findings from small raw records. Each record gets its own id (T-1, T-2, ...)
// unless it sets one, so two records are never taken for the same finding by accident.
function findingsOf(records: Raw[]): Finding[] {
  const raws = records.map((overrides, index) => ({
    id: `T-${index + 1}`,
    caseId: "C-1",
    entity: "example.test",
    type: "domain",
    sourceUrl: "https://example.test/page",
    observedAt: "2026-09-01T00:00:00Z",
    notes: null,
    ...overrides,
  }));
  return normaliseFindings(raws);
}

function searchOf(records: Raw[]): Search {
  return createSearch(findingsOf(records));
}

function keysOf(result: SearchResult): string[] {
  return result.hits.map((hit) => hit.finding.key);
}

function slicesOf(original: string, ranges: HighlightRange[]): string[] {
  return ranges.map((range) => original.slice(range.start, range.end));
}

// The highlighted pieces of the entity of a single finding.
function entitySlices(entity: string, query: string): string[] {
  const hit = searchOf([{ entity, type: "alias" }])({ query }).hits[0];
  assert.ok(hit !== undefined, `"${query}" should find the entity`);
  return slicesOf(hit.finding.entity, hit.entityRanges);
}

// The same for the notes.
function notesSlices(notes: string, query: string): string[] {
  const hit = searchOf([{ notes }])({ query }).hits[0];
  assert.ok(hit !== undefined, `"${query}" should find the notes`);
  return slicesOf(hit.finding.notes ?? "", hit.notesRanges);
}

const COMBINING_DIAERESIS = "̈";
const COMBINING_ACUTE = "́";
const OWL = "\u{1F989}"; // an astral character: two UTF-16 code units
const DOTTED_CAPITAL_I = "İ"; // its lowercase is two code units: i + combining dot

// ======================================================================================
// Part 1: folding
// ======================================================================================

describe("foldText", () => {
  test("lowercases and removes diacritics", () => {
    assert.equal(foldText("Öökull").text, "ookull");
    assert.equal(foldText("Šokolaadimees").text, "sokolaadimees");
    assert.equal(foldText("õäöüšž").text, "oaousz");
    assert.equal(foldText("ÕÄÖÜŠŽ").text, "oaousz");
  });

  test("precomposed and decomposed forms fold to the same text", () => {
    const precomposed = "Öökull";
    const decomposed = precomposed.normalize("NFD");
    assert.notEqual(precomposed, decomposed);
    assert.equal(foldText(decomposed).text, foldText(precomposed).text);
  });

  test("the map has one entry per folded code unit", () => {
    for (const original of ["", "Öö", `O${COMBINING_DIAERESIS}`, OWL, DOTTED_CAPITAL_I]) {
      const folded = foldText(original);
      assert.equal(folded.starts.length, folded.text.length);
      assert.equal(folded.ends.length, folded.text.length);
    }
  });

  test("a precomposed letter maps to one code unit, a decomposed one to two", () => {
    assert.deepEqual(foldText("Ö"), { text: "o", starts: [0], ends: [1] });
    assert.deepEqual(foldText(`O${COMBINING_DIAERESIS}`), { text: "o", starts: [0], ends: [2] });
  });

  test("text with nothing to fold maps to itself", () => {
    assert.deepEqual(foldText("abc"), { text: "abc", starts: [0, 1, 2], ends: [1, 2, 3] });
  });
});

// ======================================================================================
// Part 2: synthetic findings, one rule at a time
// ======================================================================================

describe("matching", () => {
  test("a query without diacritics finds text with them", () => {
    const search = searchOf([{ entity: "Öökull", type: "alias" }, { entity: "Šokolaadimees" }]);
    assert.deepEqual(keysOf(search({ query: "oo" })), ["T-1"]);
    assert.deepEqual(keysOf(search({ query: "sokolaad" })), ["T-2"]);
  });

  test("a query with diacritics finds text without them", () => {
    const search = searchOf([{ entity: "ookean", type: "alias" }, { notes: "SOKOLAAD" }]);
    assert.deepEqual(keysOf(search({ query: "öö" })), ["T-1"]);
    assert.deepEqual(keysOf(search({ query: "Šokolaad" })), ["T-2"]);
  });

  test("letter case is ignored in both directions", () => {
    const search = searchOf([{ entity: "MixedCase.test" }]);
    assert.equal(search({ query: "mixedcase" }).total, 1);
    assert.equal(search({ query: "MIXEDCASE" }).total, 1);
  });

  test("a term matches anywhere inside a word", () => {
    const search = searchOf([{ entity: "kalamees", type: "alias" }]);
    assert.equal(search({ query: "ame" }).total, 1);
  });

  test("all terms must match, each in the entity or in the notes", () => {
    const search = searchOf([
      { entity: "alpha.test", notes: "bravo was seen" },
      { entity: "alpha-two.test", notes: null },
      { entity: "other.test", notes: "alpha and bravo" },
    ]);
    assert.deepEqual(keysOf(search({ query: "alpha bravo" })).sort(), ["T-1", "T-3"]);
    assert.deepEqual(keysOf(search({ query: "bravo alpha" })).sort(), ["T-1", "T-3"]);
    assert.equal(search({ query: "alpha charlie" }).total, 0);
  });

  test("null notes are searched as empty text", () => {
    const search = searchOf([{ entity: "alpha.test", notes: null }]);
    assert.equal(search({ query: "alpha" }).total, 1);
    assert.deepEqual(search({ query: "alpha" }).hits[0]?.notesRanges, []);
    assert.equal(search({ query: "null" }).total, 0);
  });

  test("regular expression characters in the query are plain text", () => {
    const search = searchOf([
      { entity: "x.*y", type: "alias" },
      { entity: "xaay", type: "alias" },
    ]);
    assert.deepEqual(keysOf(search({ query: ".*" })), ["T-1"]);
    assert.equal(search({ query: "x.y" }).total, 0);
  });
});

describe("ranking", () => {
  // The dates run against the tiers (best tier is oldest), so the test fails if the
  // date were compared first.
  const search = searchOf([
    { entity: "x.test", notes: "kala was mentioned", observedAt: "2026-09-04T00:00:00Z" },
    { entity: "suur kala", type: "alias", observedAt: "2026-09-03T00:00:00Z" },
    { entity: "kalamees", type: "alias", observedAt: "2026-09-02T00:00:00Z" },
    { entity: "Kala", type: "alias", observedAt: "2026-09-01T00:00:00Z" },
    { entity: "unrelated.test" },
  ]);

  test("exact entity, then prefix, then inside the entity, then notes only", () => {
    const result = search({ query: "kala" });
    assert.deepEqual(keysOf(result), ["T-4", "T-3", "T-2", "T-1"]);
    assert.deepEqual(result.hits.map((hit) => hit.tier), [0, 1, 2, 3]);
    assert.equal(result.total, 4);
  });

  test("the whole query is compared, with inner whitespace collapsed", () => {
    const exact = search({ query: "  SUUR \t  kala " });
    assert.equal(exact.hits[0]?.finding.key, "T-2");
    assert.equal(exact.hits[0]?.tier, 0);

    const prefix = search({ query: "suur k" });
    assert.equal(prefix.hits[0]?.tier, 1);
  });

  test("terms in another order still match, but only as tier 2", () => {
    const result = search({ query: "kala suur" });
    assert.deepEqual(keysOf(result), ["T-2"]);
    assert.equal(result.hits[0]?.tier, 2);
  });

  test("one term in the entity is enough for tier 2", () => {
    const mixed = searchOf([{ entity: "alpha.test", notes: "bravo" }]);
    assert.equal(mixed({ query: "bravo alpha" }).hits[0]?.tier, 2);
  });

  test("inside a tier: newest first, no date last, then by key", () => {
    const tied = searchOf([
      { id: "T-4", entity: "tie-d.test", observedAt: "not a date" },
      { id: "T-1", entity: "tie-a.test", observedAt: "2026-01-01T00:00:00Z" },
      { id: "T-5", entity: "tie-e.test", observedAt: "2026-03-01T00:00:00Z" },
      { id: "T-3", entity: "tie-c.test", observedAt: null },
      { id: "T-2", entity: "tie-b.test", observedAt: "2026-03-01T00:00:00Z" },
    ]);
    const result = tied({ query: "tie" });
    // Every entity starts with the query, so all five share tier 1.
    assert.deepEqual(result.hits.map((hit) => hit.tier), [1, 1, 1, 1, 1]);
    assert.deepEqual(keysOf(result), ["T-2", "T-5", "T-1", "T-3", "T-4"]);
  });
});

describe("highlight offsets", () => {
  test("a precomposed letter", () => {
    assert.deepEqual(entitySlices("Öökull", "oo"), ["Öö"]);
  });

  test("a decomposed letter keeps its combining mark inside the range", () => {
    const doubleO = `O${COMBINING_DIAERESIS}o${COMBINING_DIAERESIS}`;
    const decomposed = `${doubleO}kull`;
    assert.equal(doubleO.length, 4);
    assert.deepEqual(entitySlices(decomposed, "oo"), [doubleO]);
    assert.deepEqual(entitySlices(decomposed, "kull"), ["kull"]);
  });

  test("a query with diacritics against plain text", () => {
    assert.deepEqual(entitySlices("ookean", "öö"), ["oo"]);
    const decomposedQuery = `o${COMBINING_DIAERESIS}O${COMBINING_DIAERESIS}`;
    assert.deepEqual(entitySlices("ookean", decomposedQuery), ["oo"]);
  });

  test("õ ä ö ü š ž in both cases and both forms", () => {
    const letters = ["õ", "ä", "ö", "ü", "š", "ž", "Õ", "Ä", "Ö", "Ü", "Š", "Ž"];
    for (const letter of letters) {
      const decomposed = letter.normalize("NFD");
      const base = foldText(letter).text;
      assert.equal(decomposed.length, 2, `${letter} decomposes to base + mark`);
      assert.equal(base.length, 1);

      // Typed without the diacritic, with it, and with it in the other form.
      for (const query of [base, letter, decomposed]) {
        assert.deepEqual(entitySlices(`x${letter}y`, query), [letter]);
        assert.deepEqual(entitySlices(`x${decomposed}y`, query), [decomposed]);
      }
      // The text after the letter is still cut at the right place.
      assert.deepEqual(entitySlices(`x${letter}yz`, "yz"), ["yz"]);
      assert.deepEqual(entitySlices(`x${decomposed}yz`, "yz"), ["yz"]);
    }
  });

  test("a match at the very start and at the very end", () => {
    const entity = "Õun ja teine õun";
    const hit = searchOf([{ entity, type: "alias" }])({ query: "oun" }).hits[0];
    assert.ok(hit !== undefined);
    assert.deepEqual(hit.entityRanges, [
      { start: 0, end: 3 },
      { start: entity.length - 3, end: entity.length },
    ]);
    assert.deepEqual(slicesOf(entity, hit.entityRanges), ["Õun", "õun"]);
  });

  test("the whole string as one match", () => {
    assert.deepEqual(entitySlices("Žürii", "zurii"), ["Žürii"]);
  });

  test("a match that ends just before a combining mark takes the mark along", () => {
    // Otherwise the UI would put the letter and its accent into different text nodes.
    const entity = `cafe${COMBINING_ACUTE} bar`;
    assert.deepEqual(entitySlices(entity, "cafe"), [`cafe${COMBINING_ACUTE}`]);
    assert.deepEqual(entitySlices(entity, "e"), [`e${COMBINING_ACUTE}`]);
    assert.deepEqual(entitySlices(entity, "caf"), ["caf"]);
    assert.deepEqual(entitySlices(entity, "bar"), ["bar"]);
  });

  test("a match at the end of the string that ends in a combining mark", () => {
    const entity = `kohvik cafe${COMBINING_ACUTE}`;
    const hit = searchOf([{ entity, type: "alias" }])({ query: "cafe" }).hits[0];
    assert.deepEqual(hit?.entityRanges, [{ start: 7, end: entity.length }]);
  });

  test("an astral character before the match shifts the offsets by two", () => {
    const entity = `${OWL} Öökull`;
    const hit = searchOf([{ entity, type: "alias" }])({ query: "kull" }).hits[0];
    assert.deepEqual(hit?.entityRanges, [{ start: 5, end: 9 }]);
    assert.deepEqual(entitySlices(entity, "kull"), ["kull"]);
    assert.deepEqual(entitySlices(entity, "oo"), ["Öö"]);
  });

  test("an astral character can be searched and is never cut in half", () => {
    const entity = `x${OWL}y`;
    assert.deepEqual(entitySlices(entity, OWL), [OWL]);
    // Half of the surrogate pair as a query: the range still covers the whole character.
    assert.deepEqual(entitySlices(entity, OWL.slice(0, 1)), [OWL]);
    assert.deepEqual(entitySlices(entity, OWL.slice(1)), [OWL]);
  });

  test("a letter whose lowercase is longer than the letter", () => {
    assert.equal(DOTTED_CAPITAL_I.toLowerCase().length, 2);
    const entity = `${DOTTED_CAPITAL_I}stanbul ${DOTTED_CAPITAL_I}${DOTTED_CAPITAL_I}x`;
    assert.deepEqual(entitySlices(entity, "istanbul"), [`${DOTTED_CAPITAL_I}stanbul`]);
    assert.deepEqual(entitySlices(entity, "x"), ["x"]);
    assert.deepEqual(entitySlices(entity, "iix"), [`${DOTTED_CAPITAL_I}${DOTTED_CAPITAL_I}x`]);
    assert.deepEqual(entitySlices(entity, "stanbul"), ["stanbul"]);
  });

  test("a character that folds to several code units is highlighted whole", () => {
    // A Hangul syllable decomposes into three letters, none of them a combining mark.
    const syllable = "한";
    assert.equal(foldText(syllable).text.length, 3);
    const entity = `a${syllable}b`;
    assert.deepEqual(entitySlices(entity, foldText(syllable).text.slice(0, 1)), [syllable]);
    assert.deepEqual(entitySlices(entity, "b"), ["b"]);
  });

  test("offsets in the notes refer to the notes", () => {
    const notes = `${OWL} nähti: Öökull ja ŠOKOLAAD`;
    assert.deepEqual(notesSlices(notes, "ookull"), ["Öökull"]);
    assert.deepEqual(notesSlices(notes, "sokolaad nahti"), ["nähti", "ŠOKOLAAD"]);
  });

  test("each field gets only its own ranges", () => {
    const hit = searchOf([{ entity: "alpha.test", notes: "bravo and alpha" }])({
      query: "alpha bravo",
    }).hits[0];
    assert.deepEqual(hit?.entityRanges, [{ start: 0, end: 5 }]);
    assert.deepEqual(hit?.notesRanges, [
      { start: 0, end: 5 },
      { start: 10, end: 15 },
    ]);
  });

  test("every occurrence of a term is reported, in order", () => {
    assert.deepEqual(entitySlices("ab x AB x ab", "ab"), ["ab", "AB", "ab"]);
  });

  test("overlapping ranges of two terms are merged", () => {
    const hit = searchOf([{ entity: "abcdef", type: "alias" }])({ query: "cde abc" }).hits[0];
    assert.deepEqual(hit?.entityRanges, [{ start: 0, end: 5 }]);
  });

  test("a term that overlaps itself gives one range", () => {
    const hit = searchOf([{ entity: "aaa", type: "alias" }])({ query: "aa" }).hits[0];
    assert.deepEqual(hit?.entityRanges, [{ start: 0, end: 3 }]);
  });

  test("touching ranges are merged, separate ones are not", () => {
    const hit = searchOf([{ entity: "abab ab", type: "alias" }])({ query: "ab" }).hits[0];
    assert.deepEqual(hit?.entityRanges, [
      { start: 0, end: 4 },
      { start: 5, end: 7 },
    ]);
  });

  test("a range inside another one disappears into it", () => {
    const hit = searchOf([{ entity: "abcdef", type: "alias" }])({ query: "abcdef cd" }).hits[0];
    assert.deepEqual(hit?.entityRanges, [{ start: 0, end: 6 }]);
  });
});

describe("filters", () => {
  const search = searchOf([
    { entity: "one.test", type: "domain", caseId: "C-1" },
    { entity: "10.0.0.1", type: "ip", caseId: "C-2" },
    { entity: "someone", type: "handle", caseId: ["C-1", "C-2"] },
    { entity: "mystery", type: "banana", caseId: "C-3" },
  ]);

  test("type", () => {
    assert.deepEqual(keysOf(search({ type: "ip" })), ["T-2"]);
    assert.deepEqual(keysOf(search({ type: "unknown" })), ["T-4"]);
    assert.equal(search({ type: "wallet" }).total, 0);
  });

  test("caseId, trimmed and in any letter case", () => {
    assert.deepEqual(keysOf(search({ caseId: "C-2" })).sort(), ["T-2", "T-3"]);
    assert.deepEqual(keysOf(search({ caseId: "  c-2 " })).sort(), ["T-2", "T-3"]);
    assert.equal(search({ caseId: "C-9" }).total, 0);
    // Only whole case ids match, not parts of them.
    assert.equal(search({ caseId: "C-" }).total, 0);
  });

  test("a blank caseId is no filter", () => {
    assert.equal(search({ caseId: "" }).total, 4);
    assert.equal(search({ caseId: "   " }).total, 4);
  });

  test("filters and the query are combined with AND", () => {
    assert.deepEqual(keysOf(search({ caseId: "C-2", type: "handle" })), ["T-3"]);
    assert.equal(search({ caseId: "C-2", type: "domain" }).total, 0);
    assert.deepEqual(keysOf(search({ query: "one", caseId: "C-1" })).sort(), ["T-1", "T-3"]);
    assert.deepEqual(keysOf(search({ query: "one", caseId: "C-1", type: "domain" })), ["T-1"]);
  });

  test("the query does not search case ids or ids", () => {
    assert.equal(search({ query: "C-2" }).total, 0);
    assert.equal(search({ query: "T-1" }).total, 0);
  });
});

describe("duplicates", () => {
  const search = searchOf([
    { id: "T-1", entity: "copy.test", notes: "same" },
    { id: "T-2", entity: "copy.test", notes: "same" },
    { id: "T-3", entity: "single.test" },
  ]);

  test("re-imported copies are hidden by default", () => {
    assert.deepEqual(keysOf(search({ query: "copy" })), ["T-1"]);
    assert.equal(search().total, 2);
    assert.equal(search({ includeDuplicates: false }).total, 2);
  });

  test("and shown on request", () => {
    const result = search({ query: "copy", includeDuplicates: true });
    assert.deepEqual(keysOf(result), ["T-1", "T-2"]);
    assert.equal(result.hits[1]?.finding.duplicateOf, "T-1");
    assert.equal(search({ includeDuplicates: true }).total, 3);
  });
});

describe("paging", () => {
  // Five findings with different dates, so the full order is T-5, T-4, T-3, T-2, T-1.
  const search = searchOf(
    [1, 2, 3, 4, 5].map((day) => ({
      entity: `page-${day}.test`,
      observedAt: `2026-09-0${day}T00:00:00Z`,
    })),
  );

  test("limit and offset cut a page out of the ordered matches", () => {
    assert.deepEqual(keysOf(search({ limit: 2 })), ["T-5", "T-4"]);
    assert.deepEqual(keysOf(search({ limit: 2, offset: 2 })), ["T-3", "T-2"]);
    assert.deepEqual(keysOf(search({ limit: 2, offset: 4 })), ["T-1"]);
  });

  test("total counts all matches, not the page", () => {
    assert.equal(search({ limit: 2, offset: 2 }).total, 5);
    assert.equal(search({ query: "page-1 page", limit: 1 }).total, 1);
  });

  test("an offset past the end gives an empty page and the real total", () => {
    const result = search({ offset: 99 });
    assert.deepEqual(result.hits, []);
    assert.equal(result.total, 5);
    assert.equal(result.offset, 99);
  });

  test("the defaults are limit 50 and offset 0", () => {
    const result = search();
    assert.equal(result.limit, 50);
    assert.equal(result.offset, 0);
  });

  test("limit is kept within 1..200", () => {
    assert.equal(search({ limit: 0 }).limit, 1);
    assert.equal(search({ limit: -3 }).limit, 1);
    assert.equal(search({ limit: -3 }).hits.length, 1);
    assert.equal(search({ limit: 200 }).limit, 200);
    assert.equal(search({ limit: 201 }).limit, 200);
    assert.equal(search({ limit: 1e9 }).limit, 200);
  });

  test("a limit that is not a whole number falls back to 50", () => {
    for (const limit of [2.5, NaN, Infinity, -Infinity]) {
      assert.equal(search({ limit }).limit, 50);
    }
  });

  test("a bad offset falls back to 0", () => {
    for (const offset of [-1, -1e9, 1.5, NaN, Infinity, -Infinity]) {
      const result = search({ offset, limit: 2 });
      assert.equal(result.offset, 0);
      assert.deepEqual(keysOf(result), ["T-5", "T-4"]);
    }
  });

  test("values of the wrong type from an untyped caller fall back too", () => {
    const untyped = { limit: "10", offset: null } as unknown as { limit: number; offset: number };
    const result = search(untyped);
    assert.equal(result.limit, 50);
    assert.equal(result.offset, 0);
  });
});

describe("empty query", () => {
  const search = searchOf([
    { entity: "old.test", observedAt: "2026-01-01T00:00:00Z", notes: "some text" },
    { entity: "new.test", observedAt: "2026-02-01T00:00:00Z" },
    { entity: "", observedAt: "2026-03-01T00:00:00Z" },
  ]);

  test("matches everything, newest first, as tier 3 without highlights", () => {
    for (const query of ["", "   ", " \t\n "]) {
      const result = search({ query });
      assert.deepEqual(keysOf(result), ["T-3", "T-2", "T-1"]);
      assert.equal(result.truncated, false);
      for (const hit of result.hits) {
        assert.equal(hit.tier, 3);
        assert.deepEqual(hit.entityRanges, []);
        assert.deepEqual(hit.notesRanges, []);
      }
    }
  });

  test("no options at all is the same as an empty query", () => {
    assert.deepEqual(search(), search({ query: "" }));
    assert.deepEqual(search({}), search({ query: "" }));
  });

  test("a query of only combining marks folds to nothing and counts as empty", () => {
    const result = search({ query: COMBINING_ACUTE + COMBINING_DIAERESIS });
    assert.equal(result.total, 3);
    assert.equal(result.hits[0]?.tier, 3);
  });
});

describe("hostile queries", () => {
  const search = searchOf([
    { entity: "example.test", notes: "plain note" },
    { entity: "Öökull", type: "alias", notes: null },
    { entity: `x${OWL}y`, type: "alias", notes: `e${COMBINING_ACUTE}` },
  ]);

  const hostile = [
    "a".repeat(100_000),
    "a ".repeat(50_000),
    " ".repeat(100_000),
    COMBINING_ACUTE.repeat(10_000),
    `a${COMBINING_ACUTE.repeat(10_000)}`,
    "\u0000",
    "\u0000\u0001\u001f\u007f",
    "\ud800",
    "\udc00",
    "\udc00\ud800 x",
    `${OWL.slice(0, 1)} ${OWL.slice(1)}`,
    ".*+?^${}()|[]\\",
    "(a+)+$",
    "[",
    "\\",
    "%00 %s %n",
    "‮​﻿",
    "__proto__ constructor toString",
    "<b>&amp;",
    DOTTED_CAPITAL_I.repeat(300),
  ];

  test("never throw and always give a well-formed result", () => {
    for (const query of hostile) {
      const result = search({ query, includeDuplicates: true });
      assert.ok(result.total >= 0 && result.total <= 3);
      assert.ok(result.hits.length <= result.total);
      assert.equal(typeof result.truncated, "boolean");
    }
  });

  test("highlight ranges stay inside the original strings", () => {
    for (const query of hostile) {
      for (const hit of search({ query }).hits) {
        const notes = hit.finding.notes ?? "";
        for (const range of hit.entityRanges) {
          assert.ok(0 <= range.start && range.start < range.end);
          assert.ok(range.end <= hit.finding.entity.length);
        }
        for (const range of hit.notesRanges) {
          assert.ok(0 <= range.start && range.start < range.end);
          assert.ok(range.end <= notes.length);
        }
      }
    }
  });
});

describe("query guard", () => {
  const search = searchOf([
    { entity: "kala", type: "alias" },
    { entity: "abcdefghij", type: "alias" },
    { entity: "a".repeat(250), type: "alias" },
  ]);

  test("a query of exactly 200 characters is used whole", () => {
    const result = search({ query: "a".repeat(200) });
    assert.equal(result.truncated, false);
    assert.deepEqual(keysOf(result), ["T-3"]);
  });

  test("everything after 200 characters is ignored, and the result says so", () => {
    // Whole, this query would not match: T-3 has no "b". Cut to its first 200 it does.
    const result = search({ query: "a".repeat(200) + "b" });
    assert.equal(result.truncated, true);
    assert.deepEqual(keysOf(result), ["T-3"]);
  });

  test("a term that starts after the 200th character is dropped", () => {
    const result = search({ query: "kala" + " ".repeat(200) + "zzz" });
    assert.equal(result.truncated, true);
    assert.deepEqual(keysOf(result), ["T-1"]);
    assert.equal(result.hits[0]?.tier, 0);
  });

  test("the 200 are counted after trimming", () => {
    const result = search({ query: " ".repeat(500) + "kala" + " ".repeat(500) });
    assert.equal(result.truncated, false);
    assert.deepEqual(keysOf(result), ["T-1"]);
  });

  test("ten terms are all used", () => {
    const result = search({ query: "a b c d e f g h i j" });
    assert.equal(result.truncated, false);
    assert.deepEqual(keysOf(result), ["T-2"]);
    assert.equal(search({ query: "a b c d e f g h i zzz" }).total, 0);
  });

  test("terms after the tenth are ignored, and the result says so", () => {
    const result = search({ query: "a b c d e f g h i j zzz" });
    assert.equal(result.truncated, true);
    assert.deepEqual(keysOf(result), ["T-2"]);
  });
});

describe("createSearch", () => {
  test("no findings give an empty result", () => {
    const result = createSearch([])({ query: "anything" });
    assert.deepEqual(result, { total: 0, limit: 50, offset: 0, truncated: false, hits: [] });
  });

  test("hits carry the finding objects that were passed in, unchanged", () => {
    const findings = findingsOf([{ entity: "Öökull", type: "alias", notes: "Märkus" }]);
    const before = structuredClone(findings);
    const hit = createSearch(findings)({ query: "ookull markus" }).hits[0];
    assert.equal(hit?.finding, findings[0]);
    assert.deepEqual(findings, before);
  });
});

// ======================================================================================
// Part 3: the real dataset. It is untrusted, so the tests only use ids, keys and counts.
// ======================================================================================

describe("real dataset", () => {
  const dataPath = new URL("../../data/findings.json", import.meta.url);
  const data: { findings: unknown[] } = JSON.parse(readFileSync(dataPath, "utf8"));
  const findings = normaliseFindings(data.findings);
  const originals = findings.filter((finding) => finding.duplicateOf === null);
  const search = createSearch(findings);

  // Spread over the file; the entities are read at runtime, never written down here.
  const picked = [0, 250, 500, 750, 1000].map((index) => {
    const finding = originals[index];
    assert.ok(finding !== undefined);
    return finding;
  });

  test("an empty query returns every finding, without the re-imports by default", () => {
    assert.equal(search().total, 1002);
    assert.equal(search({ includeDuplicates: true }).total, 1032);
    assert.equal(search().hits.length, 50);
  });

  test("each type filter returns as many findings as a direct count", () => {
    const types: FindingType[] = [...VALID_TYPES, "unknown"];
    let sum = 0;
    for (const type of types) {
      const expected = originals.filter((finding) => finding.type === type).length;
      assert.equal(search({ type }).total, expected, type);
      sum += expected;
    }
    assert.equal(sum, 1002);
  });

  test("a case filter returns as many findings as a direct count", () => {
    for (const finding of picked) {
      const caseId = finding.caseIds[0];
      if (caseId === undefined) continue;
      const expected = originals.filter((other) => other.caseIds.includes(caseId)).length;
      assert.equal(search({ caseId: caseId.toLowerCase() }).total, expected, finding.key);
    }
  });

  test("searching an exact entity puts a tier 0 hit for it first", () => {
    for (const finding of picked) {
      const result = search({ query: finding.entity, limit: 200 });
      assert.equal(result.truncated, false, finding.key);
      const first = result.hits[0];
      assert.ok(first !== undefined, finding.key);
      assert.equal(first.tier, 0, finding.key);
      assert.equal(foldText(first.finding.entity).text, foldText(finding.entity).text);
      assert.deepEqual(first.entityRanges, [{ start: 0, end: first.finding.entity.length }]);

      // Several findings can share an entity; the picked one must be among the tier 0 hits.
      const exact = result.hits.filter((hit) => hit.tier === 0).map((hit) => hit.finding.key);
      assert.ok(exact.includes(finding.key), finding.key);
    }
  });

  test("tiers never go down and the order inside a tier holds", () => {
    for (const finding of picked) {
      const hits = search({ query: finding.entity.slice(0, 3), limit: 200 }).hits;
      for (let i = 1; i < hits.length; i++) {
        const previous = hits[i - 1];
        const current = hits[i];
        assert.ok(previous !== undefined && current !== undefined);
        assert.ok(previous.tier <= current.tier);
        if (previous.tier !== current.tier) continue;
        const previousDate = previous.finding.observedAt;
        const currentDate = current.finding.observedAt;
        if (previousDate === null) assert.equal(currentDate, null);
        if (previousDate !== null && currentDate !== null) assert.ok(previousDate >= currentDate);
        if (previousDate === currentDate) assert.ok(previous.finding.key < current.finding.key);
      }
    }
  });

  // Merging can join several occurrences into one range, so a range does not always fold
  // to exactly one term. What always holds: it starts with a term and ends with a term.
  function assertRangesFoldToTerms(original: string, ranges: HighlightRange[], terms: string[]) {
    let previousEnd = -1;
    for (const range of ranges) {
      assert.ok(range.start > previousEnd, "ranges are sorted and do not touch");
      assert.ok(range.start < range.end && range.end <= original.length);
      previousEnd = range.end;
      const folded = foldText(original.slice(range.start, range.end)).text;
      assert.ok(terms.some((term) => folded.startsWith(term)));
      assert.ok(terms.some((term) => folded.endsWith(term)));
      // The usual case, nothing merged: the range is exactly one term.
      const longest = Math.max(...terms.map((term) => term.length));
      if (folded.length <= longest) assert.ok(terms.includes(folded) || terms.length > 1);
    }
  }

  test("every highlight range slices to text that folds to the terms", () => {
    const queries = ["oo", "a", "e", "ee", ".", "ja", "on", "test", "com 1", "ÕÄ", "s a"];
    for (const finding of picked) {
      queries.push(finding.entity, finding.entity.slice(0, 4), finding.entity.slice(-3));
    }
    let rangesSeen = 0;
    for (const query of queries) {
      const terms = foldText(query).text.split(/\s+/).filter((term) => term !== "");
      const result = search({ query, limit: 200, includeDuplicates: true });
      for (const hit of result.hits) {
        assertRangesFoldToTerms(hit.finding.entity, hit.entityRanges, terms);
        assertRangesFoldToTerms(hit.finding.notes ?? "", hit.notesRanges, terms);
        rangesSeen += hit.entityRanges.length + hit.notesRanges.length;
        // A hit always shows why it matched.
        assert.ok(hit.entityRanges.length + hit.notesRanges.length > 0, hit.finding.key);
      }
    }
    assert.ok(rangesSeen > 100, "the sample queries should exercise many ranges");
  });

  test("the same query gives the same result every time", () => {
    const again = createSearch(normaliseFindings(data.findings));
    for (const query of ["", "a", "oo", "e e", picked[0]?.entity ?? ""]) {
      const first = search({ query, limit: 200 });
      assert.deepEqual(keysOf(search({ query, limit: 200 })), keysOf(first));
      assert.deepEqual(keysOf(again({ query, limit: 200 })), keysOf(first));
      assert.equal(again({ query, limit: 200 }).total, first.total);
    }
  });

  test("the pages of a query add up to the whole result without repeats", () => {
    const keys: string[] = [];
    for (let offset = 0; offset < 1002; offset += 200) {
      keys.push(...keysOf(search({ limit: 200, offset })));
    }
    assert.equal(keys.length, 1002);
    assert.equal(new Set(keys).size, 1002);
  });
});
