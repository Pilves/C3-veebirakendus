# Findings search

A small web app for searching and browsing OSINT findings (domains, IP addresses, email
addresses, handles, aliases, crypto wallets), with an HTTP API and an MCP interface.

The data in `data/findings.json` is fictional; its own `_meta.description` says so.

## Run it

```bash
docker compose up --build
```

Then open <http://127.0.0.1:3000>.

- If port 3000 is taken: `PORT=3100 docker compose up --build`, then open port 3100.
- The port is published on 127.0.0.1 only. The app has no login, so it must not be
  reachable from the network.
- Stop with Ctrl-C or `docker compose down`.

| Path | What |
|---|---|
| `/` | The UI |
| `/api` | The JSON API the UI uses |
| `/mcp` | The MCP endpoint |

### Without Docker

Needs Node 22.18 or newer (the image uses Node 26). Node runs the TypeScript sources
directly, so there is no build step.

```bash
npm ci
npm start
```

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `HOST` | `127.0.0.1` | Address to listen on |
| `ALLOWED_HOSTS` | none | Extra hostnames the app may be served under, comma-separated |
| `FINDINGS_PATH` | `data/findings.json` | The data file |

## Check it

```bash
npm test                 # unit tests, and the whole app over HTTP
npm run typecheck        # tsc, no output
node scripts/explore.ts  # the data-quality report this README quotes
```

With the server running:

```bash
bash scripts/mcp-check.sh http://127.0.0.1:3000
```

That script sends about a hundred requests to `/mcp` with curl and prints PASS or FAIL
for each rule of the protocol. It needs bash, curl and node.

The endpoint was also tried by hand with two real clients in their 2026-07-28 mode: the
official SDK client (`@modelcontextprotocol/client` 2.4.0) and the MCP Inspector CLI
2.14.0. Discovery, the tool list and all three tools worked with both. Clients default to
the older protocol, so the Inspector needs `--protocol-era modern`.

What is not tested automatically: the UI has no automated tests in the repository.

## How it is built

```
data/findings.json    the dataset, unmodified
src/data/             load, normalise, look up by id, list cases
src/search/           the one search function
src/http/             the JSON API and the Host check
src/mcp/              the MCP endpoint
src/app.ts            builds the Express app: headers, Host check, routers, static files
src/server.ts         loads the data and listens
public/               the UI: one HTML file, one script, one stylesheet
scripts/              data exploration and the MCP check
```

The reasoning behind each choice, with what it costs, is in
[DECISIONS.md](DECISIONS.md). The short version:

- **No database.** About a thousand records are loaded and cleaned once at startup and
  every query scans all of them. That is fast at this size, and there is nothing to set
  up or keep in sync. It would need an index at around 100,000 records or with live
  updates.
- **One search function** for the API and the MCP tools, so they cannot disagree.
- **Normalise once, never destroy.** Every record keeps its raw value, gets cleaned
  fields beside it and a list of flags naming what was wrong.
- **Search is a folded substring match.** Text and query are lowercased and stripped of
  diacritics; several words must all match, each anywhere in the entity, the notes or
  the source address. A word that is a whole id, case id or type matches too, so
  `C-117 wallet` works. Results are ranked by where the match is (entity or id equals
  the query, entity starts with it, contains a word, anything else) and then newest
  first.
- **Highlights are positions, not markup.** The server returns plain text and the
  offsets to highlight. No HTML is built anywhere on the server.
- **Express 5** is the only runtime dependency.
- **The UI has no framework and no build step.** It never uses `innerHTML`: every node
  is created and filled as text.
- **The MCP endpoint is written by hand** for revision 2026-07-28, not with the SDK.

## The data: what was found and what was done

`node scripts/explore.ts` prints all of this. The numbers: 1032 records, 1030 different
ids, 30 re-imports, so 1002 findings are shown by default.

| Problem in the data | Count | What the app does |
|---|---|---|
| An id used by two unrelated records (`F-10401`, `F-10578`) | 2 ids | Both records get a key with a suffix (`F-10578.1`, `.2`); a lookup by the plain id returns both |
| Re-imports of an earlier record (`F-20000` to `F-20029`): same case, time, notes and entity, differing in whitespace, letter case, `utm_` parameters, a trailing slash or the timestamp format | 30 | Kept, marked as a duplicate of the original, hidden from results unless asked for |
| Type label in another spelling (`Domain`, `IP`, `ALIAS`, `Handle`, `" email "`) | 5 | Tidied and flagged |
| Type label that is not one of the six (`ipv4`, `url`) | 2 | Type becomes `unknown`, flagged; never guessed |
| Type label contradicts the entity (`Domain` on an IP address, `IP` on a handle, `Handle` on an email) | 3 | Label kept, flagged |
| Case id as `" c-117"`, `null`, or a list of two | 3 | Always a list; tidied or empty, flagged |
| Timestamps in three formats: ISO with Z (730), ISO with +02:00 or +03:00 (180), milliseconds as a number (122) | all | All become UTC; not flagged, nothing is wrong with them |
| Source that is not a web link (`javascript:`, `data:`, empty, no scheme) | 4 | Shown as text, never as a link |
| Notes missing (4) or `null` (3) | 7 | `null`, flagged |
| Notes containing something shaped like an HTML tag | 6 | Shown as the literal characters, flagged |
| Notes written as instructions to an AI assistant | 4 | Returned as data and flagged by a keyword rule, with a warning in every MCP result |
| Entity with surrounding whitespace | 4 | Trimmed and flagged |

