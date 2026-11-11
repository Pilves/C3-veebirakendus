// The /api routes over real HTTP: the router is mounted on a bare Express app, which
// listens on a free port of this machine, and every test sends one request with fetch.
// The data is the real dataset. It is untrusted: the tests assert on ids, keys, counts
// and status codes only, and never print or name a note text.
// Not covered here: the security headers, the Host check and the JSON 404, which are
// added by server.ts and not by this router.

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
import { createApiRouter } from "./api.ts";

type Json = { [name: string]: any };

// One answer: the status, the Content-Type, the body as text and the same body parsed.
type Reply = { status: number; contentType: string; allow: string; text: string; body: Json };

const PUBLIC_KEYS = [
  "key",
  "id",
  "entity",
  "type",
  "caseIds",
  "observedAt",
  "sourceUrl",
  "notes",
  "duplicateOf",
  "flags",
];

let server: Server;
let baseUrl = "";

// Port 0 asks the system for any free port, so two test files never collide.
async function start(): Promise<void> {
  const findings = normaliseFindings(loadRawFindings());
  const app = express();
  app.use("/api", createApiRouter(createStore(findings), createSearch(findings)));
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
}

// Without this the open server would keep `node --test` from exiting.
function stop(): void {
  server.close();
  server.closeAllConnections();
}

// Every answer of this API is JSON, so the body is always parsed.
async function request(path: string, method = "GET"): Promise<Reply> {
  const response = await fetch(`${baseUrl}${path}`, { method });
  const text = await response.text();
  return {
    status: response.status,
    contentType: response.headers.get("content-type") ?? "",
    allow: response.headers.get("allow") ?? "",
    text,
    body: JSON.parse(text),
  };
}

// A refused request: 400, JSON, and nothing in the body but one fixed message.
function assertBadRequest(reply: Reply): void {
  assert.equal(reply.status, 400);
  assert.match(reply.contentType, /^application\/json/);
  assert.deepEqual(Object.keys(reply.body), ["error"]);
  assert.equal(typeof reply.body.error, "string");
}

before(start);
after(stop);

describe("GET /api/findings", () => {
  test("the default search returns the first 50 of 1002 findings as JSON", async () => {
    const reply = await request("/api/findings");
    assert.equal(reply.status, 200);
    assert.equal(reply.contentType, "application/json; charset=utf-8");
    assert.deepEqual(Object.keys(reply.body), ["total", "limit", "offset", "hits", "facets"]);
    assert.equal(reply.body.total, 1002);
    assert.equal(reply.body.limit, 50);
    assert.equal(reply.body.offset, 0);
    assert.equal(reply.body.hits.length, 50);
  });

  test("a hit holds exactly the public fields of a finding, without the raw record", async () => {
    const reply = await request("/api/findings");
    for (const hit of reply.body.hits) {
      assert.deepEqual(Object.keys(hit), ["finding", "tier", "entityRanges", "notesRanges"]);
      assert.deepEqual(Object.keys(hit.finding), PUBLIC_KEYS);
    }
  });

  test("the facets count all seven types", async () => {
    const reply = await request("/api/findings");
    assert.deepEqual(Object.keys(reply.body.facets), ["types", "flags"]);
    assert.deepEqual(Object.keys(reply.body.facets.types), [
      "domain",
      "ip",
      "email",
      "handle",
      "alias",
      "wallet",
      "unknown",
    ]);
  });

  test("duplicates=1 adds the 30 re-imported copies", async () => {
    const reply = await request("/api/findings?duplicates=1");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.total, 1032);
  });

  test("duplicates=0 is the default search", async () => {
    const reply = await request("/api/findings?duplicates=0");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.total, 1002);
  });

  test("type returns only findings of that type", async () => {
    const reply = await request("/api/findings?type=wallet&limit=200");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.total, 178);
    assert.equal(reply.body.hits.length, 178);
    for (const hit of reply.body.hits) assert.equal(hit.finding.type, "wallet");
  });

  test("case returns only findings of that case", async () => {
    const reply = await request("/api/findings?case=C-101");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.total, 33);
    for (const hit of reply.body.hits) assert.ok(hit.finding.caseIds.includes("C-101"));
  });

  test("the case value is not case-sensitive", async () => {
    const reply = await request("/api/findings?case=c-101");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.total, 33);
  });

  test("flag=reimport returns the 30 re-imported copies", async () => {
    const reply = await request("/api/findings?flag=reimport");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.total, 30);
    for (const hit of reply.body.hits) assert.ok(hit.finding.flags.includes("reimport"));
  });

  test("flag=type-mismatch returns 3 findings", async () => {
    const reply = await request("/api/findings?flag=type-mismatch");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.total, 3);
    assert.equal(reply.body.hits.length, 3);
  });

  test("the count on a type button equals the total after choosing that type", async () => {
    const unfiltered = await request("/api/findings?q=a");
    const filtered = await request("/api/findings?q=a&type=ip");
    assert.ok(filtered.body.total > 0);
    assert.equal(unfiltered.body.facets.types.ip, filtered.body.total);
  });

  test("limit sets the page size and leaves the total alone", async () => {
    const reply = await request("/api/findings?limit=3");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.limit, 3);
    assert.equal(reply.body.hits.length, 3);
    assert.equal(reply.body.total, 1002);
  });

  test("the largest limit, 200, is accepted", async () => {
    const reply = await request("/api/findings?limit=200");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.hits.length, 200);
  });

  test("offset skips that many findings", async () => {
    const firstPage = await request("/api/findings?limit=5");
    const shifted = await request("/api/findings?limit=3&offset=2");
    const keysOf = (reply: Reply) => reply.body.hits.map((hit: Json) => hit.finding.key);
    assert.equal(shifted.body.offset, 2);
    assert.deepEqual(keysOf(shifted), keysOf(firstPage).slice(2, 5));
  });

  test("an offset near the end returns the last findings only", async () => {
    const reply = await request("/api/findings?offset=1000");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.total, 1002);
    assert.equal(reply.body.hits.length, 2);
  });

  test("a q of 200 characters is accepted", async () => {
    const reply = await request(`/api/findings?q=${"a".repeat(200)}`);
    assert.equal(reply.status, 200);
    assert.equal(typeof reply.body.total, "number");
  });
});

