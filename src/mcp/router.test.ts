// The /mcp endpoint over real HTTP: the router is mounted on a bare Express app, which
// listens on a free port of this machine, and every test sends one request with fetch.
// The rules themselves are tested without a server in protocol.test.ts and tools.test.ts;
// this file checks that the router chains them in the order its header comment promises.
// It is the in-process short form of scripts/mcp-check.sh, which needs a running server.
// The data is the real dataset. It is untrusted: the tests assert on ids, keys, counts
// and status codes only, and never print or name a note text.
// Not covered here: the Host check and the security headers, which server.ts adds.

import assert from "node:assert/strict";
import { once } from "node:events";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import express from "express";
import { normaliseFindings } from "../data/normalise.ts";
import { createStore } from "../data/store.ts";
import { createSearch } from "../search/search.ts";
import { loadRawFindings } from "../testing.ts";
import { createMcpRouter } from "./router.ts";

type Json = { [name: string]: any };
type HeaderMap = { [name: string]: string };

// One answer. `body` is undefined when the answer had no body (a notification).
type Reply = { status: number; headers: Headers; text: string; body: Json | undefined };

const VERSION = "2026-07-28";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

// The _meta every request must carry.
const META = {
  "io.modelcontextprotocol/protocolVersion": VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
};

let server: Server;
let url = "";

// Port 0 asks the system for any free port, so two test files never collide.
async function start(): Promise<void> {
  const findings = normaliseFindings(loadRawFindings());
  const app = express();
  app.use("/mcp", createMcpRouter(createStore(findings), createSearch(findings)));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  url = `http://127.0.0.1:${port}/mcp`;
}

// Without this the open server would keep `node --test` from exiting.
function stop(): void {
  server.close();
  server.closeAllConnections();
}

// Sends exactly the given method, headers and body text: nothing is added, so a test
// can leave a header out. Checks the two rules that hold for every answer of this
// endpoint: it is never an SSE stream, and it never starts a session.
async function send(method: string, headers: HeaderMap, bodyText?: string): Promise<Reply> {
  const response = await fetch(url, { method, headers, body: bodyText });
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";
  assert.ok(!contentType.includes("text/event-stream"), "answered with an SSE stream");
  assert.equal(response.headers.get("mcp-session-id"), null);
  if (text !== "") assert.match(contentType, /^application\/json/);
  const body = text === "" ? undefined : JSON.parse(text);
  return { status: response.status, headers: response.headers, text, body };
}

// The headers of a correct request for the given JSON-RPC method.
function headersFor(method: string): HeaderMap {
  return {
    "Content-Type": "application/json",
    "MCP-Protocol-Version": VERSION,
    "Mcp-Method": method,
  };
}

// A correct request with id 1. `params` are the method's own parameters.
function requestBody(method: string, params: Json = {}): Json {
  return { jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } };
}

// POSTs a JSON-RPC message with the headers that match it. `extraHeaders` are added to
// them, or replace them when the name is spelled the same.
function post(message: unknown, extraHeaders: HeaderMap = {}): Promise<Reply> {
  const method = (message as Json).method ?? "tools/list";
  return send("POST", { ...headersFor(method), ...extraHeaders }, JSON.stringify(message));
}

// A correct tools/call, with the Mcp-Name header that names the same tool.
function callTool(name: string, args: unknown): Promise<Reply> {
  const message = requestBody("tools/call", { name, arguments: args });
  return post(message, { "Mcp-Name": name });
}

// The result of a successful answer, after checking what every result must have.
function resultOf(reply: Reply): Json {
  assert.equal(reply.status, 200);
  const body = reply.body as Json;
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.error, undefined);
  assert.equal(body.result.resultType, "complete");
  assert.deepEqual(body.result._meta[SERVER_INFO_KEY], {
    name: "findings-search",
    version: "0.1.0",
  });
  return body.result;
}

