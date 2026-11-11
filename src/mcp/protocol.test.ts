import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  PROTOCOL_VERSION,
  ProtocolError,
  bodyParserError,
  checkBeforeBody,
  checkRequest,
  decodeHeaderValue,
  discoverResult,
  errorResponse,
  isAllowedOrigin,
  listToolsResult,
  parseAllowedOrigins,
  readMessage,
  readableId,
  resultResponse,
  toolArgumentsOf,
  toolNameOf,
} from "./protocol.ts";
import type { Headers, Message } from "./protocol.ts";

const META = {
  "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION,
  "io.modelcontextprotocol/clientCapabilities": {},
};

// Asserts that `run` throws a ProtocolError with this HTTP status and JSON-RPC code,
// and returns it so a test can look at the message or data too.
function rejected(run: () => unknown, status: number, code: number): ProtocolError {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof ProtocolError, "a ProtocolError is thrown");
    assert.deepEqual({ status: error.status, code: error.code }, { status, code });
    return error;
  }
  assert.fail("nothing was thrown");
}

// Headers as Node delivers them: names in lower case.
function headers(overrides: Headers = {}): Headers {
  return {
    "content-type": "application/json",
    "mcp-protocol-version": PROTOCOL_VERSION,
    "mcp-method": "tools/list",
    ...overrides,
  };
}

function request(overrides: Partial<Message> = {}): Message {
  return { id: 1, method: "tools/list", params: { _meta: META }, ...overrides };
}

// ======================================================================================
// Step 1: Origin
// ======================================================================================

describe("isAllowedOrigin", () => {
  test("no Origin header is allowed: the caller is not a browser page", () => {
    assert.equal(isAllowedOrigin(undefined, []), true);
  });

  test("this machine is allowed on any port and scheme", () => {
    for (const origin of [
      "http://localhost",
      "http://localhost:3000",
      "https://localhost:8443",
      "http://127.0.0.1:5173",
      "http://[::1]:3000",
    ]) {
      assert.equal(isAllowedOrigin(origin, []), true, origin);
    }
  });

  test("other sites, look-alikes and null are refused", () => {
    for (const origin of [
      "https://evil.example",
      "http://localhost.evil.example",
      "http://evil.example/localhost",
      "http://localhost@evil.example",
      "http://127.0.0.1.evil.example",
      "null",
      "",
      "localhost",
      "file://localhost",
      "http://localhost:3000, https://evil.example",
      "http://localhost:3000/path",
      "http://localhost\\.evil.example",
      "HTTP://LOCALHOST:3000",
    ]) {
      assert.equal(isAllowedOrigin(origin, []), false, origin);
    }
  });

  test("a listed origin is allowed only when it is exactly the same text", () => {
    const allowed = ["https://tools.example"];
    assert.equal(isAllowedOrigin("https://tools.example", allowed), true);
    assert.equal(isAllowedOrigin("https://tools.example:8443", allowed), false);
    assert.equal(isAllowedOrigin("http://tools.example", allowed), false);
    assert.equal(isAllowedOrigin("https://tools.example.evil.example", allowed), false);
  });
});

describe("parseAllowedOrigins", () => {
  test("unset or empty means no extra origins", () => {
    assert.deepEqual(parseAllowedOrigins(undefined), []);
    assert.deepEqual(parseAllowedOrigins(""), []);
    assert.deepEqual(parseAllowedOrigins(" , "), []);
  });

  test("splits on commas and trims", () => {
    assert.deepEqual(parseAllowedOrigins("https://a.example, https://b.example:8443 ,"), [
      "https://a.example",
      "https://b.example:8443",
    ]);
  });
});

// ======================================================================================
// Steps 1-3: before the body
// ======================================================================================

describe("checkBeforeBody", () => {
  test("a JSON POST without Origin passes", () => {
    checkBeforeBody("POST", headers(), []);
    checkBeforeBody("POST", headers({ "content-type": "application/json; charset=utf-8" }), []);
    checkBeforeBody("POST", headers({ "content-type": "Application/JSON" }), []);
  });

  test("step 1: a foreign Origin is 403", () => {
    const error = rejected(
      () => checkBeforeBody("POST", headers({ origin: "https://evil.example" }), []),
      403,
      -32600,
    );
    assert.doesNotMatch(error.message, /evil/, "the message does not repeat the origin");
  });

  test("step 1 comes before step 2: a foreign Origin on GET is 403, not 405", () => {
    rejected(() => checkBeforeBody("GET", { origin: "https://evil.example" }, []), 403, -32600);
  });

  test("step 2: every method but POST is 405", () => {
    for (const method of ["GET", "DELETE", "PUT", "PATCH", "OPTIONS", "HEAD"]) {
      rejected(() => checkBeforeBody(method, headers(), []), 405, -32600);
    }
  });

  test("step 3: a missing or different Content-Type is 415", () => {
    for (const contentType of [undefined, "text/plain", "application/jsonx", "text/json"]) {
      rejected(
        () => checkBeforeBody("POST", headers({ "content-type": contentType }), []),
        415,
        -32600,
      );
    }
  });
});

