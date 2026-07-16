// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import test from "node:test";
import {
  classifyCompoundExit,
  createCompoundReceiptService,
  type AuthorityCommittedReceipt,
  type CompoundReceiptPhase,
  type ReceiptIdentity
} from "../../application/src/index.ts";
import { createDurableCompoundReceiptStore, renderCompoundCliExit } from "../src/receipt/index.ts";

const workerFlag = "--compound-receipt-crash-worker";
const identity: ReceiptIdentity = {
  workspaceId: "workspace-crash",
  viewId: "view-crash",
  opId: "op-crash",
  waiterId: "waiter-crash",
  resultToken: "token-crash"
};

if (process.argv.includes(workerFlag)) {
  const index = process.argv.indexOf(workerFlag);
  await advanceTo(process.argv[index + 1]!, process.argv[index + 2]! as CompoundReceiptPhase);
  process.stdout.write("DURABLE\n");
  await new Promise(() => undefined);
}

test("durable store preserves every four-state boundary across kill and restart", async () => {
  for (const phase of ["PENDING", "COMMITTED", "APPLIED_EXACT_AT_CUT", "ACK_COMMITTED"] as const) {
    const directory = mkdtempSync(path.join(tmpdir(), `ha-receipt-${phase.toLowerCase()}-`));
    try {
      await runUntilDurableThenKill(directory, phase);
      const store = createDurableCompoundReceiptStore({ directory });
      const recovered = await store.get(identity);
      assert.equal(recovered?.phase, phase);

      const resumed = await createCompoundReceiptService({ store }).initialize(identity);
      assert.equal(resumed.phase, phase, `${phase} must not reset to PENDING after restart`);
      assert.equal(classifyCompoundExit({ kind: "RECEIPT", receipt: resumed }).code === 0, phase === "ACK_COMMITTED");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});

test("CLI exit exposes stderr action and separates historical cut from current lease", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "ha-receipt-render-"));
  try {
    await advanceTo(directory, "ACK_COMMITTED");
    const store = createDurableCompoundReceiptStore({ directory });
    const service = createCompoundReceiptService({ store });
    const revoked = await service.setCurrentLease(identity, "REVOKED");
    const output = renderCompoundCliExit({ kind: "RECEIPT", receipt: revoked });

    assert.equal(output.exitCode, 0);
    assert.match(output.stderr, /^COMMITTED_APPLIED:/u);
    assert.match(output.stderr, /Next:/u);
    assert.equal(output.json.historicalCut?.tag, "APPLIED_EXACT_AT_CUT");
    assert.equal(output.json.currentLease, "REVOKED");
    assert.equal(output.json.authority?.tag, "COMMITTED");
    assert.equal(output.json.origin?.tag, "APPLIED_EXACT_AT_CUT");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function runUntilDurableThenKill(directory: string, phase: CompoundReceiptPhase): Promise<void> {
  const child = spawn(process.execPath, ["--experimental-strip-types", fileURLToPath(import.meta.url), workerFlag, directory, phase], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.includes("DURABLE")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`crash worker exited before kill (${code}): ${stderr}`)));
  });
  assert.equal(child.kill("SIGKILL"), true);
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

async function advanceTo(directory: string, phase: CompoundReceiptPhase): Promise<void> {
  const service = createCompoundReceiptService({ store: createDurableCompoundReceiptStore({ directory }) });
  await service.initialize(identity);
  if (phase === "PENDING") return;
  await service.recordAuthority(identity, committedReceipt());
  if (phase === "COMMITTED") return;
  await service.recordOrigin(identity, {
    tag: "APPLIED_EXACT_AT_CUT",
    viewId: identity.viewId,
    opId: identity.opId,
    version: 3,
    cutId: "cut-crash",
    cutKind: "WRITE_EXCLUDED",
    cutJournalLSN: 30,
    verifiedAffectedDigest: "sha256:affected",
    writerExclusionId: "exclusion-crash"
  });
  if (phase === "APPLIED_EXACT_AT_CUT") return;
  await service.prepareResult(identity);
  await service.commitAcknowledgement(identity, {
    viewId: identity.viewId,
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    epoch: 1,
    revision: 3,
    commitSha: "commit-3",
    canonicalEventDigest: "44".repeat(32),
    affectedDigest: "sha256:affected",
    cutId: "cut-crash",
    cutKind: "WRITE_EXCLUDED",
    cutJournalLSN: 30,
    writerExclusionId: "exclusion-crash",
    waiterId: identity.waiterId,
    terminalLSN: 31
  });
}

function committedReceipt(): AuthorityCommittedReceipt {
  return {
    tag: "COMMITTED",
    workspaceId: identity.workspaceId,
    opId: identity.opId,
    semanticDigest: "sha256:request",
    revision: 3,
    commitSha: "commit-3",
    previousCommit: "commit-2",
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: "sha256:request",
      semanticMutationSetDigest: "22".repeat(32),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "33".repeat(32),
      canonicalMutationSet: { registryVersion: 1, mutations: [] }
    },
    integrityTuple: {
      schema: "authority-integrity-tuple/v2",
      canonicalEventDigest: "44".repeat(32),
      changeSetDigest: "55".repeat(32),
      semanticMutationSetDigest: "22".repeat(32),
      actorAxesBindingDigest: "33".repeat(32)
    }
  };
}