// The error of a refused request, after checking its HTTP status and JSON-RPC code.
function errorOf(reply: Reply, status: number, code: number): Json {
  assert.equal(reply.status, status);
  const body = reply.body as Json;
  assert.equal(body.jsonrpc, "2.0");
  assert.equal(body.result, undefined);
  assert.equal(body.error.code, code);
  assert.equal(typeof body.error.message, "string");
  return body.error;
}

before(start);
after(stop);

describe("step 1: Origin", () => {
  test("a foreign Origin is refused with 403 and no id", async () => {
    const reply = await post(requestBody("tools/list"), { Origin: "https://evil.example" });
    errorOf(reply, 403, -32600);
    assert.ok(!("id" in (reply.body as Json)));
    assert.ok(!reply.text.includes("evil"));
  });

  test("a look-alike of localhost is refused", async () => {
    const origin = "http://localhost.evil.example";
    const reply = await post(requestBody("tools/list"), { Origin: origin });
    errorOf(reply, 403, -32600);
  });

  test("a local Origin is allowed, on any port", async () => {
    const reply = await post(requestBody("tools/list"), { Origin: "http://localhost:5173" });
    resultOf(reply);
  });

  test("a request without Origin is allowed", async () => {
    const reply = await post(requestBody("tools/list"));
    resultOf(reply);
  });

  test("Origin is checked before the HTTP method: a foreign GET is 403, not 405", async () => {
    const reply = await send("GET", { Origin: "https://evil.example" });
    errorOf(reply, 403, -32600);
  });
});

describe("step 2: only POST", () => {
  for (const method of ["GET", "DELETE", "PUT"]) {
    test(`${method} is a 405 with Allow: POST`, async () => {
      const reply = await send(method, {});
      errorOf(reply, 405, -32600);
      assert.equal(reply.headers.get("allow"), "POST");
    });
  }
});

describe("step 3: Content-Type", () => {
  test("a body that is not sent as application/json is a 415", async () => {
    const headers = { ...headersFor("tools/list"), "Content-Type": "text/plain" };
    const reply = await send("POST", headers, JSON.stringify(requestBody("tools/list")));
    errorOf(reply, 415, -32600);
  });

  test("application/json with a charset is accepted", async () => {
    const contentType = "application/json; charset=utf-8";
    const reply = await post(requestBody("tools/list"), { "Content-Type": contentType });
    resultOf(reply);
  });

  test("the type is checked before the body is parsed: 415, not a parse error", async () => {
    const headers = { ...headersFor("tools/list"), "Content-Type": "text/plain" };
    const reply = await send("POST", headers, "{not json");
    errorOf(reply, 415, -32600);
  });
});

describe("step 4: the body must be JSON of a sane size", () => {
  test("invalid JSON is a 400 parse error with no id", async () => {
    const reply = await send("POST", headersFor("tools/list"), '{"jsonrpc":"2.0","id":1,');
    errorOf(reply, 400, -32700);
    assert.ok(!("id" in (reply.body as Json)));
  });

  test("a body above the size limit is a 413", async () => {
    const message = requestBody("tools/list", { padding: "a".repeat(200_000) });
    const reply = await post(message);
    errorOf(reply, 413, -32600);
  });
});

describe("step 5: one JSON-RPC 2.0 request", () => {
  test("a batch array is refused", async () => {
    const reply = await post([requestBody("tools/list"), requestBody("tools/list")]);
    errorOf(reply, 400, -32600);
    assert.ok(!("id" in (reply.body as Json)));
  });

  test("another jsonrpc version is refused, and the id is still echoed", async () => {
    const reply = await post({ ...requestBody("tools/list"), jsonrpc: "1.0", id: 44 });
    errorOf(reply, 400, -32600);
    assert.equal((reply.body as Json).id, 44);
  });

  test("the id 1.5 is refused and not echoed", async () => {
    const reply = await post({ ...requestBody("tools/list"), id: 1.5 });
    errorOf(reply, 400, -32600);
    assert.ok(!("id" in (reply.body as Json)));
  });

  test("the id null is refused", async () => {
    const reply = await post({ ...requestBody("tools/list"), id: null });
    errorOf(reply, 400, -32600);
  });
});

