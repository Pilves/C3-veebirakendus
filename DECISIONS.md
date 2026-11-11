# Decisions

A running log of the choices made while building this, with the reasoning at
the time. The README is written from this file.

## 1. Node 26

Pinned to Node 26. It is the newest LTS line, and this is a new application,
so there is nothing older to stay compatible with.

Considered: Node 24 (type stripping has been marked stable there for longer,
but the line is already in maintenance).

## 2. Explore the data with a script before writing the app

The task says the data has deliberate gaps and that noticing them is part of
the work. `scripts/explore.ts` finds and counts them, so every claim in the
README can be checked by running it, and the normaliser is built against a
known list of problems.

Re-imports are found by rule (same case, same instant, same notes, same entity
after trim and lowercase), not by their id range, so the script would also find
ones outside F-20000..F-20029.

Limits: the language split and the prompt-injection count are keyword
heuristics. The injection keyword list was widened after it first found three
of the four, so it supports that count but does not independently prove it.

## 3. Normalise once at startup, never destroy

Each record keeps its untouched raw value, gets cleaned fields beside it, and a
list of flags naming what was wrong. Problems are flagged, not corrected.

## 4. Reused ids: suffix both records

The two records sharing `F-10578` become `F-10578.1` and `F-10578.2`. Neither
keeps the plain id, so a lookup by the plain id can never silently pick one.

Cost: the numbering depends on the order of records in the file.

## 5. Types that are not one of the six become `unknown`

`Domain` or `" email "` are sloppy spellings of a valid type, so they are tidied
and flagged. `ipv4` and `url` are not valid types at all, so they become
`unknown` with a flag and the raw label kept. They are not guessed into a valid
type: in the data, `ipv4` sits on a hostname and `url` on an email address.

## 6. Re-imports: the lower id is the original

A re-import pair has the same timestamp, so date cannot decide which came
first. The record with the lower id is the original; the other is kept and
marked `duplicateOf`.

## 7. No database; search scans everything in memory

The data is one JSON file of about a thousand records. It is loaded and
normalised at startup, and every query scans all of it. That is fast at this
size, and there is no index or database that could go stale or need setup.

Would change at around 100k records or if the data were updated while running.

## 8. One search function for the HTTP API and the MCP tools

Both call the same `search()`, so they cannot disagree about what a query
finds or in which order.

## 9. Matching: folded substring, words ANDed

Text and query are lowercased and stripped of diacritics, so `oo` finds
`Öökull`. Analysts often type without Estonian letters.

Cost: õ, ö and o become the same letter, so some different Estonian words
merge. Substring matching also hits inside words.

Not done, on purpose: cross-language search, stemming for Estonian inflection,
fuzzy matching. Search covers entity and notes only, as the task says; ids and
cases are reached through lookup by id and the case filter.

## 10. Ranking: where the match is, then newest first

Exact entity, entity starts with the query, a word is in the entity, notes
only. Inside a tier the newest finding comes first, then key order, so the
same query always gives the same list.

## 11. Re-imports are hidden from results by default

Otherwise an analyst sees 30 findings twice. They can be included on request
and are never deleted.

## 12. Highlighting is offsets, not markup

Search returns plain text plus the positions to highlight. No HTML is built on
the server, so a note containing a script tag stays text all the way to the
screen.

The positions refer to the original text, not the folded one. Folding can
change a string's length, so each folded character remembers where it came
from in the original.
