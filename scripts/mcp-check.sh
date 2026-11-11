#!/usr/bin/env bash
# Conformance checklist for the MCP endpoint (specification revision 2026-07-28).
# Sends about a hundred requests with curl to a RUNNING server and compares each answer
# with what src/mcp/router.ts promises. Needs only curl and node.
#
#   npm start                                    # in one terminal
#   scripts/mcp-check.sh http://127.0.0.1:3000   # in another
#
# One line per check:
#   PASS  <check>   want <HTTP status> <kind>   got <HTTP status> <kind>
# where <kind> is the JSON-RPC error code (-32601), "result" for a normal result,
# "isError" for a tool execution error, or "-" for an empty body.
# Every answer must also: be application/json when it has a body, never be an SSE stream
# and never carry an Mcp-Session-Id header; no error may contain a stack trace.
# Exit code 0 when everything passed, 1 otherwise.
#
# The findings data is untrusted. This script never prints finding text: on a failure it
# prints the start of the response body only when that body is an error.
set -u

BASE=${1:?usage: mcp-check.sh <base-url>, for example http://127.0.0.1:3000}
BASE=${BASE%/}
URL="$BASE/mcp"
# The port for the Origin checks; 80 when the URL names none.
PORT=$(printf '%s' "$BASE" | sed -n 's#^.*:\([0-9][0-9]*\)$#\1#p')
PORT=${PORT:-80}
VERSION=2026-07-28
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
PASSED=0
FAILED=0
# Optional extra condition for the NEXT check only: a JavaScript expression over r (the parsed
# body), h (the response headers, lowercased) and raw (the body text).
ALSO=''

# Reads one response and prints two lines: its kind, and what is wrong with it (if anything).
cat > "$TMP/judge.cjs" <<'EOF'
const fs = require("node:fs");
const [bodyFile, headerFile, also] = process.argv.slice(2);
const raw = fs.readFileSync(bodyFile, "utf8");
const h = fs.readFileSync(headerFile, "utf8").toLowerCase();
const problems = [];
let r;
let kind = "-";
if (raw !== "") {
  try {
    r = JSON.parse(raw);
  } catch {
    kind = "not-json";
  }
}
if (r !== undefined) {
  if (r !== null && r.error) kind = String(r.error.code);
  else if (r !== null && r.result) kind = r.result.isError === true ? "isError" : "result";
  else kind = "other-json";
  if (!/^content-type: application\/json/m.test(h)) problems.push("not application/json");
  if (kind !== "other-json" && r.jsonrpc !== "2.0") problems.push('no jsonrpc "2.0"');
}
if (r && r.result) {
  const meta = r.result._meta || {};
  if (r.result.resultType !== "complete") problems.push("no resultType complete");
  if (!meta["io.modelcontextprotocol/serverInfo"]) problems.push("no serverInfo");
}
// Errors hold only the server's own words, so these patterns cannot come from findings.
const failed = r && (r.error || (r.result && r.result.isError === true));
if (failed && /\\n\s+at |node:internal|node_modules|\.ts:\d/.test(raw)) {
  problems.push("looks like a stack trace");
}
if (h.includes("text/event-stream")) problems.push("answered with an SSE stream");
if (/^mcp-session-id:/m.test(h)) problems.push("sent an Mcp-Session-Id header");
if (also) {
  let holds = false;
  try {
    holds = new Function("r", "h", "raw", `return (${also});`)(r, h, raw) === true;
  } catch {}
  if (!holds) problems.push(`does not hold: ${also}`);
}
console.log(kind);
console.log(problems.join("; "));
// Finding text is untrusted and is never printed; an error body holds only our own words.
console.log(r && r.error ? raw.slice(0, 200) : "");
EOF

section() { printf '\n== %s\n' "$1"; }

# check <label> <want-status> <want-kind> <curl arguments...>
check() {
  local label=$1 want_status=$2 want_kind=$3
  shift 3
  local status kind problems excerpt verdict=PASS
  status=$(curl -s -m 20 -o "$TMP/body" -D "$TMP/headers" -w '%{http_code}' "$@" "$URL")
  {
    read -r kind
    read -r problems
    read -r excerpt
  } < <(node "$TMP/judge.cjs" "$TMP/body" "$TMP/headers" "$ALSO")
  ALSO=''
  if [ "$status" != "$want_status" ] || [ "$kind" != "$want_kind" ] || [ -n "$problems" ]; then
    verdict=FAIL
  fi
  printf '%s  %-52s want %s %-7s  got %s %s\n' \
    "$verdict" "$label" "$want_status" "$want_kind" "$status" "$kind"
  if [ "$verdict" = PASS ]; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    [ -n "$problems" ] && printf '      problem: %s\n' "$problems"
    [ -n "$excerpt" ] && printf '      body: %s\n' "$excerpt"
  fi
}

# ---------- request builders ----------

JSON='Content-Type: application/json'
ACCEPT='Accept: application/json, text/event-stream'
PV="MCP-Protocol-Version: $VERSION"
M_LIST='Mcp-Method: tools/list'
M_CALL='Mcp-Method: tools/call'

# The _meta every request must carry; the argument overrides the protocol version.
meta() {
  printf '"_meta":{"io.modelcontextprotocol/protocolVersion":"%s",' "${1:-$VERSION}"
  printf '"io.modelcontextprotocol/clientInfo":{"name":"mcp-check","version":"1"},'
  printf '"io.modelcontextprotocol/clientCapabilities":{}}'
}
META=$(meta)

# req <id> <method>: a request with no parameters of its own.
req() { printf '{"jsonrpc":"2.0","id":%s,"method":"%s","params":{%s}}' "$1" "$2" "$META"; }

# Before the checks: make sure the thing answering at this address is this server at all.
# Another program on the same port would otherwise show up as a hundred confusing FAILs.
if ! curl -s -m 5 -X POST -H "$JSON" -H "$PV" -H 'Mcp-Method: server/discover' \
  -d "$(req 0 server/discover)" "$URL" | grep -q '"supportedVersions"'; then
  echo "No MCP server answered at $URL."
  echo "Is the server running, and on this port? Another program may be using it."
  echo "Try: PORT=3100 npm start   and   scripts/mcp-check.sh http://127.0.0.1:3100"
  exit 1
fi

# call <id> <tool> <arguments-json>: a tools/call request.
call() {
  printf '{"jsonrpc":"2.0","id":%s,"method":"tools/call",' "$1"
  printf '"params":{"name":"%s","arguments":%s,%s}}' "$2" "$3" "$META"
}

# post <label> <want-status> <want-kind> <Mcp-Method value> <body> [more curl arguments]
# A POST with every standard header in place.
post() {
  local label=$1 want_status=$2 want_kind=$3 method=$4 body=$5
  shift 5
  check "$label" "$want_status" "$want_kind" -X POST -H "$JSON" -H "$ACCEPT" -H "$PV" \
    -H "Mcp-Method: $method" "$@" --data-binary "$body"
}

# tool <label> <want-status> <want-kind> <tool> <arguments-json>: a correct tools/call.
tool() {
  post "$1" "$2" "$3" tools/call "$(call 1 "$4" "$5")" -H "Mcp-Name: $4"
}

# bare <label> <want-status> <want-kind> <curl arguments...>: a POST with JSON headers
# only, for the checks that are about a missing or wrong MCP header.
bare() {
  local label=$1 want_status=$2 want_kind=$3
  shift 3
  check "$label" "$want_status" "$want_kind" -X POST -H "$JSON" -H "$ACCEPT" "$@"
}

LIST=$(req 1 tools/list)

if ! curl -s -m 5 -o /dev/null "$BASE/"; then
  echo "No server answers at $BASE" >&2
  exit 1
fi
echo "MCP endpoint check: $URL (protocol $VERSION)"

# ---------- the methods ----------

section "server/discover and tools/list"
ALSO='r.id === 1 && r.result.supportedVersions.join() === "2026-07-28"'
post "server/discover: supportedVersions" 200 result server/discover "$(req 1 server/discover)"
ALSO='JSON.stringify(r.result.capabilities) === "{\"tools\":{}}"'
post "server/discover: capabilities are tools only" 200 result server/discover \
  "$(req 1 server/discover)"
ALSO='r.result.ttlMs >= 0 && r.result.cacheScope === "public"'
post "server/discover: cache hints" 200 result server/discover "$(req 1 server/discover)"
ALSO='h.includes("x-content-type-options: nosniff") && h.includes("content-security-policy:")'
post "server/discover: security headers are sent" 200 result server/discover \
  "$(req 1 server/discover)"
ALSO='r.result.tools.map((t) => t.name).join() === "search_findings,get_finding,list_cases"'
post "tools/list: three tools in a fixed order" 200 result tools/list "$LIST"
ALSO='r.result.ttlMs >= 0 && r.result.cacheScope === "public" && !("nextCursor" in r.result)'
post "tools/list: cache hints, no nextCursor" 200 result tools/list "$LIST"
ALSO='r.result.tools.every((t) => t.inputSchema.type === "object"'
ALSO="$ALSO"' && t.inputSchema.additionalProperties === false && t.annotations.readOnlyHint)'
post "tools/list: closed object schemas, read-only" 200 result tools/list "$LIST"
ALSO='r.result.tools.every((t) => /untrusted/.test(t.description) && !("outputSchema" in t))'
post "tools/list: descriptions warn about untrusted text" 200 result tools/list "$LIST"
ALSO='r.result.tools.length === 3'
post "tools/list: a cursor is ignored" 200 result tools/list \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{\"cursor\":\"abc\",$META}}"

section "tools/call with valid arguments"
ALSO='typeof r.result.structuredContent.notice === "string"'
ALSO="$ALSO"' && r.result.structuredContent.findings.length === 5'
tool "search_findings: query, type and limit" 200 result search_findings \
  '{"query":"","type":"domain","limit":5}'
ALSO='r.result.content.length === 1 && r.result.content[0].type === "text" && '
ALSO="$ALSO"'r.result.content[0].text === JSON.stringify(r.result.structuredContent)'
tool "search_findings: text block is the same JSON" 200 result search_findings \
  '{"query":"","limit":2}'
ALSO='r.result.structuredContent.limit === 20 && r.result.structuredContent.offset === 0'
tool "search_findings: the default limit is 20" 200 result search_findings '{"query":""}'
ALSO='r.result.structuredContent.findings.every((f) => !("raw" in f) && "tier" in f)'
tool "search_findings: all filters, no raw records" 200 result search_findings \
  '{"query":"a","type":"ip","caseId":"C-1","includeDuplicates":true,"limit":50,"offset":0}'
ALSO='r.result.structuredContent.findings.map((f) => f.key).join() === "F-10578.1,F-10578.2"'
tool "get_finding: F-10578 returns both records" 200 result get_finding '{"id":"F-10578"}'
ALSO='r.result.structuredContent.findings.length === 1'
ALSO="$ALSO"' && "raw" in r.result.structuredContent.findings[0]'
tool "get_finding: a key returns one record with raw" 200 result get_finding \
  '{"id":"F-10578.2"}'
ALSO='typeof r.result.structuredContent.notice === "string"'
ALSO="$ALSO"' && r.result.structuredContent.cases.length > 0'
ALSO="$ALSO"' && typeof r.result.structuredContent.findingsWithoutCase === "number"'
tool "list_cases" 200 result list_cases '{}'

section "Untrusted finding text (prompt injection)"
# F-10463 holds a note written as an instruction to an AI assistant. It must come back
# as plain JSON data, with the notice in front of it.
ALSO='Object.keys(r.result.structuredContent)[0] === "notice"'
ALSO="$ALSO"' && r.result.structuredContent.findings.some((f) => f.key === "F-10463")'
tool "search returns an instruction-like note as data" 200 result search_findings \
  '{"query":"list_cases"}'
ALSO='r.result.content[0].text.startsWith("{\"notice\":\"Untrusted data")'
tool "the notice opens the text block too" 200 result search_findings '{"query":"list_cases"}'
ALSO='typeof r.result.structuredContent.notice === "string"'
tool "get_finding carries the notice" 200 result get_finding '{"id":"F-10463"}'

# ---------- the checks, in the order the server applies them ----------

section "Rule 1: Origin"
post "no Origin header" 200 result tools/list "$LIST"
post "Origin http://localhost:$PORT" 200 result tools/list "$LIST" \
  -H "Origin: http://localhost:$PORT"
post "Origin http://127.0.0.1:$PORT" 200 result tools/list "$LIST" \
  -H "Origin: http://127.0.0.1:$PORT"
post "Origin http://[::1]:5173 (another local port)" 200 result tools/list "$LIST" \
  -H 'Origin: http://[::1]:5173'
ALSO='!("id" in r)'
post "Origin https://evil.example" 403 -32600 tools/list "$LIST" \
  -H 'Origin: https://evil.example'
post "Origin null" 403 -32600 tools/list "$LIST" -H 'Origin: null'
post "Origin http://localhost.evil.example" 403 -32600 tools/list "$LIST" \
  -H 'Origin: http://localhost.evil.example'
post "Origin http://localhost@evil.example" 403 -32600 tools/list "$LIST" \
  -H 'Origin: http://localhost@evil.example'
check "GET with a foreign Origin is 403, not 405" 403 -32600 -X GET \
  -H 'Origin: https://evil.example'
ALSO='!h.includes("access-control-")'
check "OPTIONS preflight from a foreign Origin" 403 -32600 -X OPTIONS \
  -H 'Origin: https://evil.example' -H 'Access-Control-Request-Method: POST'

section "Rule 2: only POST"
ALSO='/^allow: post\r?$/m.test(h)'
check "GET (old SSE stream)" 405 -32600 -X GET -H 'Accept: text/event-stream'
ALSO='/^allow: post\r?$/m.test(h)'
check "DELETE (old session end)" 405 -32600 -X DELETE -H 'Mcp-Session-Id: abc-123'
ALSO='/^allow: post\r?$/m.test(h)'
check "PUT" 405 -32600 -X PUT -H "$JSON" --data-binary '{}'
ALSO='/^allow: post\r?$/m.test(h) && !h.includes("access-control-")'
check "OPTIONS" 405 -32600 -X OPTIONS

section "Rule 3: Content-Type"
check "Content-Type text/plain" 415 -32600 -X POST -H 'Content-Type: text/plain' \
  -H "$PV" -H "$M_LIST" --data-binary "$LIST"
check "Content-Type missing" 415 -32600 -X POST -H 'Content-Type:' \
  -H "$PV" -H "$M_LIST" --data-binary "$LIST"
check "Content-Type application/json; charset=utf-8" 200 result -X POST \
  -H 'Content-Type: application/json; charset=utf-8' -H "$PV" -H "$M_LIST" \
  --data-binary "$LIST"

section "Rule 4: body size and JSON syntax"
ALSO='!("id" in r)'
post "invalid JSON" 400 -32700 tools/list '{"jsonrpc":"2.0","id":1,'
head -c 5242880 /dev/zero | tr '\0' 'a' > "$TMP/padding"
{
  printf '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"pad":"'
  cat "$TMP/padding"
  printf '",%s}}' "$META"
} > "$TMP/big.json"
post "a 5 MB body" 413 -32600 tools/list "@$TMP/big.json" -H 'Expect:'
check "an empty body" 400 -32600 -X POST -H "$JSON" -H "$PV" -H "$M_LIST"

section "Rule 5: one JSON-RPC 2.0 request"
ALSO='!("id" in r)'
post "a batch array" 400 -32600 tools/list "[$LIST,$LIST]"
post "a JSON string instead of an object" 400 -32600 tools/list '"tools/list"'
ALSO='r.id === 44'
post "jsonrpc 1.0 (the id is still echoed)" 400 -32600 tools/list \
  "{\"jsonrpc\":\"1.0\",\"id\":44,\"method\":\"tools/list\",\"params\":{$META}}"
post "no method" 400 -32600 tools/list "{\"jsonrpc\":\"2.0\",\"id\":1,\"params\":{$META}}"
ALSO='!("id" in r)'
post "id null" 400 -32600 tools/list "$(req null tools/list)"
post "id is an object" 400 -32600 tools/list "$(req '{}' tools/list)"
post "a JSON-RPC response as the body" 400 -32600 tools/list \
  '{"jsonrpc":"2.0","id":1,"result":{}}'
ALSO='r.id === "abc"'
post "a string id is accepted and echoed" 200 result tools/list "$(req '"abc"' tools/list)"

section "Rule 6: notifications"
ALSO='!h.includes("content-type:")'
post "a notification gets 202 and no body" 202 - notifications/cancelled \
  "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/cancelled\",\"params\":{$META}}"
bare "a notification without MCP headers" 202 - \
  --data-binary '{"jsonrpc":"2.0","method":"notifications/initialized"}'

section "Rule 7: required headers"
ALSO='r.id === 1 && r.error.message.includes("2026-07-28")'
bare "no MCP-Protocol-Version header" 400 -32020 -H "$M_LIST" --data-binary "$LIST"
bare "no Mcp-Method header" 400 -32020 -H "$PV" --data-binary "$LIST"
ALSO='r.id === 14 && r.error.message.includes("2026-07-28")'
bare "old-style initialize names the supported version" 400 -32020 --data-binary \
  '{"jsonrpc":"2.0","id":14,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}'
bare "old-style tools/list without headers" 400 -32020 \
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
bare "header NAMES in another case are accepted" 200 result \
  -H "mcp-protocol-version: $VERSION" -H 'MCP-METHOD: tools/list' --data-binary "$LIST"

section "Rule 8: protocol version"
OLD_LIST="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{$(meta 2025-11-25)}}"
ALSO='r.error.data.supported.join() === "2026-07-28" && r.error.data.requested === "2025-11-25"'
bare "header and body say 2025-11-25" 400 -32022 -H 'MCP-Protocol-Version: 2025-11-25' \
  -H "$M_LIST" --data-binary "$OLD_LIST"
ALSO='r.error.data.requested === "1900-01-01"'
bare "header 1900-01-01, body 2026-07-28" 400 -32022 -H 'MCP-Protocol-Version: 1900-01-01' \
  -H "$M_LIST" --data-binary "$LIST"
bare "old-style tools/list with header 2025-11-25" 400 -32022 \
  -H 'MCP-Protocol-Version: 2025-11-25' -H "$M_LIST" \
  --data-binary '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'

section "Rule 9: headers must agree with the body"
post "Mcp-Method says tools/call, body says tools/list" 400 -32020 tools/call "$LIST"
post "header VALUES are case-sensitive (Tools/List)" 400 -32020 Tools/List "$LIST"
post "header 2026-07-28, body _meta 2025-11-25" 400 -32020 tools/list "$OLD_LIST"

section "Rule 10: the _meta envelope"
V_ONLY='"io.modelcontextprotocol/protocolVersion":"2026-07-28"'
C_ONLY='"io.modelcontextprotocol/clientCapabilities":{}'
BOTH="$V_ONLY,$C_ONLY"
ALSO='r.id === 1'
post "no params" 400 -32602 tools/list '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
post "params without _meta" 400 -32602 tools/list \
  '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
post "_meta without clientCapabilities" 400 -32602 tools/list \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{\"_meta\":{$V_ONLY}}}"
post "_meta without protocolVersion" 400 -32602 tools/list \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{\"_meta\":{$C_ONLY}}}"
post "_meta without clientInfo (optional)" 200 result tools/list \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\",\"params\":{\"_meta\":{$BOTH}}}"

section "Rule 11: unknown methods"
ALSO='r.id === 1'
post "initialize with a correct envelope" 404 -32601 initialize "$(req 1 initialize)"
post "ping" 404 -32601 ping "$(req 1 ping)"
post "resources/list" 404 -32601 resources/list "$(req 1 resources/list)"
post "subscriptions/listen" 404 -32601 subscriptions/listen "$(req 1 subscriptions/listen)"
ALSO='!raw.includes("zz_echo")'
post "an invented method is not echoed back" 404 -32601 zz_echo/method \
  "$(req 1 zz_echo/method)"

section "Rule 12: tools/call request shape"
LIST_CASES=$(call 1 list_cases '{}')
BASE64_NAME="=?base64?$(printf list_cases | base64)?="
BASE64_OTHER="=?base64?$(printf get_finding | base64)?="
post "no Mcp-Name header" 400 -32020 tools/call "$LIST_CASES"
post "Mcp-Name names another tool" 400 -32020 tools/call "$LIST_CASES" \
  -H 'Mcp-Name: get_finding'
post "Mcp-Name in base64 form" 200 result tools/call "$LIST_CASES" -H "Mcp-Name: $BASE64_NAME"
post "Mcp-Name in base64 form, another tool" 400 -32020 tools/call "$LIST_CASES" \
  -H "Mcp-Name: $BASE64_OTHER"
post "Mcp-Name in damaged base64" 400 -32020 tools/call "$LIST_CASES" \
  -H 'Mcp-Name: =?base64?bGlz!dF9jYXNlcw==?='
ALSO='!raw.includes("zz_echo")'
tool "unknown tool (and its name is not echoed)" 400 -32602 zz_echo '{}'
post "name is not a string" 400 -32602 tools/call \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":5,$META}}" \
  -H 'Mcp-Name: 5'
tool "arguments is an array" 400 -32602 list_cases '[]'
tool "arguments is a string" 400 -32602 list_cases '"x"'
NO_ARGUMENTS="\"params\":{\"name\":\"list_cases\",$META}"
post "arguments omitted" 200 result tools/call \
  "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",$NO_ARGUMENTS}" \
  -H 'Mcp-Name: list_cases'

section "Rule 13: tool execution errors (HTTP 200, isError)"
ALSO='r.result.content[0].type === "text" && !("structuredContent" in r.result)'
tool "query has the wrong type" 200 isError search_findings '{"query":5}'
tool "query is missing" 200 isError search_findings '{}'
ALSO='!raw.includes("zz_echo")'
tool "an unknown argument (its name is not echoed)" 200 isError search_findings \
  '{"query":"x","zz_echo":1}'
tool "limit 99999" 200 isError search_findings '{"query":"x","limit":99999}'
tool "limit 0" 200 isError search_findings '{"query":"x","limit":0}'
tool "limit 1.5" 200 isError search_findings '{"query":"x","limit":1.5}'
tool "offset -1" 200 isError search_findings '{"query":"x","offset":-1}'
tool "type is not in the enum" 200 isError search_findings '{"query":"x","type":"zzz"}'
tool "includeDuplicates is a string" 200 isError search_findings \
  '{"query":"x","includeDuplicates":"true"}'
tool "get_finding without id" 200 isError get_finding '{}'
ALSO='!raw.includes("zz_echo")'
tool "get_finding: no such id" 200 isError get_finding '{"id":"zz_echo"}'
tool "list_cases with an argument" 200 isError list_cases '{"x":1}'
ALSO='r.result.structuredContent.total === 0'
tool "a search with no match is not an error" 200 result search_findings \
  '{"query":"zz-no-such-text-zz"}'

# ---------- what the server deliberately does not have ----------

section "No sessions, no SSE"
post "Mcp-Session-Id on a request is ignored" 200 result tools/list "$LIST" \
  -H 'Mcp-Session-Id: abc-123'
post "Last-Event-ID is ignored" 200 result tools/list "$LIST" -H 'Last-Event-ID: 7'
check "Accept: text/event-stream only still gets JSON" 200 result -X POST -H "$JSON" \
  -H 'Accept: text/event-stream' -H "$PV" -H "$M_LIST" --data-binary "$LIST"
check "no Accept header" 200 result -X POST -H "$JSON" -H 'Accept:' -H "$PV" -H "$M_LIST" \
  --data-binary "$LIST"
tool "a tools/call answer is JSON, not a stream" 200 result list_cases '{}'

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" -eq 0 ]
