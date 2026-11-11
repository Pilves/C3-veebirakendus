// The one search function. The HTTP API and the MCP tools both call it, so they cannot
// disagree about what a query finds or in which order.
// Everything is held in memory and every query scans all findings: with about a thousand
// records that is fast, and there is no index that could go stale.
// The findings and the query are both untrusted text. They are only folded, compared and
// sliced here; nothing is run, and no regular expression is ever built from them.

import { ALL_TYPES, FLAGS } from "../data/normalise.ts";
import type { Finding, FindingType, Flag } from "../data/normalise.ts";

// A half-open range [start, end) in UTF-16 code units of the ORIGINAL string, so that
// original.slice(start, end) is exactly the text to highlight.
export type HighlightRange = { start: number; end: number };

// 0: entity, id or key equals the query, 1: entity starts with it, 2: some term is in the
// entity, 3: everything else (matched in the notes only, or an empty query).
export type Tier = 0 | 1 | 2 | 3;

export type SearchOptions = {
  query?: string;
  type?: FindingType;
  caseId?: string;
  flag?: Flag; // only findings that carry this data-quality flag
  includeDuplicates?: boolean; // default false: re-imported copies are hidden
  limit?: number; // a whole number; default 50, kept within 1..200
  offset?: number; // a whole number; default 0
};

export type SearchHit = {
  finding: Finding;
  tier: Tier;
  entityRanges: HighlightRange[]; // offsets into finding.entity
  notesRanges: HighlightRange[]; // offsets into finding.notes; empty when notes is null
};

// How many results each filter button would give, so the UI can show live counts.
// Every type and every flag is present, with 0 when it would give nothing.
export type Facets = {
  types: { [type in FindingType]: number }; // total if the type filter were this type
  flags: { [flag in Flag]: number }; // total if the flag filter were this flag
};

export type SearchResult = {
  total: number; // matches before paging
  limit: number; // the values actually used, after clamping
  offset: number;
  hits: SearchHit[];
  facets: Facets; // counted over all matches, not only the returned page
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
    if (folded === "") extendLastCharacter(starts, ends, end);
    text += folded;
    position = end;
  }
  return { text, starts, ends };
}

// A character that folds to nothing is a combining mark. It is drawn on the character
// before it, so that character's range grows to cover it: a highlight must never
// separate a letter from its accent. The character before may have folded to several
// code units (a Hangul syllable becomes two or three); they all share one `start`, and
// every one of them gets the new end, so a match on any of them takes the mark along.
function extendLastCharacter(starts: number[], ends: number[], end: number): void {
  const start = starts[starts.length - 1];
  for (let i = ends.length - 1; i >= 0 && starts[i] === start; i--) ends[i] = end;
}

// ---------- query ----------

// The whole query is used, however long: nothing is cut off silently here. The work per
// finding grows with the query, so the two edges (HTTP API, MCP tool) refuse a query
// that is too long before it gets here.
type ParsedQuery = {
  terms: string[]; // folded, never empty strings
  phrase: string; // the terms joined by single spaces; the ranking compares against it
};

// The words of a folded text. A fixed pattern, not one built from the text. Text made
// only of whitespace or combining marks gives no words at all.
function wordsOf(folded: string): string[] {
  return folded.split(/\s+/).filter((word) => word !== "");
}

// A query without words counts as an empty query.
function parseQuery(query: string): ParsedQuery {
  const terms = wordsOf(foldText(query).text);
  return { terms, phrase: terms.join(" ") };
}

// ---------- matching and ranking ----------

// A finding with its searchable text folded once, at startup, instead of on every query.
type Prepared = {
  finding: Finding;
  entity: FoldedText;
  // The folded entity with every run of whitespace as one space, like the query phrase.
  // Without it an entity written with two spaces, a tab or a no-break space could never
  // be an exact match for its own text.
  entityPhrase: string;
  notes: FoldedText;
  // The folded id and key. A record that shares its id has a key of its own ("F-1.2");
  // otherwise the two are the same text.
  names: string[];
};

function prepare(finding: Finding): Prepared {
  const entity = foldText(finding.entity);
  return {
    finding,
    entity,
    entityPhrase: wordsOf(entity.text).join(" "),
    notes: foldText(finding.notes ?? ""),
    names: [foldText(finding.id).text, foldText(finding.key).text],
  };
}

// An id or key matches only as a whole. As a substring "10" would be in hundreds of ids
// and "f-1" in all of them, and every search for a number would drown in them.
function isNameOf(item: Prepared, term: string): boolean {
  return item.names.includes(term);
}