// ======================================================================================
// Step 4: body parser failures
// ======================================================================================

describe("bodyParserError", () => {
  test("too large is 413", () => {
    const error = bodyParserError({ type: "entity.too.large", status: 413 });
    assert.deepEqual([error.status, error.code], [413, -32600]);
  });

  test("broken JSON is 400 with the parse error code", () => {
    const failure = Object.assign(new SyntaxError("Unexpected token"), {
      type: "entity.parse.failed",
      status: 400,
    });
    const error = bodyParserError(failure);
    assert.deepEqual([error.status, error.code], [400, -32700]);
    assert.doesNotMatch(error.message, /Unexpected token/, "parser text is not passed on");
  });

  test("an unsupported charset is 415, another client error is 400", () => {
    assert.equal(bodyParserError({ type: "charset.unsupported", status: 415 }).status, 415);
    const aborted = bodyParserError({ type: "request.aborted", status: 400 });
    assert.deepEqual([aborted.status, aborted.code], [400, -32600]);
  });

  test("anything unexpected is a 500 with a fixed message", () => {
    for (const failure of [new Error("secret detail"), "text", null, undefined]) {
      const error = bodyParserError(failure);
      assert.deepEqual([error.status, error.code], [500, -32603]);
      assert.equal(error.message, "Internal error");
    }
  });
});

// ======================================================================================
// Steps 5-6: the JSON-RPC message
// ======================================================================================

describe("readMessage", () => {
  test("a request keeps its id, method and params", () => {
    const params = { _meta: META };
    assert.deepEqual(readMessage({ jsonrpc: "2.0", id: 7, method: "tools/list", params }), {
      id: 7,
      method: "tools/list",
      params,
    });
  });

  test("a string id is fine", () => {
    assert.equal(readMessage({ jsonrpc: "2.0", id: "abc", method: "x" }).id, "abc");
  });

  test("step 6: without an id it is a notification", () => {
    const message = readMessage({ jsonrpc: "2.0", method: "notifications/cancelled" });
    assert.equal(message.id, undefined);
  });

  test("step 5: a batch array is refused", () => {
    const one = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    rejected(() => readMessage([one, one]), 400, -32600);
  });

  test("step 5: other values that are not an object are refused", () => {
    for (const body of [undefined, null, "text", 5, true, []]) {
      rejected(() => readMessage(body), 400, -32600);
    }
  });

  test("step 5: jsonrpc must be exactly 2.0", () => {
    rejected(() => readMessage({ jsonrpc: "1.0", id: 1, method: "tools/list" }), 400, -32600);
    rejected(() => readMessage({ jsonrpc: 2, id: 1, method: "tools/list" }), 400, -32600);
    rejected(() => readMessage({ id: 1, method: "tools/list" }), 400, -32600);
  });

  test("step 5: method must be a string", () => {
    rejected(() => readMessage({ jsonrpc: "2.0", id: 1 }), 400, -32600);
    rejected(() => readMessage({ jsonrpc: "2.0", id: 1, method: 5 }), 400, -32600);
  });

  test("step 5: id must be a string or number, and not null", () => {
    for (const id of [null, true, {}, [1]]) {
      rejected(() => readMessage({ jsonrpc: "2.0", id, method: "tools/list" }), 400, -32600);
    }
  });

  test("step 5: a response object is refused", () => {
    rejected(() => readMessage({ jsonrpc: "2.0", id: 1, result: {} }), 400, -32600);
    rejected(() => readMessage({ jsonrpc: "2.0", id: 1, error: { code: 1 } }), 400, -32600);
    rejected(() => readMessage({ jsonrpc: "2.0", id: 1, method: "x", result: {} }), 400, -32600);
  });
});

describe("readableId", () => {
  test("returns a string or number id", () => {
    assert.equal(readableId({ id: 5 }), 5);
    assert.equal(readableId({ id: "a" }), "a");
    assert.equal(readableId({ jsonrpc: "1.0", id: 44 }), 44);
  });

  test("returns undefined when there is no usable id", () => {
    for (const body of [undefined, null, [], [{ id: 1 }], "id", {}, { id: null }, { id: {} }]) {
      assert.equal(readableId(body), undefined);
    }
  });
});

