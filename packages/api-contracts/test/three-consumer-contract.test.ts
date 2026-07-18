// harness-test-tier: contract
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { decodeClientConnectionState } from "../../daemon-client/src/contract-decoder.ts";
import { decodeWebviewConnectionState } from "../../vscode-ext/src/webview-host/contract-decoder.ts";
import { decodeRendererSafeConnectionState } from "../src/renderer-safe-state.ts";

const decoders = [decodeRendererSafeConnectionState, decodeClientConnectionState, decodeWebviewConnectionState];

test("one valid fixture is accepted identically by api-contracts, daemon-client and vscode-ext", async () => {
  const fixture = await fixtureJson("valid.json");
  const decoded = decoders.map((decode) => decode(fixture));
  assert.deepEqual(decoded[1], decoded[0]);
  assert.deepEqual(decoded[2], decoded[0]);
});

test("one invalid fixture is rejected by all three consumers", async () => {
  const fixture = await fixtureJson("invalid.json");
  for (const decode of decoders) assert.throws(() => decode(fixture), /non-serializable connection field: descriptor/u);
});

test("positive control proves the secret-field detector observes every forbidden contract field", () => {
  for (const field of ["descriptor", "token", "credential", "hash", "rawPath", "pid"] as const) {
    assert.throws(() => decodeRendererSafeConnectionState({
      repo: { endpoint: "unix:/fixture", repoId: "repo-a" },
      state: "live",
      [field]: "injected"
    }), new RegExp(field, "u"));
  }
});

async function fixtureJson(fileName: string): Promise<unknown> {
  const url = new URL(`../fixtures/renderer-safe-connection-state/${fileName}`, import.meta.url);
  return JSON.parse(await readFile(url, "utf8")) as unknown;
}