// AND: every term must be somewhere, but each term may be in a different field.
// With no terms the loop never runs and everything matches: that is the browse mode.
function matchesAllTerms(item: Prepared, terms: string[]): boolean {
  for (const term of terms) {
    const found =
      item.entity.text.includes(term) || item.notes.text.includes(term) || isNameOf(item, term);
    if (!found) return false;
  }
  return true;
}

// Only called for findings that already matched all terms.
function tierOf(item: Prepared, query: ParsedQuery): Tier {
  // Checked first because every string starts with "", which would make browse tier 1.
  if (query.terms.length === 0) return 3;
  if (item.entityPhrase === query.phrase || isNameOf(item, query.phrase)) return 0;
  if (item.entityPhrase.startsWith(query.phrase)) return 1;
  if (query.terms.some((term) => item.entity.text.includes(term))) return 2;
  return 3;
}

// ---------- filters and facets ----------

// What a search returns, and what the facets count:
//   - A record MATCHES when it passes the text query and the case filter.
//   - A record is VISIBLE when includeDuplicates is true or it is not a re-imported copy
//     (duplicateOf === null). One exception: the flag filter "reimport" is how the analyst
//     asks to see the copies, so with it they are shown even without includeDuplicates.
//   - Results: the records that MATCH, pass the type filter, and
//       with no flag filter:        are VISIBLE;
//       with the flag "reimport":   carry that flag;
//       with any other flag:        are VISIBLE and carry that flag.
//   - facets.types[t]: the number of results if the type filter were t and everything
//     else stayed as it is. The type filter itself is ignored; the flag filter applies.
//   - facets.flags[f]: the number of results if the flag filter were f and everything
//     else stayed as it is. The flag filter itself is ignored; the type filter applies.
// So a count on a button is always the total the analyst gets by pressing it.

// A blank caseId means "no case filter", like a filter box left empty.
function passesCaseFilter(finding: Finding, caseId: string): boolean {
  return caseId === "" || finding.caseIds.includes(caseId);
}

function passesTypeFilter(finding: Finding, type: FindingType | undefined): boolean {
  return type === undefined || finding.type === type;
}

// The VISIBLE rule and the flag filter together; `flag` undefined means no flag filter.
function passesFlagFilter(
  finding: Finding,
  flag: Flag | undefined,
  options: SearchOptions,
): boolean {
  if (flag === "reimport") return finding.flags.includes(flag);
  const visible = options.includeDuplicates === true || finding.duplicateOf === null;
  return visible && (flag === undefined || finding.flags.includes(flag));
}

// An object with a 0 for every name, so no count is ever missing from the answer.
function zeroCounts<Name extends string>(names: readonly Name[]): { [name in Name]: number } {
  // The cast is needed because the object is only complete after the loop.
  const counts = {} as { [name in Name]: number };
  for (const name of names) counts[name] = 0;
  return counts;
}

// Adds one record that MATCHES to the counts it belongs in.
function countInFacets(facets: Facets, finding: Finding, options: SearchOptions): void {
  if (passesFlagFilter(finding, options.flag, options)) facets.types[finding.type]++;
  if (!passesTypeFilter(finding, options.type)) return;
  // Only the flags the record carries can count it; under any other flag it is not shown.
  // A record carries each flag at most once, so it is never counted twice for one flag.
  for (const flag of finding.flags) {
    if (passesFlagFilter(finding, flag, options)) facets.flags[flag]++;
  }
}

function isResult(finding: Finding, options: SearchOptions): boolean {
  return (
    passesTypeFilter(finding, options.type) && passesFlagFilter(finding, options.flag, options)
  );
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
// Exported for the HTTP API, which refuses a larger limit with this number in its message.
export const MAX_LIMIT = 200;

// Both callers check their input and pass a whole number or nothing: the HTTP API
// refuses anything else with 400, the MCP tool with an error result. The clamps below
// are only a last guard, so a mistake in a caller can never ask for a huge page.
function limitOf(value: number | undefined): number {
  return Math.min(MAX_LIMIT, Math.max(1, value ?? DEFAULT_LIMIT));
}

function offsetOf(value: number | undefined): number {
  return Math.max(0, value ?? 0);
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
    const facets: Facets = { types: zeroCounts(ALL_TYPES), flags: zeroCounts(FLAGS) };
    // One pass: a record that MATCHES is counted in the facets, and ranked if it is a result.
    for (const item of prepared) {
      if (!passesCaseFilter(item.finding, caseId)) continue;
      if (!matchesAllTerms(item, query.terms)) continue;
      countInFacets(facets, item.finding, options);
      if (isResult(item.finding, options)) ranked.push({ item, tier: tierOf(item, query) });
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
    return { total: ranked.length, limit, offset, hits, facets };
  };
}
