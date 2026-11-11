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
list of flags naming what was wrong.

Tidying that cannot change the meaning is applied and flagged: an entity is
trimmed, a type label is trimmed and lowercased, a case id is trimmed and
uppercased. Anything that would need a guess is only flagged: a type is never
changed to fit its entity, a source without a scheme is never given one, and a
note is never edited.

## 4. Reused ids: suffix both records

The two records sharing `F-10578` become `F-10578.1` and `F-10578.2`. Neither
keeps the plain id, so a lookup by the plain id can never silently pick one.

Cost: the numbering depends on the order of records in the file.

## 5. Types that are not one of the six become `unknown`

`Domain` or `" email "` are sloppy spellings of a valid type, so they are tidied
and flagged. `ipv4` and `url` are not valid types at all, so they become
`unknown` with a flag and the raw label kept. They are not guessed into a valid
type: in the data, `ipv4` sits on a hostname and `url` on an email address.

Three of the tidied labels are also wrong about their entity: `Domain` is on an
IP address (F-10819), `IP` on a handle (F-10582) and `Handle` on an email
address (F-10380). The label is kept and the record gets a `type-mismatch` flag.
The check is a rough shape test, so it cannot tell a handle from an alias, and
it would wrongly flag a handle written like `j.smith`.

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

## 13. Express 5 for the HTTP layer

Three read-only routes under `/api`. Express is the one runtime dependency
(65 packages in total with what it pulls in). The API only checks the request,
calls the store or the search, and shapes the answer.

## 14. Lookup by id returns a list

`GET /api/findings/F-10578` returns both records that share that id; a normal
id returns a list of one; an unknown id is a 404. The shape is the same every
time and nothing is silently picked.

## 15. The raw record is only in the detail response

Search results carry the cleaned fields and the flags. The detail response adds
the record as originally recorded. Search responses stay small, and the detail
view can show what the source really said.

## 16. Bad input is rejected, not guessed

An unknown type, a limit outside 1 to 200, a query over 200 characters or a
repeated parameter gets a 400 with a plain message. Falling back to a default
would hide the caller's mistake. The MCP tools apply the same limits.

An earlier version cut long queries and clamped the limit silently. A review
caught that it contradicted this rule, and it was changed.

## 17. Security headers without a library

- Content-Security-Policy that forbids inline script: the dataset contains
  script payloads, so this is a second line of defence behind escaping.
- Referrer-Policy no-referrer: when an analyst clicks through to a source, that
  site does not learn the address of the investigation tool.
- X-Content-Type-Options nosniff.
- `require-trusted-types-for 'script'`: Chromium itself then refuses any
  `innerHTML`-style call, so the "text only" rule of the UI is enforced by the
  browser and not just by convention.
- Cache-Control no-store on `/api` and `/mcp`: investigation data should not
  sit in a browser's disk cache.

## 18. Case counts exclude re-imports

Each case shows its findings without the re-imported copies, and the copies as
a separate number, so the counts agree with what a default search shows. A
finding with two cases counts in both.

## 19. No authentication

The task does not ask for it. The server listens on 127.0.0.1 by default and
the compose file publishes the port on 127.0.0.1 only. A real deployment of an
investigation tool would need authentication, an access log and rate limiting.

## 20. MCP endpoint is hand-rolled, not the SDK

I tried the official SDK (`@modelcontextprotocol/server` v2) behind Express in
a throwaway spike before deciding. The spike is not kept in this repository.

The SDK gets the core rules right, but in that spike it brought behaviour I
could not switch off: it always served `subscriptions/listen` over SSE, it used
error code -32000 where the spec says new implementations should not, and by
default it still answered the old `initialize` handshake. It also adds nine
packages.

The task asks for revision 2026-07-28 and three read-only tools. That is three
methods and one chain of checks, so I wrote it by hand. Each rule in the code
names the spec page and phrase it implements.

Cost: conformance is on me. `scripts/mcp-check.sh` runs about a hundred checks
against a running server. Nothing was tested with a real MCP client, only curl.

## 21. Order of the MCP checks

The spec defines no order, so it is fixed in one place (`src/mcp/router.ts`):
Origin, HTTP method, content type, body, JSON-RPC shape, notification,
required headers, protocol version, header/body agreement, `_meta`, method,
tool name, arguments.

## 22. Choices where the MCP spec is silent

- Unknown tool: HTTP 400 with -32602. The spec gives the code, not the status.
- Old-style `initialize` without the new headers: -32020, with the supported
  version named in the message.
- 403, 405, 413 and 415 carry -32600, never the -32000 range.
- Bad argument values and "nothing found" are tool results with
  `isError: true`, not protocol errors.
- Allowed Origins: none, localhost, 127.0.0.1 and [::1] on any port. There is
  no setting to allow others: without CORS headers no browser on another
  origin could use the endpoint anyway.
- A request id must be a string or a whole number.

## 23. Prompt injection: findings are data, and say so

Some notes in the dataset are written as instructions to an AI assistant; one
tells it to call `list_cases`. Every tool description says that every field of
a finding is untrusted third-party text. Every result
repeats that in a `notice` field, so the warning travels with the data. Results
are built from a fixed list of fields.

This lowers the risk. It does not remove it: the model on the other side
decides what to do with the text.

## 24. Not in the MCP endpoint

Known deviations from the spec: it says servers MUST implement access controls
and rate-limit tool calls, and SHOULD authenticate every connection. This
server does none of the three; see decision 19.