Things that are not errors but worth knowing:

- 62 entities appear in more than one case. The UI can list all findings for an entity.
- The same entity in the same case at different times is a repeat observation, not a
  duplicate, and is kept as separate findings.
- About two thirds of the notes are English and one third Estonian.
- The observation times run from 2026-09-01 to 2026-10-31 (UTC). There are 40 cases,
  `C-101` to `C-140`, and one finding without a case.

## Gaps in the task and how I read them

| The task says | How I read it |
|---|---|
| "About 1000 findings" | 1032 records, of which 1002 are distinct findings |
| Six types | Six types plus `unknown` for labels outside them |
| "Search in Estonian and English" | Both languages as written, with or without Estonian letters. No stemming and no translation between them; see below |
| "Optional filters" | Type, case, data-quality flag, and whether to include re-imports |
| "A finding by id" | Ids are not unique, so the answer is always a list |
| `list_cases` | There is no case entity in the data; cases are derived from the case ids on findings |
| MCP revision 2026-07-28 | Stateless: no handshake and no sessions; every request carries its version and method in headers |
| No port, no login, no users | Port 3000, loopback only, no authentication; see Security |

### Two languages

- Works: `ookull` finds *Öökull*, `sifreeritud` finds *šifreeritud*, `rünnaku`,
  `serveris`.
- Does not: `rünne` when the note says *rünnaku*, `shifreeritud`, `attack` when the note
  says *rünnak*. `phishing` finds 61 findings and `õngitsus` 63 others.
- The cost of ignoring diacritics: õ, ö and o become the same letter, so some different
  Estonian words match each other.

Closing those gaps needs an Estonian stemmer and a translation step, which I left out.

## API

| Request | Answer |
|---|---|
| `GET /api/findings?q=&type=&case=&flag=&duplicates=1&limit=&offset=` | One page of results with highlight positions and counts per type and flag |
| `GET /api/findings/:id` | A list of the findings with that id or key, each with its raw record |
| `GET /api/cases` | Every case with its counts and time range |

`q` is at most 200 characters; `limit` is 1 to 200 (default 50). Bad input gets a 400
with `{ "error": "..." }`; it is never silently adjusted.

## MCP

Tools: `search_findings`, `get_finding`, `list_cases`. Streamable HTTP at `POST /mcp`,
JSON answers only, revision 2026-07-28.

```bash
curl -s http://127.0.0.1:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' \
  -H 'Mcp-Method: tools/call' \
  -H 'Mcp-Name: search_findings' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{
        "name":"search_findings","arguments":{"query":"oo","limit":3},
        "_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28",
                 "io.modelcontextprotocol/clientCapabilities":{}}}}'
```

The spec defines no order for its checks, so the order is fixed and documented at the
top of `src/mcp/router.ts`, with the status and error code for each step. Where the spec
is silent I chose and wrote it down (DECISIONS.md, 21 and 22).

Known deviations from the spec: it says servers must implement access controls and
rate-limit tool calls and should authenticate connections. This server does none of the
three. Also left out: SSE, subscriptions, pagination of the tool list, output schemas.

## Security

- **All finding text is untrusted.** The UI only ever sets it as text; the server never
  builds HTML; a strict Content-Security-Policy with Trusted Types means the browser
  itself refuses inline script and `innerHTML`-style calls.
- **Source links** are made only for `http://` and `https://` addresses, checked on the
  server and again in the UI, and opened without a referrer.
- **DNS rebinding:** requests whose Host header is not local are refused, on every path.
- **Prompt injection:** the MCP tool descriptions and every result say that finding text
  is untrusted data, and a note that reads like instructions carries a flag. The flag
  is a keyword rule and can miss a reworded note. All of this lowers the risk; it cannot
  remove it, because the model on the other side decides what to do with the text.
- **Not done:** authentication, an access log, rate limiting. A real investigation tool
  needs all three.

## Not done

- Cross-language search and Estonian stemming.
- Automated UI tests.
- Authentication, audit logging, rate limiting.

## AI tools

The task allows AI tools and I used them throughout. Every decision above was mine to
make and is recorded, with its reasoning, in DECISIONS.md.