describe("step 6: notifications", () => {
  test("a notification gets 202 and an empty body", async () => {
    const message = { jsonrpc: "2.0", method: "notifications/cancelled" };
    const reply = await post(message);
    assert.equal(reply.status, 202);
    assert.equal(reply.text, "");
    assert.equal(reply.headers.get("content-type"), null);
  });

  test("a notification is accepted before the MCP headers are looked at", async () => {
    const message = { jsonrpc: "2.0", method: "notifications/initialized" };
    const headers = { "Content-Type": "application/json" };
    const reply = await send("POST", headers, JSON.stringify(message));
    assert.equal(reply.status, 202);
    assert.equal(reply.text, "");
  });
});

describe("step 7: required headers", () => {
  test("a missing MCP-Protocol-Version header is -32020, with the request id", async () => {
    const headers = { "Content-Type": "application/json", "Mcp-Method": "tools/list" };
    const reply = await send("POST", headers, JSON.stringify(requestBody("tools/list")));
    const error = errorOf(reply, 400, -32020);
    assert.equal((reply.body as Json).id, 1);
    assert.ok(error.message.includes(VERSION), "the message names the supported version");
  });

  test("a missing Mcp-Method header is -32020", async () => {
    const headers = { "Content-Type": "application/json", "MCP-Protocol-Version": VERSION };
    const reply = await send("POST", headers, JSON.stringify(requestBody("tools/list")));
    errorOf(reply, 400, -32020);
  });

  test("header names in another letter case are accepted", async () => {
    const headers = {
      "content-type": "application/json",
      "mcp-protocol-version": VERSION,
      "MCP-METHOD": "tools/list",
    };
    const reply = await send("POST", headers, JSON.stringify(requestBody("tools/list")));
    resultOf(reply);
  });

  test("a missing header is reported before a wrong version", async () => {
    const headers = { "Content-Type": "application/json", "MCP-Protocol-Version": "1900-01-01" };
    const reply = await send("POST", headers, JSON.stringify(requestBody("tools/list")));
    errorOf(reply, 400, -32020);
  });
});

describe("step 8: protocol version", () => {
  test("another version is -32022 and names the supported and the requested one", async () => {
    const extraHeaders = { "MCP-Protocol-Version": "2025-11-25" };
    const reply = await post(requestBody("tools/list"), extraHeaders);
    const error = errorOf(reply, 400, -32022);
    assert.deepEqual(error.data, { supported: [VERSION], requested: "2025-11-25" });
  });

  test("the version is checked before the headers are compared with the body", async () => {
    const extraHeaders = { "MCP-Protocol-Version": "2025-11-25", "Mcp-Method": "tools/call" };
    const reply = await post(requestBody("tools/list"), extraHeaders);
    errorOf(reply, 400, -32022);
  });
});

describe("step 9: headers must agree with the body", () => {
  test("an Mcp-Method header that names another method is -32020", async () => {
    const reply = await post(requestBody("tools/list"), { "Mcp-Method": "tools/call" });
    errorOf(reply, 400, -32020);
  });

  test("header values are case-sensitive", async () => {
    const reply = await post(requestBody("tools/list"), { "Mcp-Method": "Tools/List" });
    errorOf(reply, 400, -32020);
  });

  test("a body _meta with another protocol version is -32020", async () => {
    const meta = { ...META, "io.modelcontextprotocol/protocolVersion": "2025-11-25" };
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } };
    const reply = await post(message);
    errorOf(reply, 400, -32020);
  });

  test("a mismatch is reported before a missing _meta", async () => {
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    const reply = await post(message, { "Mcp-Method": "tools/call" });
    errorOf(reply, 400, -32020);
  });
});