// Every refusal is a 400 with a fixed message. Where the bad value is a text of its own,
// the test also checks that the answer does not repeat it.
describe("GET /api/findings refuses bad input with 400", () => {
  test("an unknown type", async () => {
    const reply = await request("/api/findings?type=zz_echo");
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("zz_echo"));
  });

  test("an empty type", async () => {
    assertBadRequest(await request("/api/findings?type="));
  });

  test("an unknown flag", async () => {
    const reply = await request("/api/findings?flag=zz_echo");
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("zz_echo"));
  });

  test("a duplicates value that is not 1, true, 0 or false", async () => {
    const reply = await request("/api/findings?duplicates=zz_echo");
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("zz_echo"));
  });

  // No echo check here: the fixed message names the range "1 to 200", which has a 0 in it.
  test("limit 0", async () => {
    assertBadRequest(await request("/api/findings?limit=0"));
  });

  test("limit 201, one above the largest", async () => {
    const reply = await request("/api/findings?limit=201");
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("201"));
  });

  test("a limit that is not a number", async () => {
    const reply = await request("/api/findings?limit=abc");
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("abc"));
  });

  test("a negative limit", async () => {
    const reply = await request("/api/findings?limit=-1");
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("-1"));
  });

  test("a limit in exponent form, 1e3", async () => {
    const reply = await request("/api/findings?limit=1e3");
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("1e3"));
  });

  test("a negative offset", async () => {
    const reply = await request("/api/findings?offset=-1");
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("-1"));
  });

  test("a q of 201 characters", async () => {
    const reply = await request(`/api/findings?q=${"a".repeat(201)}`);
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("aaa"));
  });

  test("q given twice", async () => {
    const reply = await request("/api/findings?q=zz_one&q=zz_two");
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("zz_"));
  });

  test("q given with brackets", async () => {
    const reply = await request("/api/findings?q[zz_echo]=1");
    assertBadRequest(reply);
    assert.ok(!reply.text.includes("zz_echo"));
  });
});

