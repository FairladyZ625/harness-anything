import assert from "node:assert/strict";
import test from "node:test";
import { sha256Text, stablePayloadHash, stableStringify } from "../../src/integrity/stable-hash.ts";

test("stable stringify sorts object keys recursively", () => {
  assert.equal(
    stableStringify({ z: [{ b: 1, a: 2 }], a: true }),
    "{\"a\":true,\"z\":[{\"a\":2,\"b\":1}]}"
  );
});

test("stable payload hash ignores object insertion order", () => {
  assert.equal(
    stablePayloadHash({ nested: { b: "two", a: "one" }, list: [3, 2, 1] }),
    stablePayloadHash({ list: [3, 2, 1], nested: { a: "one", b: "two" } })
  );
});

test("sha256Text hashes utf8 text", () => {
  assert.equal(
    sha256Text("harness-anything"),
    "2373c279bb509d023feede46f08ab744683bcab5a52f64f18f8ec07916fd92d9"
  );
});
