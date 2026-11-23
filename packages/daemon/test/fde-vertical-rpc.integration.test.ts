// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openPersistentWriterEpoch } from "@harness-anything/storage";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";

function initGitRepo(rootDir: string): void {
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "FDE RPC Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "fde-rpc@example.invalid"]);
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "-qm", "base"]);
}

test("RepoCell executes vertical-init, preset-init, and zero-ledger-write vertical-simulate end-to-end", async () => {
  const rawDir = mkdtempSync(path.join(tmpdir(), "ha-fde-rpc-"));
  const rootDir = realpathSync(rawDir);
  initGitRepo(rootDir);
  const epoch = openPersistentWriterEpoch({ stateRoot: path.join(rootDir, ".harness", "state") });
  const binding = withPolicyGroup(
    {
      actor: { principal: { personId: "person_owner" }, executor: null },
      source: "local" as const,
    },
    "admin",
  );
  let cell: Awaited<ReturnType<typeof openBootstrappedRepoCell>> | undefined;
  try {
    cell = await openBootstrappedRepoCell({
      repoId: workspaceId("fde-rpc-repo"),
      rootDir: canonicalRoot(rootDir),
      ownerId: "fde-rpc-daemon",
      writerEpoch: epoch,
    });
    const revisionBefore = cell.status().ledgerRevision ?? 0;

    const initReceipt = await cell.run(
      { kind: "vertical-init", verticalId: "procurement/review", title: "Procurement Review" },
      binding,
    );
    assert.equal(initReceipt.outcome, "applied", JSON.stringify(initReceipt));
    const initReport = JSON.parse(String(initReceipt.evidence)) as {
      schema: string;
      verticalId: string;
      defaultPresetId: string;
      workPresetId: string;
    };
    assert.equal(initReport.schema, "vertical-scaffold-report/v1");
    assert.equal(initReport.verticalId, "procurement/review");
    assert.equal(initReport.workPresetId, "work-root");

    const presetReceipt = await cell.run(
      { kind: "preset-init", presetId: "vendor-check", verticalId: "procurement/review" },
      binding,
    );
    assert.equal(presetReceipt.outcome, "applied", JSON.stringify(presetReceipt));
    const presetReport = JSON.parse(String(presetReceipt.evidence)) as {
      schema: string;
      presetId: string;
      bundledInLocalVertical: boolean;
    };
    assert.equal(presetReport.schema, "preset-scaffold-report/v1");
    assert.equal(presetReport.presetId, "vendor-check");
    assert.equal(presetReport.bundledInLocalVertical, true);

    const simulateReceipt = await cell.run(
      {
        kind: "vertical-simulate",
        verticalSource: "procurement/review",
        presetId: "vendor-check",
        locale: "en-US",
      },
      binding,
    );
    assert.equal(simulateReceipt.outcome, "applied", JSON.stringify(simulateReceipt));
    const simReport = JSON.parse(String(simulateReceipt.evidence)) as {
      schema: string;
      ok: boolean;
      zeroLedgerWrites: boolean;
      gates: Array<{
        gateId: string;
        ok: boolean;
        positive: { result: string };
        negative: { result: string; blockerCode: string | null };
      }>;
    };
    assert.equal(simReport.schema, "vertical-simulate-report/v1");
    assert.equal(simReport.ok, true, JSON.stringify(simReport, null, 2));
    assert.equal(simReport.zeroLedgerWrites, true);
    assert.equal(simReport.gates[0]?.gateId, "vendor-check-contract");
    assert.equal(simReport.gates[0]?.positive.result, "pass");
    assert.equal(simReport.gates[0]?.negative.result, "fail");
    assert.equal(simReport.gates[0]?.negative.blockerCode, "gate_witness_missing");

    // Zero ledger events appended by scaffold or simulate.
    const revisionAfter = cell.status().ledgerRevision ?? 0;
    assert.equal(revisionAfter, revisionBefore);
  } finally {
    await cell?.close();
    epoch.close();
    removeTempRepository(rootDir);
  }
});
