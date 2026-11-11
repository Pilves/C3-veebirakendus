// The app-wide wiring of app.ts over real HTTP: security headers, the Host check,
// Cache-Control, the JSON 404 and the static files. The routers have their own tests.

import assert from "node:assert/strict";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";
import { createApp } from "./app.ts";
import { normaliseFindings } from "./data/normalise.ts";
import { createStore } from "./data/store.ts";
import { createSearch } from "./search/search.ts";
import { loadRawFindings } from "./testing.ts";

type Reply = { status: number; headers: IncomingHttpHeaders; text: string };

let server: Server;
let port = 0;

async function start(): Promise<void> {
  const findings = normaliseFindings(loadRawFindings());
  const app = createApp(createStore(findings), createSearch(findings), ["tool.example"]);
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  port = (server.address() as AddressInfo).port;
}

function stop(): void {
  server.close();
  server.closeAllConnections();
}

// node:http and not fetch: fetch does not let a caller choose the Host header.
function get(path: string, host = `127.0.0.1:${port}`): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const options = { host: "127.0.0.1", port, path, headers: { Host: host } };
    const request = httpRequest(options, (response) => {
      let text = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => (text += chunk));
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text });
      });
    });
    request.on("error", reject);
    request.end();
  });
}

before(start);
after(stop);

describe("the Host check", () => {
  test("a foreign Host is a 403 with a JSON error that does not repeat it", async () => {
    const reply = await get("/api/cases", "evil.example");
    assert.equal(reply.status, 403);
    assert.deepEqual(Object.keys(JSON.parse(reply.text)), ["error"]);
    assert.ok(!reply.text.includes("evil"));
  });

  test("a foreign Host is refused for the static files too", async () => {
    const reply = await get("/", "evil.example");
    assert.equal(reply.status, 403);
  });

  test("the refusal carries the security headers", async () => {
    const reply = await get("/api/cases", "evil.example");
    assert.equal(reply.headers["x-content-type-options"], "nosniff");
    assert.ok(reply.headers["content-security-policy"] !== undefined);
  });

  test("localhost on any port is allowed", async () => {
    const reply = await get("/api/cases", "localhost:9");
    assert.equal(reply.status, 200);
  });

  test("a hostname from the allowed list is allowed", async () => {
    const reply = await get("/api/cases", "tool.example");
    assert.equal(reply.status, 200);
  });
});

describe("headers on every answer", () => {
  test("the security headers are set and X-Powered-By is not", async () => {
    const reply = await get("/api/cases");
    assert.match(String(reply.headers["content-security-policy"]), /^default-src 'none';/);
    assert.equal(reply.headers["x-content-type-options"], "nosniff");
    assert.equal(reply.headers["referrer-policy"], "no-referrer");
    assert.equal(reply.headers["cross-origin-opener-policy"], "same-origin");
    assert.equal(reply.headers["cross-origin-resource-policy"], "same-origin");
    assert.equal(reply.headers["x-powered-by"], undefined);
  });

  test("answers under /api and /mcp are not cached", async () => {
    assert.equal((await get("/api/cases")).headers["cache-control"], "no-store");
    assert.equal((await get("/mcp")).headers["cache-control"], "no-store");
  });

  test("the static page is not marked no-store", async () => {
    const reply = await get("/");
    assert.equal(reply.status, 200);
    assert.match(String(reply.headers["content-type"]), /^text\/html/);
    assert.notEqual(reply.headers["cache-control"], "no-store");
  });
});

describe("paths nothing answers", () => {
  for (const path of ["/zz_echo", "/api/zz_echo", "/mcp/zz_echo"]) {
    test(`${path} is a JSON 404 that does not repeat the path`, async () => {
      const reply = await get(path);
      assert.equal(reply.status, 404);
      assert.match(String(reply.headers["content-type"]), /^application\/json/);
      assert.deepEqual(JSON.parse(reply.text), { error: "Not found" });
    });
  }
});