// ======================================================================================
// Steps 7-10: headers and _meta
// ======================================================================================

describe("checkRequest", () => {
  test("a complete request passes", () => {
    checkRequest(headers(), request());
  });

  test("clientInfo is optional and unknown _meta keys are ignored", () => {
    const _meta = { ...META, "io.modelcontextprotocol/clientInfo": { name: "x" }, other: 1 };
    checkRequest(headers(), request({ params: { _meta } }));
  });

  test("step 7: a missing MCP-Protocol-Version header names the supported version", () => {
    const error = rejected(
      () => checkRequest(headers({ "mcp-protocol-version": undefined }), request()),
      400,
      -32020,
    );
    assert.match(error.message, /2026-07-28/);
  });

  test("step 7: a missing Mcp-Method header", () => {
    rejected(() => checkRequest(headers({ "mcp-method": undefined }), request()), 400, -32020);
  });

  test("step 7: an old-style initialize without the headers gets -32020 and the version", () => {
    const params = { protocolVersion: "2025-11-25", capabilities: {} };
    const error = rejected(
      () => checkRequest({}, request({ method: "initialize", params })),
      400,
      -32020,
    );
    assert.match(error.message, /2026-07-28/);
  });

  test("step 8: another version lists the supported one and repeats the requested one", () => {
    const error = rejected(
      () => checkRequest(headers({ "mcp-protocol-version": "2025-11-25" }), request()),
      400,
      -32022,
    );
    assert.deepEqual(error.data, { supported: ["2026-07-28"], requested: "2025-11-25" });
  });

  test("step 8 comes before step 9: an old header with a new body is -32022", () => {
    rejected(
      () => checkRequest(headers({ "mcp-protocol-version": "1900-01-01" }), request()),
      400,
      -32022,
    );
  });

  test("step 9: Mcp-Method must equal the body method, case included", () => {
    rejected(() => checkRequest(headers({ "mcp-method": "tools/call" }), request()), 400, -32020);
    rejected(() => checkRequest(headers({ "mcp-method": "Tools/List" }), request()), 400, -32020);
  });

  test("step 9: the header version must equal the body version", () => {
    const _meta = { ...META, "io.modelcontextprotocol/protocolVersion": "2025-11-25" };
    rejected(() => checkRequest(headers(), request({ params: { _meta } })), 400, -32020);
  });

  test("step 10: missing params, _meta or protocol version is -32602", () => {
    const withoutVersion = { "io.modelcontextprotocol/clientCapabilities": {} };
    for (const params of [undefined, {}, [], { _meta: {} }, { _meta: withoutVersion }]) {
      rejected(() => checkRequest(headers(), request({ params })), 400, -32602);
    }
  });

  test("step 10: client capabilities must be present and an object", () => {
    const version = { "io.modelcontextprotocol/protocolVersion": PROTOCOL_VERSION };
    for (const capabilities of [undefined, null, "all", []]) {
      const _meta = { ...version, "io.modelcontextprotocol/clientCapabilities": capabilities };
      rejected(() => checkRequest(headers(), request({ params: { _meta } })), 400, -32602);
    }
  });
});

// ======================================================================================
// Step 12: tools/call
// ======================================================================================

function base64Header(text: string): string {
  return `=?base64?${Buffer.from(text, "utf8").toString("base64")}?=`;
}

describe("decodeHeaderValue", () => {
  test("a plain value is returned as it is", () => {
    assert.equal(decodeHeaderValue("list_cases"), "list_cases");
  });

  test("the examples from the spec decode", () => {
    assert.equal(decodeHeaderValue("=?base64?SGVsbG8sIOS4lueVjA==?="), "Hello, 世界");
    assert.equal(decodeHeaderValue("=?base64?IHBhZGRlZCA=?="), " padded ");
    assert.equal(decodeHeaderValue("=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="), "=?base64?literal?=");
  });

  test("damaged base64 is refused instead of being read leniently", () => {
    assert.equal(decodeHeaderValue("=?base64?bGlz!dF9jYXNlcw==?="), undefined);
    assert.equal(decodeHeaderValue("=?base64?bGlzdF9jYXNlcw?="), undefined, "no padding");
    assert.equal(decodeHeaderValue("=?base64?/w==?="), undefined, "not UTF-8");
    assert.equal(decodeHeaderValue("=?base64??="), "");
  });

  test("the markers are case-sensitive and both are needed", () => {
    assert.equal(decodeHeaderValue("=?BASE64?bGlzdA==?="), "=?BASE64?bGlzdA==?=");
    assert.equal(decodeHeaderValue("=?base64?bGlzdA=="), "=?base64?bGlzdA==");
  });
});