describe("step 10: the _meta envelope", () => {
  test("a request without params is -32602", async () => {
    const reply = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    errorOf(reply, 400, -32602);
    assert.equal((reply.body as Json).id, 1);
  });

  test("_meta without the protocol version is -32602", async () => {
    const meta = { "io.modelcontextprotocol/clientCapabilities": {} };
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } };
    errorOf(await post(message), 400, -32602);
  });

  test("_meta without the client capabilities is -32602", async () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": VERSION };
    const message = { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: meta } };
    errorOf(await post(message), 400, -32602);
  });

  test("the envelope is checked before the method: unknown method, no _meta", async () => {
    const reply = await post({ jsonrpc: "2.0", id: 1, method: "zz_echo/method" });
    errorOf(reply, 400, -32602);
  });
});

describe("step 11: unknown methods", () => {
  test("an unknown method is a 404 with -32601 and is not sent back", async () => {
    const reply = await post(requestBody("zz_echo/method"));
    errorOf(reply, 404, -32601);
    assert.equal((reply.body as Json).id, 1);
    assert.ok(!reply.text.includes("zz_echo"));
  });

  test("initialize, removed in this revision, is an unknown method", async () => {
    const reply = await post(requestBody("initialize"));
    errorOf(reply, 404, -32601);
  });
});

describe("step 12: the shape of a tools/call", () => {
  test("a tools/call without the Mcp-Name header is -32020", async () => {
    const message = requestBody("tools/call", { name: "list_cases", arguments: {} });
    errorOf(await post(message), 400, -32020);
  });

  test("an Mcp-Name header that names another tool is -32020", async () => {
    const message = requestBody("tools/call", { name: "list_cases", arguments: {} });
    const reply = await post(message, { "Mcp-Name": "get_finding" });
    errorOf(reply, 400, -32020);
  });

  test("an Mcp-Name header in base64 form is decoded and accepted", async () => {
    const encoded = Buffer.from("list_cases", "utf8").toString("base64");
    const message = requestBody("tools/call", { name: "list_cases", arguments: {} });
    const reply = await post(message, { "Mcp-Name": `=?base64?${encoded}?=` });
    resultOf(reply);
  });

  test("an unknown tool is a 400 with -32602 and is not sent back", async () => {
    const reply = await callTool("zz_echo", {});
    errorOf(reply, 400, -32602);
    assert.ok(!reply.text.includes("zz_echo"));
  });

  test("arguments that are an array are -32602", async () => {
    errorOf(await callTool("list_cases", []), 400, -32602);
  });

  test("arguments that are a string are -32602", async () => {
    errorOf(await callTool("list_cases", "x"), 400, -32602);
  });

  test("arguments may be left out", async () => {
    const message = requestBody("tools/call", { name: "list_cases" });
    const reply = await post(message, { "Mcp-Name": "list_cases" });
    resultOf(reply);
  });
});

describe("step 13: tool execution errors are results, with HTTP 200", () => {
  test("a bad argument value is a result with isError and no structured content", async () => {
    const result = resultOf(await callTool("search_findings", { query: "x", limit: 0 }));
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent, undefined);
    assert.equal(result.content[0].type, "text");
  });

  test("an unknown argument is an isError result and its name is not sent back", async () => {
    const reply = await callTool("search_findings", { query: "x", zz_echo: 1 });
    assert.equal(resultOf(reply).isError, true);
    assert.ok(!reply.text.includes("zz_echo"));
  });

  test("get_finding with an id nobody has is an isError result", async () => {
    const reply = await callTool("get_finding", { id: "zz_echo" });
    assert.equal(resultOf(reply).isError, true);
    assert.ok(!reply.text.includes("zz_echo"));
  });
});

describe("request ids", () => {
  test("a number id is echoed on a result", async () => {
    const reply = await post({ ...requestBody("tools/list"), id: 7 });
    resultOf(reply);
    assert.equal((reply.body as Json).id, 7);
  });

  test("a string id is echoed on a result", async () => {
    const reply = await post({ ...requestBody("tools/list"), id: "abc" });
    resultOf(reply);
    assert.equal((reply.body as Json).id, "abc");
  });
});

