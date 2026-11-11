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