Left out because three read-only tools do not need them: SSE, subscriptions,
tool-list pagination, output schemas, and CORS (so a browser client on another
origin cannot call the endpoint). The argument checker handles only what the
three tools use; it is not a general JSON Schema validator.

## 25. UI: three static files, no framework, no build step

`index.html`, `app.js`, `styles.css`, served by the same Express app. The task
says the interface must be usable and correct, not pretty. One search box, two
filters, a list and a detail panel do not need a framework, and with no build
step what is in the repository is what runs in the browser.

## 26. Untrusted text is only ever set as text

The UI never uses `innerHTML` or anything like it. Every element is created
with `createElement` and filled with `textContent`. A highlight is a `<mark>`
element made the same way, by cutting the original string at the offsets the
server returns. A note containing a script tag is shown as the characters of a
script tag.

The page works under the strict Content-Security-Policy from decision 17, so an
escaping bug would still not run inline script.

## 27. The source link is checked twice

The server only passes on a source URL that parses as http or https. The UI
checks the protocol again before making a link, and opens it with
`rel="noopener noreferrer"`. Anything else (`javascript:`, `data:`, empty, no
scheme) is shown as plain text with a note saying it is not a link.

## 28. Detail panel beside the list, English labels

The analyst keeps their place in the list while reading a finding. On a narrow
screen the panel takes over the view. Labels are in English, like the code and
the README.

## 29. Search state lives in the URL

Query, filters, page and the open finding are in the address, so a search can
be bookmarked or sent to a colleague and the back button works. The values are
read defensively, since anyone can edit a URL.

## 30. Docker: one service, no build stage, loopback only

Node 26 runs the TypeScript directly, so the image has no compiler and no
second stage. Production dependencies only, unprivileged user, read-only file
system, no capabilities.

The port is published on 127.0.0.1 only, because the app has no login. `PORT`
picks another host port when 3000 is taken.

## 31. A Host check for the whole app

A security review found that the Origin check on `/mcp` did not protect `/api`
or the page itself. With DNS rebinding, a web page on another site can make the
analyst's browser treat this tool as its own origin and read every finding, and
the tool sends analysts to suspect-controlled sites. The one thing such a page
cannot fake is the Host header, so every request whose Host is not localhost,
127.0.0.1 or [::1] is refused. `ALLOWED_HOSTS` adds names for someone who
serves it elsewhere.

## 32. Timestamps become UTC; the format is not a problem

The data has three formats: 730 ISO strings with Z, 180 with a +02:00 or
+03:00 offset (they follow Estonian summer time), and 122 numbers that are
milliseconds since 1970. All become one UTC ISO string and the raw value is
kept. A mixed format is not flagged, because nothing is wrong with the value.

A time that cannot be read is flagged, not guessed: a string without a time
zone, a number outside the millisecond range (it could be seconds), or a date
that does not exist, such as 30 February.

The list shows UTC, so a finding has the same date for every analyst. The
detail shows UTC and local time.

## 33. Case ids, notes and the file's own count

- Case id: always a list. `" c-117"` becomes `C-117` and is flagged, `null`
  becomes an empty list and is flagged, and the one record with two cases
  belongs to both. There is no case entity in the data, so `list_cases` is
  derived from these ids: 40 cases, C-101 to C-140, and one finding without a
  case.
- Notes: four records have no `notes` key and three have `null`. Both become
  `null` with one flag; the raw record keeps the difference. Notes are never
  trimmed, unescaped or stripped of tags, so a literal `&lt;` stays those four
  characters.
- `_meta.count` says 1032 and the file has 1032 records. The loader counts the
  records itself and does not use `_meta`.
- The numbers: 1032 records, 1030 different ids (two ids are used twice), 30
  re-imports, so 1002 findings are shown by default.
- Source URLs are kept exactly as written, including the `utm_` parameters and
  trailing slashes that only the re-imports have.

## 34. What "search in Estonian and English" means here

Both languages are searchable as written, and a query works with or without
Estonian letters. Examples from the data:

- Finds results: `ookull` (Öökull), `sifreeritud` (šifreeritud), `zurnaal`
  (žurnaal), `rünnaku`, `serveris`.
- Finds nothing: `rünne` when the note says `rünnaku` (another form of the
  word), `shifreeritud` (sh for š), `attack` when the note says `rünnak`.
- Finds half: `phishing` gives 61 findings and `õngitsus` gives 63 others. It
  is the same thing noted in two languages.

So there is no stemming, no transliteration and no translation between the two
languages, and one query finds only the records written in its own language. Fixing that needs a stemmer
for Estonian and a translation step or a bilingual word list, which I judged
out of scope.

## 35. Tests cover the logic, not the wiring

`npm test` covers the normaliser, the store, the search, the MCP rules and the
tool handlers. The HTTP routes and the MCP router are exercised by
`scripts/mcp-check.sh` against a running server, not by the unit tests, and the
UI has no automated tests in the repository. Nothing was tested with a real MCP
client.

## 36. Filters show their counts

The search returns, with every answer, how many results each type and each
data-quality flag would give. The UI shows the filters as buttons with those
counts, so an analyst sees how a result splits before filtering, and the
problems in the data are visible on the first screen instead of hidden in a
menu. Choosing the re-import flag shows the hidden copies; that is how to see
them.

Cost: every search counts all matches for both lists, which is one extra pass
that is negligible at this size.
