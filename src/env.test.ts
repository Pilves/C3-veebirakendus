import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { parsePort, valueOr } from "./env.ts";

describe("valueOr", () => {
  test("a set value is used, trimmed", () => {
    assert.equal(valueOr("0.0.0.0", "127.0.0.1"), "0.0.0.0");
    assert.equal(valueOr(" 3100 ", "3000"), "3100");
  });

  test("unset, empty and blank all give the default", () => {
    for (const value of [undefined, "", "   "]) {
      assert.equal(valueOr(value, "127.0.0.1"), "127.0.0.1");
    }
  });
});

describe("parsePort", () => {
  test("a whole number from 1 to 65535 is a port", () => {
    assert.equal(parsePort("1"), 1);
    assert.equal(parsePort("3000"), 3000);
    assert.equal(parsePort("65535"), 65535);
  });

  test("anything else is refused", () => {
    for (const text of ["", "0", "65536", "99999", "abc", "3000abc", "-1", "30.5", "1e3", " 80"]) {
      assert.equal(parsePort(text), undefined, text);
    }
  });
});