describe("toolNameOf", () => {
  test("returns the name when the header agrees", () => {
    assert.equal(toolNameOf({ "mcp-name": "list_cases" }, { name: "list_cases" }), "list_cases");
  });

  test("a base64 header is decoded before comparing", () => {
    const header = { "mcp-name": base64Header("list_cases") };
    assert.equal(toolNameOf(header, { name: "list_cases" }), "list_cases");
    const unicode = { "mcp-name": base64Header("otsi_öö") };
    assert.equal(toolNameOf(unicode, { name: "otsi_öö" }), "otsi_öö");
  });

  test("a missing or different header is -32020", () => {
    rejected(() => toolNameOf({}, { name: "list_cases" }), 400, -32020);
    rejected(() => toolNameOf({ "mcp-name": "get_finding" }, { name: "list_cases" }), 400, -32020);
    rejected(() => toolNameOf({ "mcp-name": "List_Cases" }, { name: "list_cases" }), 400, -32020);
    const wrong = { "mcp-name": base64Header("get_finding") };
    rejected(() => toolNameOf(wrong, { name: "list_cases" }), 400, -32020);
    const damaged = { "mcp-name": "=?base64?bGlz!dF9jYXNlcw==?=" };
    rejected(() => toolNameOf(damaged, { name: "list_cases" }), 400, -32020);
  });

  test("a name that is not a string is -32602", () => {
    for (const params of [undefined, {}, { name: 5 }, { name: null }, []]) {
      rejected(() => toolNameOf({ "mcp-name": "list_cases" }, params), 400, -32602);
    }
  });

  test("the error does not repeat the header or the name", () => {
    const error = rejected(() => toolNameOf({ "mcp-name": "aaa" }, { name: "bbb" }), 400, -32020);
    assert.doesNotMatch(error.message, /aaa|bbb/);
  });
});

describe("toolArgumentsOf", () => {
  test("omitted arguments mean none", () => {
    assert.deepEqual(toolArgumentsOf({ name: "list_cases" }), {});
  });

  test("an object is returned as it is", () => {
    assert.deepEqual(toolArgumentsOf({ arguments: { query: "x" } }), { query: "x" });
  });

  test("anything else is -32602", () => {
    for (const args of [[], null, "text", 5]) {
      rejected(() => toolArgumentsOf({ arguments: args }), 400, -32602);
    }
  });
});

// ======================================================================================
// Responses
// ======================================================================================

// What actually goes over the wire: fields that are undefined disappear.
function onTheWire(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe("responses", () => {
  test("every result is complete and names the server", () => {
    assert.deepEqual(resultResponse("r1", { tools: [] }), {
      jsonrpc: "2.0",
      id: "r1",
      result: {
        resultType: "complete",
        tools: [],
        _meta: {
          "io.modelcontextprotocol/serverInfo": { name: "findings-search", version: "0.1.0" },
        },
      },
    });
  });

  test("an error carries the id when there is one", () => {
    const error = new ProtocolError(404, -32601, "Method not found");
    assert.deepEqual(onTheWire(errorResponse(3, error)), {
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32601, message: "Method not found" },
    });
  });

  test("an error without a readable id has no id field", () => {
    const error = new ProtocolError(400, -32700, "Parse error");
    assert.deepEqual(onTheWire(errorResponse(undefined, error)), {
      jsonrpc: "2.0",
      error: { code: -32700, message: "Parse error" },
    });
  });

  test("error data is passed on", () => {
    const error = new ProtocolError(400, -32022, "Unsupported", { supported: ["x"] });
    const body = onTheWire(errorResponse(1, error)) as { error: { data: unknown } };
    assert.deepEqual(body.error.data, { supported: ["x"] });
  });

  test("server/discover: version, tools capability without listChanged, cache hints", () => {
    const result = discoverResult();
    assert.deepEqual(result.supportedVersions, ["2026-07-28"]);
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.equal(typeof result.instructions, "string");
    assert.equal(result.ttlMs, 300_000);
    assert.equal(result.cacheScope, "public");
  });

  test("tools/list: the tools, cache hints, no nextCursor", () => {
    assert.deepEqual(listToolsResult([{ name: "a" }]), {
      tools: [{ name: "a" }],
      ttlMs: 300_000,
      cacheScope: "public",
    });
  });
});
