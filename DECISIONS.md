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