describe("GET /api/findings/:id", () => {
  test("a plain id returns a list of one finding, with its raw record", async () => {
    const reply = await request("/api/findings/F-10062");
    assert.equal(reply.status, 200);
    assert.equal(reply.contentType, "application/json; charset=utf-8");
    assert.deepEqual(Object.keys(reply.body), ["findings"]);
    assert.equal(reply.body.findings.length, 1);
    assert.deepEqual(Object.keys(reply.body.findings[0]), [...PUBLIC_KEYS, "raw"]);
    assert.equal(reply.body.findings[0].raw.id, "F-10062");
  });

  test("a key returns the one finding with that key", async () => {
    const reply = await request("/api/findings/F-10578.2");
    assert.equal(reply.status, 200);
    assert.equal(reply.body.findings.length, 1);
    assert.equal(reply.body.findings[0].key, "F-10578.2");
    assert.equal(reply.body.findings[0].id, "F-10578");
  });

  test("an id shared by two records returns both, each with its raw record", async () => {
    const reply = await request("/api/findings/F-10578");
    assert.equal(reply.status, 200);
    const keys = reply.body.findings.map((finding: Json) => finding.key);
    assert.deepEqual(keys, ["F-10578.1", "F-10578.2"]);
    for (const finding of reply.body.findings) assert.ok("raw" in finding);
  });

  // The note of F-10062 contains markup. It must leave the server exactly as stored:
  // escaping is the job of whoever shows it. Compared with assert.ok, not assert.equal,
  // so that a failure cannot print the note.
  test("a note with markup is returned unchanged", async () => {
    const reply = await request("/api/findings/F-10062");
    const finding = reply.body.findings[0];
    assert.equal(typeof finding.notes, "string");
    assert.ok(finding.notes.includes("<"), "the note of F-10062 contains markup");
    assert.ok(finding.notes === finding.raw.notes, "notes differs from raw.notes");
  });

  test("an unknown id is a 404 with a JSON error", async () => {
    const reply = await request("/api/findings/F-99999");
    assert.equal(reply.status, 404);
    assert.match(reply.contentType, /^application\/json/);
    assert.deepEqual(Object.keys(reply.body), ["error"]);
  });

  test("an id that looks like markup is a 404 and is not sent back", async () => {
    const reply = await request("/api/findings/%3Cscript%3E");
    assert.equal(reply.status, 404);
    assert.deepEqual(Object.keys(reply.body), ["error"]);
    assert.ok(!reply.text.includes("script"));
  });

  test("the id __proto__ is a 404 and is not sent back", async () => {
    const reply = await request("/api/findings/__proto__");
    assert.equal(reply.status, 404);
    assert.deepEqual(Object.keys(reply.body), ["error"]);
    assert.ok(!reply.text.includes("proto"));
  });

  test("an id that cannot be URL-decoded is a 400 with a JSON error", async () => {
    const reply = await request("/api/findings/%E0%A4");
    assertBadRequest(reply);
  });
});

describe("GET /api/cases", () => {
  test("lists the 40 cases, sorted by case id", async () => {
    const reply = await request("/api/cases");
    assert.equal(reply.status, 200);
    assert.equal(reply.contentType, "application/json; charset=utf-8");
    assert.deepEqual(Object.keys(reply.body), ["cases", "findingsWithoutCase"]);
    assert.equal(reply.body.cases.length, 40);
    const caseIds = reply.body.cases.map((summary: Json) => summary.caseId);
    assert.deepEqual(caseIds, [...caseIds].sort());
  });

  // 1002 is also the total of the default search, but only by chance: one finding
  // belongs to two cases and is counted twice, and one belongs to no case at all.
  test("the findings of all cases add up to 1002, the re-imports to 30", async () => {
    const reply = await request("/api/cases");
    let findings = 0;
    let duplicates = 0;
    for (const summary of reply.body.cases) {
      findings += summary.findings;
      duplicates += summary.duplicates;
    }
    assert.equal(findings, 1002);
    assert.equal(duplicates, 30);
    assert.equal(reply.body.findingsWithoutCase, 1);
  });

  test("the type counts of every case add up to its findings", async () => {
    const reply = await request("/api/cases");
    for (const summary of reply.body.cases) {
      let sum = 0;
      for (const count of Object.values(summary.types)) sum += count as number;
      assert.equal(sum, summary.findings, summary.caseId);
    }
  });

  test("the count of a case equals the total of a search in that case", async () => {
    const cases = await request("/api/cases");
    const first = cases.body.cases[0];
    const search = await request(`/api/findings?case=${first.caseId}`);
    assert.equal(search.body.total, first.findings);
  });
});

describe("the API is read-only", () => {
  for (const path of ["/api/findings", "/api/findings/F-10062", "/api/cases"]) {
    test(`POST ${path} is a 405 that names the allowed methods`, async () => {
      const reply = await request(path, "POST");
      assert.equal(reply.status, 405);
      assert.equal(reply.allow, "GET, HEAD");
      assert.match(reply.contentType, /^application\/json/);
      assert.deepEqual(Object.keys(reply.body), ["error"]);
    });
  }

  test("DELETE is refused like POST", async () => {
    const reply = await request("/api/findings/F-10062", "DELETE");
    assert.equal(reply.status, 405);
    assert.equal(reply.allow, "GET, HEAD");
  });
});
