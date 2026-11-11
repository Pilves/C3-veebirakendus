// The one search function. The HTTP API and the MCP tools both call it, so they cannot
// disagree about what a query finds or in which order.
// Everything is held in memory and every query scans all findings: with about a thousand
// records that is fast, and there is no index that could go stale.
// The findings and the query are both untrusted text. They are only folded, compared and
// sliced here; nothing is run, and no regular expression is ever built from them.

import type { Finding, FindingType } from "../data/normalise.ts";

// A half-open range [start, end) in UTF-16 code units of the ORIGINAL string, so that
// original.slice(start, end) is exactly the text to highlight.
export type HighlightRange = { start: number; end: number };

// 0: entity equals the query, 1: entity starts with it, 2: some term is in the entity,
// 3: everything else (matched in the notes only, or an empty query).
export type Tier = 0 | 1 | 2 | 3;

export type SearchOptions = {
  query?: string;
  type?: FindingType;
  caseId?: string;
  includeDuplicates?: boolean; // default false: re-imported copies are hidden
  limit?: number; // default 50, kept within 1..200
  offset?: number; // default 0
};

export type SearchHit = {
  finding: Finding;
  tier: Tier;
  entityRanges: HighlightRange[]; // offsets into finding.entity
  notesRanges: HighlightRange[]; // offsets into finding.notes; empty when notes is null
};

export type SearchResult = {
  total: number; // matches before paging
  limit: number; // the values actually used, after clamping
  offset: number;
  truncated: boolean; // true when part of the query was ignored (too long, too many terms)
  hits: SearchHit[];
};

export type Search = (options?: SearchOptions) => SearchResult;

// ---------- folding ----------

// The folded text, plus for every folded code unit the range of the original string it
// came from. starts[i] and ends[i] belong to folded code unit i.
export type FoldedText = { text: string; starts: number[]; ends: number[] };

const COMBINING_MARKS = /\p{M}/gu;

// Lowercase, split letters from their accents (NFD), then drop the accents: "Ö" -> "o".
// Recall over precision on purpose: analysts often type without Estonian letters.
function foldCharacter(character: string): string {
  return character.toLowerCase().normalize("NFD").replace(COMBINING_MARKS, "");
}

// Folds one character at a time, because folding changes lengths: "Ö" as one code unit and
// "O" + combining dots as two both fold to "o", and an emoji is two code units. Without
// the position map a match found in the folded text could not be cut out of the original.
export function foldText(original: string): FoldedText {
  let text = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let position = 0;
  // for...of walks whole characters (code points), so an emoji is never cut in half.
  for (const character of original) {
    const end = position + character.length;
    const folded = foldCharacter(character);
    for (let i = 0; i < folded.length; i++) {
      starts.push(position);
      ends.push(end);
    }
    // A character that folds to nothing is a combining mark. It is drawn on the letter
    // before it, so that letter's range grows to cover it: a highlight must never
    // separate a letter from its accent.
    if (folded === "" && ends.length > 0) ends[ends.length - 1] = end;
    text += folded;
    position = end;
  }
  return { text, starts, ends };
}

// ---------- query ----------

// Cost guards: the work per finding grows with the query, and the query is user input.
const MAX_QUERY_LENGTH = 200; // UTF-16 code units, counted after trimming
const MAX_TERMS = 10;

type ParsedQuery = {
  terms: string[]; // folded, never empty strings
  phrase: string; // the terms joined by single spaces; the ranking compares against it
  truncated: boolean;
};

function parseQuery(query: string): ParsedQuery {
  const trimmed = query.trim();
  const folded = foldText(trimmed.slice(0, MAX_QUERY_LENGTH)).text;
  // A fixed pattern, not one built from the query. A query made only of combining marks
  // folds to "", which the filter removes: it then counts as an empty query.
  const allTerms = folded.split(/\s+/).filter((term) => term !== "");
  const terms = allTerms.slice(0, MAX_TERMS);
  return {
    terms,
    phrase: terms.join(" "),
    truncated: trimmed.length > MAX_QUERY_LENGTH || allTerms.length > MAX_TERMS,
  };
}

// ---------- matching and ranking ----------

// A finding with its searchable text folded once, at startup, instead of on every query.
type Prepared = { finding: Finding; entity: FoldedText; notes: FoldedText };

function prepare(finding: Finding): Prepared {
  return {
    finding,
    entity: foldText(finding.entity),
    notes: foldText(finding.notes ?? ""),
  };
}

// AND: every term must be somewhere, but each term may be in a different field.
// With no terms the loop never runs and everything matches: that is the browse mode.
function matchesAllTerms(item: Prepared, terms: string[]): boolean {
  for (const term of terms) {
    if (!item.entity.text.includes(term) && !item.notes.text.includes(term)) return false;
  }
  return true;
}

