// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { localRuntimeStateFileSystem } from "../../src/local/local-layout-file-system.ts";

test("activation certificate publication has only pre-link and complete post-link states", () => {
  for (const point of ["temporary-synced", "linked", "directory-synced"] as const) {
    const root = mkdtempSync(path.join(tmpdir(), "ha-generation-certificate-")),
      certificate = path.join(root, "ledger.sqlite.activation.json"),
      body = '{"schema":"generation-activation/v2","generation":3}\n';
    try {
      assert.throws(
        () =>
          localRuntimeStateFileSystem.createAtomicExclusiveText(certificate, body, (candidate) => {
            if (candidate === point) throw new Error(`killpoint:${point}`);
          }),
        new RegExp(`killpoint:${point}`, "u"),
      );
      if (point === "temporary-synced") assert.equal(existsSync(certificate), false);
      else assert.equal(readFileSync(certificate, "utf8"), body);
      assert.deepEqual(
        readdirSync(root).filter((name) => name.includes(".tmp-")),
        [],
        "temporary certificate is always cleaned",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("atomic activation is idempotent only for the already published certificate", () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-generation-certificate-")),
    certificate = path.join(root, "ledger.sqlite.activation.json"),
    body = '{"schema":"generation-activation/v2","generation":3}\n';
  try {
    assert.equal(localRuntimeStateFileSystem.createAtomicExclusiveText(certificate, body), true);
    assert.equal(localRuntimeStateFileSystem.createAtomicExclusiveText(certificate, "different\n"), false);
    assert.equal(readFileSync(certificate, "utf8"), body);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
