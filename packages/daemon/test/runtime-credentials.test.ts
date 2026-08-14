// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openRuntimeCredentialBindings } from "../src/runtime-credentials.ts";
import { validateRuntimeCredentialReceipt } from "../src/gui-s3-control.ts";

test("runtime credential bindings persist only an opaque native-store reference and return a redacted receipt", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-credential-"));
    try {
      const bindings = openRuntimeCredentialBindings({ userRoot: root, now: () => "2026-08-14T00:00:00.000Z" });
      const receipt = bindings.bind({ authorityRepoId: "repo-a", kindId: "codex", baseUrl: "https://api.example.test", credentialRef: "keychain:harness/codex" });
      assert.deepEqual(validateRuntimeCredentialReceipt(receipt), []);
      assert.doesNotMatch(JSON.stringify(receipt), /credentialRef/u);
      assert.doesNotMatch(readFileSync(path.join(root, "runtime-credential-bindings.json"), "utf8"), /apiKey/u);
      assert.equal(bindings.read("codex")?.credentialRef, "keychain:harness/codex");
    } finally { rmSync(root, { recursive: true, force: true }); }
});