// Only called for findings that already matched all terms.
function tierOf(item: Prepared, query: ParsedQuery): Tier {
  // Checked first because every string starts with "", which would make browse tier 1.
  if (query.terms.length === 0) return 3;
  if (item.entity.text === query.phrase) return 0;
  if (item.entity.text.startsWith(query.phrase)) return 1;
  if (query.terms.some((term) => item.entity.text.includes(term))) return 2;
  return 3;
}

function passesFilters(finding: Finding, options: SearchOptions, caseId: string): boolean {
  if (options.includeDuplicates !== true && finding.duplicateOf !== null) return false;
  if (options.type !== undefined && finding.type !== options.type) return false;
  // A blank caseId means "no case filter", like a filter box left empty.
  if (caseId !== "" && !finding.caseIds.includes(caseId)) return false;
  return true;
}

type Ranked = { item: Prepared; tier: Tier };

// Best tier first, then newest first, then key, so the same query always gives the same
// order. observedAt is always the same UTC ISO format, which sorts correctly as text.
function compareRanked(a: Ranked, b: Ranked): number {
  if (a.tier !== b.tier) return a.tier - b.tier;
  const aDate = a.item.finding.observedAt;
  const bDate = b.item.finding.observedAt;
  if (aDate !== bDate) {
    if (aDate === null) return 1;
    if (bDate === null) return -1;
    return aDate > bDate ? -1 : 1;
  }
  // Plain comparison, not localeCompare: the order must not depend on the machine's locale.
  if (a.item.finding.key === b.item.finding.key) return 0;
  return a.item.finding.key < b.item.finding.key ? -1 : 1;
}

// ---------- highlights ----------

function occurrencesOf(term: string, folded: FoldedText): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  let at = folded.text.indexOf(term);
  while (at !== -1) {
    const last = at + term.length - 1;
    // "?? 0" only satisfies the type checker: at and last are always inside the arrays.
    ranges.push({ start: folded.starts[at] ?? 0, end: folded.ends[last] ?? 0 });
    // Step by one, not by the term length, so overlapping occurrences are found too.
    at = folded.text.indexOf(term, at + 1);
  }
  return ranges;
}

// Sorted, with overlapping or touching ranges joined, so the UI can walk the string once
// and never has to highlight the same character twice.
function mergeRanges(ranges: HighlightRange[]): HighlightRange[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: HighlightRange[] = [];
  for (const range of sorted) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ start: range.start, end: range.end });
    }
  }
  return merged;
}

function highlightsOf(terms: string[], folded: FoldedText): HighlightRange[] {
  const ranges: HighlightRange[] = [];
  for (const term of terms) ranges.push(...occurrencesOf(term, folded));
  return mergeRanges(ranges);
}

// ---------- paging ----------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// The values may come straight from a URL, so anything that is not a whole number
// (undefined, NaN, Infinity, 2.5) falls back to the default instead of being guessed at.
function wholeNumberOr(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) ? value : fallback;
}

function limitOf(value: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, wholeNumberOr(value, DEFAULT_LIMIT)));
}

function offsetOf(value: number | undefined): number {
  return Math.max(0, wholeNumberOr(value, 0));
}

// ---------- the search ----------

// Folds every finding once and returns the search function that uses the folded copies.
// The findings themselves are not copied or changed. The returned function never throws
// on any query string.
export function createSearch(findings: Finding[]): Search {
  const prepared = findings.map(prepare);

  return function search(options: SearchOptions = {}): SearchResult {
    const query = parseQuery(options.query ?? "");
    // caseIds are stored trimmed and uppercase, so the filter value gets the same treatment.
    const caseId = (options.caseId ?? "").trim().toUpperCase();

    const ranked: Ranked[] = [];
    for (const item of prepared) {
      if (!passesFilters(item.finding, options, caseId)) continue;
      if (!matchesAllTerms(item, query.terms)) continue;
      ranked.push({ item, tier: tierOf(item, query) });
    }
    ranked.sort(compareRanked);

    const limit = limitOf(options.limit);
    const offset = offsetOf(options.offset);
    // Highlights are worked out for the requested page only, not for every match.
    const hits = ranked.slice(offset, offset + limit).map(({ item, tier }) => ({
      finding: item.finding,
      tier,
      entityRanges: highlightsOf(query.terms, item.entity),
      notesRanges: highlightsOf(query.terms, item.notes),
    }));
    return { total: ranked.length, limit, offset, truncated: query.truncated, hits };
  };
}
