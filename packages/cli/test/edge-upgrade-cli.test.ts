// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { EdgeUpgradeReceipt } from "@harness-anything/daemon/internal/client/edge-upgrade";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import {
  parseEdgeUpgradeArgs,
  renderEdgeUpgradeReceipt,
  runEdgeUpgradeControl,
} from "../src/daemon/edge-upgrade-control.ts";
import { runDaemonControl } from "../src/daemon/control.ts";
import { cliCapabilities, renderThinHelp } from "../src/cli/thin-command.ts";
import { runDoctor } from "../src/cli/thin-command-doctor.ts";

test("parseEdgeUpgradeArgs parses valid flags and rejects conflicting or unknown options", () => {
  const parsed = parseEdgeUpgradeArgs([
    "edge",
    "upgrade",
    "--to",
    "abcdef123456",
    "--offline",
    "--repo",
    "demo",
    "--json",
  ]);
  assert.equal(parsed.ok, true);
  if (parsed.ok) {
    assert.equal(parsed.args.toRef, "abcdef123456");
    assert.equal(parsed.args.offline, true);
    assert.equal(parsed.args.rollback, false);
    assert.equal(parsed.args.repoId, "demo");
    assert.equal(parsed.args.json, true);
  }

  const conflict = parseEdgeUpgradeArgs(["edge", "upgrade", "--rollback", "--to", "abcdef123456"]);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, "invalid_field");

  const unknown = parseEdgeUpgradeArgs(["edge", "upgrade", "--bogus"]);
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, "unknown_field");

  const missing = parseEdgeUpgradeArgs(["edge", "upgrade", "--to"]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "missing_field");
});

test("ha edge upgrade is declared in CLI capabilities, help, and doctor command validation", (t) => {
  assert.ok(cliCapabilities.edge?.includes("edge-upgrade"));
  assert.ok(cliCapabilities.edge?.includes("edge-join"));
  const help = renderThinHelp([], "edge");
  assert.match(help, /ha edge upgrade/u);

  const root = mkdtempSync(path.join(tmpdir(), "ha-doctor-edge-upgrade-"));
  t.after(() => removeTempRepository(root));
  mkdirSync(path.join(root, "docs-release"), { recursive: true });
  writeFileSync(
    path.join(root, "docs-release", "edge.md"),
    "Run `ha edge upgrade`, `ha edge upgrade --to abcdef123456`, or `ha edge upgrade --rollback`.\n",
  );
  const report = runDoctor(root);
  assert.equal(report.checked, 3);
  assert.deepEqual(report.findings, []);
});

test("runEdgeUpgradeControl emits structured JSON receipt and renders readable text", async () => {
  const sample: EdgeUpgradeReceipt = {
    schema: "edge-upgrade-receipt/v1",
    ok: true,
    command: "edge-upgrade",
    outcome: "upgraded",
    installRoot: "/tmp/install",
    repoId: "demo",
    fromCommit: "a".repeat(40),
    toCommit: "b".repeat(40),
    targetCommit: "b".repeat(40),
    daemonPid: 4321,
    daemonBuildId: "b".repeat(40),
    daemonRestarted: true,
    syncedRepos: [{ repoId: "demo", revision: 99, lagRevisions: 0, mirrorOutcome: "materialized" }],
    rolledBack: false,
    guiRestartRequired: true,
  };
  let emitted: Record<string, unknown> | null = null;
  const code = await runEdgeUpgradeControl(
    ["edge", "upgrade", "--json"],
    "/tmp/user",
    "default",
    "/tmp/work",
    (receipt, exitCode) => {
      emitted = receipt;
      return exitCode;
    },
    async () => sample,
  );
  assert.equal(code, 0);
  assert.equal(emitted?.["outcome"], "upgraded");

  const text = renderEdgeUpgradeReceipt(sample);
  assert.match(text, /edge-upgrade: upgraded/u);
  assert.match(text, /sync: repo=demo revision=99/u);
  assert.match(text, /ha gui/u);
});

test("execution credentials cannot invoke ha edge upgrade", async () => {
  const prev = process.env.HARNESS_EXECUTION_CREDENTIAL;
  process.env.HARNESS_EXECUTION_CREDENTIAL = "exec-cred-token";
  let emitted: Record<string, unknown> | null = null;
  try {
    const code = await runDaemonControl(["edge", "upgrade", "--json"], (receipt) => {
      emitted = receipt;
    });
    assert.equal(code, 1);
    assert.equal(emitted?.["code"], "execution_credential_rejected");
  } finally {
    if (prev === undefined) delete process.env.HARNESS_EXECUTION_CREDENTIAL;
    else process.env.HARNESS_EXECUTION_CREDENTIAL = prev;
  }
});
