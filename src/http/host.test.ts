import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isAllowedHost, parseAllowedHosts } from "./host.ts";

describe("isAllowedHost", () => {
  test("this machine is allowed, with or without a port", () => {
    for (const host of [
      "localhost",
      "localhost:3000",
      "127.0.0.1",
      "127.0.0.1:3000",
      "127.0.0.1:65535",
      "[::1]",
      "[::1]:3000",
    ]) {
      assert.equal(isAllowedHost(host, []), true, host);
    }
  });

  test("letter case and a final dot do not change the name", () => {
    for (const host of ["LOCALHOST:3000", "LocalHost", "localhost.", "localhost.:3000"]) {
      assert.equal(isAllowedHost(host, []), true, host);
    }
  });

  test("other names and look-alikes are refused", () => {
    for (const host of [
      "evil.example",
      "evil.example:3000",
      "localhost.evil.example",
      "localhost.evil.example:3000",
      "127.0.0.1.evil.example",
      "evil.example.",
      "notlocalhost",
      "127.0.0.2",
      "0.0.0.0:3000",
      "[::2]:3000",
      "::1",
    ]) {
      assert.equal(isAllowedHost(host, []), false, host);
    }
  });

  test("a missing, empty or malformed header is refused", () => {
    for (const host of [
      undefined,
      "",
      " ",
      ":3000",
      "localhost:",
      "localhost:abc",
      "localhost:3000:3000",
      "localhost:123456",
      "localhost..",
      "localhost/evil.example",
      "localhost@evil.example",
      "evil.example@localhost",
      "localhost evil.example",
      "localhost,evil.example",
      "http://localhost:3000",
      "[::1",
      "[]",
      "\u0000",
      "a".repeat(100_000),
    ]) {
      assert.equal(isAllowedHost(host, []), false, String(host).slice(0, 40));
    }
  });

  test("a listed hostname is allowed on any port, and only as a whole name", () => {
    const allowed = ["findings.internal.example"];
    assert.equal(isAllowedHost("findings.internal.example", allowed), true);
    assert.equal(isAllowedHost("Findings.Internal.Example:8443", allowed), true);
    assert.equal(isAllowedHost("internal.example", allowed), false);
    assert.equal(isAllowedHost("findings.internal.example.evil.example", allowed), false);
    assert.equal(isAllowedHost("evil.example", allowed), false);
    assert.equal(isAllowedHost("localhost:3000", allowed), true, "local names stay allowed");
  });
});

describe("parseAllowedHosts", () => {
  test("unset or empty means no extra hostnames", () => {
    assert.deepEqual(parseAllowedHosts(undefined), []);
    assert.deepEqual(parseAllowedHosts(""), []);
    assert.deepEqual(parseAllowedHosts(" , "), []);
  });

  test("splits on commas, trims and lowercases", () => {
    assert.deepEqual(parseAllowedHosts("Tools.Example, other.example ,"), [
      "tools.example",
      "other.example",
    ]);
  });
});
