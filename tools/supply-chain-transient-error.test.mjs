// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";

import { isTransientRegistryError } from "./supply-chain-transient-error.mjs";

test("isTransientRegistryError matches transient npm registry/transport failures", () => {
  const transient = [
    "npm warn audit 503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk - Service Unavailable\nnpm error audit endpoint returned an error",
    "npm error code E502\nnpm error 502 Bad Gateway",
    "npm error 504 Gateway Timeout",
    "npm error 429 Too Many Requests",
    "npm error network request to https://registry.npmjs.org/ failed, reason: socket hang up",
    "Error: read ECONNRESET",
    "npm error network connect ETIMEDOUT",
    "npm error getaddrinfo EAI_AGAIN registry.npmjs.org",
    "npm error network This is a problem related to network connectivity"
  ];
  for (const output of transient) {
    assert.equal(isTransientRegistryError(output), true, `expected transient: ${output}`);
  }
});

test("isTransientRegistryError never matches a real audit finding or non-transient failure", () => {
  const nonTransient = [
    "found 3 high severity vulnerabilities in 1200 scanned packages",
    "# npm audit report\n\nlodash  <4.17.21\nSeverity: high\nPrototype Pollution",
    "1 critical severity vulnerability",
    "npm error code ELSPROBLEMS\nnpm error invalid: lodash@4.17.20",
    "unexpected npm args: sbom",
    ""
  ];
  for (const output of nonTransient) {
    assert.equal(isTransientRegistryError(output), false, `expected non-transient: ${output}`);
  }
});

test("isTransientRegistryError tolerates non-string input", () => {
  assert.equal(isTransientRegistryError(undefined), false);
  assert.equal(isTransientRegistryError(null), false);
  assert.equal(isTransientRegistryError(503), false);
});
