// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localSystemBinding } from "../src/daemon-host-binding.ts";

test("local system binding uses the stable owner fallback when no POSIX UID exists", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-daemon-binding-fallback-"));
  try {
    const binding = localSystemBinding(rootDir),
      ownerUid = process.getuid?.() ?? 0;
    assert.equal(binding.source, "local");
    assert.equal(binding.authorizationBindingMode, "default");
    assert.equal(binding.actor.principal.personId, `local-user-${ownerUid}`);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
