// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { agent, install, run, squad } from "./agent-entities.fixtures.ts";

test("single-file declaration sources validate and install like package directories", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-agent-single-file-")),
    source = path.join(rootDir, "source");
  mkdirSync(source, { recursive: true });
  try {
    const terraFile = path.join(source, "terra.json");
    writeFileSync(terraFile, `${JSON.stringify(agent, null, 2)}\n`);
    const report = run({ rootDir, kind: "agent-validate", packageSource: terraFile }) as {
      valid: boolean;
      entity?: { id: string };
    };
    assert.deepEqual({ valid: report.valid, entity: report.entity }, { valid: true, entity: { id: "terra" } });
    await install({ rootDir, kind: "agent-install", packageSource: terraFile });
    assert.deepEqual((run({ rootDir, kind: "agent-inspect", agentId: "terra" }) as { agent: unknown }).agent, agent);
    const squadFile = path.join(source, "core-squad.json");
    writeFileSync(squadFile, `${JSON.stringify(squad, null, 2)}\n`);
    await install({ rootDir, kind: "squad-install", packageSource: squadFile });
    assert.equal(
      (run({ rootDir, kind: "squad-inspect", squadId: "core-squad" }) as { squad: { roster: string } }).squad.roster,
      squad.roster,
    );

    // Every other source shape still fails closed: irregular files, wrong-kind manifests, broken directories.
    const notJson = path.join(source, "not-json.json");
    writeFileSync(notJson, "{not-json\n");
    const invalid = run({ rootDir, kind: "agent-validate", packageSource: notJson }) as {
      valid: boolean;
      issues: Array<{ code: string }>;
    };
    assert.equal(invalid.valid, false);
    assert.deepEqual(
      invalid.issues.map(({ code }) => code),
      ["invalid_manifest"],
    );
    const wrongKind = path.join(source, "wrong-kind.json");
    writeFileSync(wrongKind, `${JSON.stringify(squad, null, 2)}\n`);
    const mismatch = run({ rootDir, kind: "agent-validate", packageSource: wrongKind }) as {
      valid: boolean;
      issues: Array<{ message: string }>;
    };
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.issues.map(({ message }) => message).join("\n"), /must equal "agent-declaration\/v1"/u);
    const linked = path.join(source, "linked.json");
    symlinkSync(terraFile, linked);
    const irregular = run({ rootDir, kind: "agent-validate", packageSource: linked }) as {
      valid: boolean;
      issues: Array<{ code: string }>;
    };
    assert.equal(irregular.valid, false);
    assert.deepEqual(
      irregular.issues.map(({ code }) => code),
      ["invalid_package"],
    );
    const emptyPackage = path.join(source, "empty-package");
    mkdirSync(emptyPackage);
    const missing = run({ rootDir, kind: "agent-validate", packageSource: emptyPackage }) as {
      valid: boolean;
      issues: Array<{ code: string }>;
    };
    assert.equal(missing.valid, false);
    assert.deepEqual(
      missing.issues.map(({ code }) => code),
      ["missing_manifest"],
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