describe("server/discover", () => {
  test("names the one supported version and offers tools only", async () => {
    const result = resultOf(await post(requestBody("server/discover")));
    assert.deepEqual(result.supportedVersions, ["2026-07-28"]);
    assert.deepEqual(result.capabilities, { tools: {} });
  });

  test("carries cache hints", async () => {
    const result = resultOf(await post(requestBody("server/discover")));
    assert.equal(result.ttlMs, 300_000);
    assert.equal(result.cacheScope, "public");
  });
});

describe("tools/list", () => {
  test("lists the three tools in a fixed order", async () => {
    const result = resultOf(await post(requestBody("tools/list")));
    const names = result.tools.map((tool: Json) => tool.name);
    assert.deepEqual(names, ["search_findings", "get_finding", "list_cases"]);
  });

  test("carries cache hints and no nextCursor", async () => {
    const result = resultOf(await post(requestBody("tools/list")));
    assert.equal(result.ttlMs, 300_000);
    assert.equal(result.cacheScope, "public");
    assert.ok(!("nextCursor" in result));
  });
});

describe("tools/call with valid arguments", () => {
  test("search_findings with flag reimport finds the 30 copies", async () => {
    const reply = await callTool("search_findings", { query: "", flag: "reimport" });
    const value = resultOf(reply).structuredContent;
    assert.equal(value.total, 30);
    assert.equal(value.limit, 20);
    assert.equal(value.findings.length, 20);
  });

  test("a search result carries the untrusted-data notice first", async () => {
    const reply = await callTool("search_findings", { query: "", limit: 2 });
    const value = resultOf(reply).structuredContent;
    assert.equal(Object.keys(value)[0], "notice");
    assert.match(value.notice, /^Untrusted data\./);
  });

  test("a search result has no facets and no raw records", async () => {
    const reply = await callTool("search_findings", { query: "", limit: 50 });
    const value = resultOf(reply).structuredContent;
    assert.deepEqual(Object.keys(value), ["notice", "total", "limit", "offset", "findings"]);
    assert.equal(value.findings.length, 50);
    for (const finding of value.findings) assert.ok(!("raw" in finding));
  });

  // Compared with assert.ok, not assert.equal, so that a failure cannot print the text,
  // which holds finding notes.
  test("the text block of a result is the structured content as JSON", async () => {
    const result = resultOf(await callTool("search_findings", { query: "", limit: 2 }));
    assert.equal(result.isError, undefined);
    assert.equal(result.content.length, 1);
    assert.equal(result.content[0].type, "text");
    const sameJson = result.content[0].text === JSON.stringify(result.structuredContent);
    assert.ok(sameJson, "the text block differs from the structured content");
  });

  test("get_finding with the shared id F-10578 returns both records, with raw", async () => {
    const value = resultOf(await callTool("get_finding", { id: "F-10578" })).structuredContent;
    const keys = value.findings.map((finding: Json) => finding.key);
    assert.deepEqual(keys, ["F-10578.1", "F-10578.2"]);
    for (const finding of value.findings) assert.ok("raw" in finding);
    assert.match(value.notice, /^Untrusted data\./);
  });

  test("list_cases returns the 40 cases", async () => {
    const value = resultOf(await callTool("list_cases", {})).structuredContent;
    assert.equal(value.cases.length, 40);
    assert.equal(value.findingsWithoutCase, 1);
    assert.match(value.notice, /^Untrusted data\./);
  });
});

// `send` checks on every answer of this file that it is not a stream and sets no session
// id. These two tests ask for the opposite as loudly as a client can.
describe("no sessions, no SSE", () => {
  test("a client that accepts only an event stream still gets one JSON object", async () => {
    const reply = await post(requestBody("tools/list"), { Accept: "text/event-stream" });
    resultOf(reply);
    assert.equal(reply.headers.get("content-type"), "application/json; charset=utf-8");
  });

  test("an Mcp-Session-Id header on a request is ignored and not sent back", async () => {
    const reply = await post(requestBody("tools/list"), { "Mcp-Session-Id": "abc-123" });
    resultOf(reply);
    assert.equal(reply.headers.get("mcp-session-id"), null);
    assert.ok(!reply.text.includes("abc-123"));
  });
});
