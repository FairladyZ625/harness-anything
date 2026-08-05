// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { repoWriteProgressCommand } from "./support/repo-write-command-fixture.ts";
import {
  DurableRepoWriteOutcomeStoreV1,
  repoWriteActorStampDigestV1,
  type RepoWriteProceedingInputV1
} from "../src/index.ts";

const rejectionTest = process.platform === "win32" ? test.skip : test;

rejectionTest("corrupt optional recovery sidecar degrades to replay without hiding other proceedings", () => {
  withDirectory((directory) => {
    const historicalAxes = { ...axes(), generation: 8 };
    const currentAxes = { ...axes(), generation: 9 };
    const previous = new DurableRepoWriteOutcomeStoreV1({ directory, ...historicalAxes });
    const corruptInput = proceedingInput("outer-corrupt-sidecar", 8);
    const otherInput = proceedingInput("outer-unrelated-proceeding", 8);
    const corruptProceeding = previous.begin(corruptInput);
    previous.begin(otherInput);
    const current = new DurableRepoWriteOutcomeStoreV1({ directory, ...currentAxes });
    current.rejectHistoricalRecovery({
      ...currentAxes,
      outerOpId: corruptInput.outerOpId,
      requestDigest: corruptProceeding.requestDigest,
      code: "AUTHORITY_V2_RECOVERY_CHANGE_MISMATCH"
    });
    const sidecar = readdirSync(directory).find((name) =>
      name.endsWith(".recovery-rejected.json"));
    assert.ok(sidecar);
    writeFileSync(path.join(directory, sidecar), "{broken-json\n");

    assert.deepEqual(
      current.listHistoricalProceedings().map((outcome) => outcome.outerOpId).sort(),
      [corruptInput.outerOpId, otherInput.outerOpId].sort()
    );
  });
});

rejectionTest("historical recovery rejection is idempotent across legal writer generations", () => {
  withDirectory((directory) => {
    const previous = new DurableRepoWriteOutcomeStoreV1({
      directory,
      ...axes(),
      generation: 8
    });
    const input = proceedingInput("outer-cross-generation-rejection", 8);
    const proceeding = previous.begin(input);
    const generationNine = writer(directory, 9);
    const first = reject(generationNine, input, proceeding.requestDigest, 9);
    assert.deepEqual(reject(generationNine, input, proceeding.requestDigest, 9), first);

    const generationTen = writer(directory, 10);
    assert.deepEqual(reject(generationTen, input, proceeding.requestDigest, 10), first);

    const reverseInput = proceedingInput("outer-newer-generation-wins", 8);
    const reverseProceeding = previous.begin(reverseInput);
    const newerWinner = reject(generationTen, reverseInput, reverseProceeding.requestDigest, 10);
    assert.deepEqual(
      reject(generationNine, reverseInput, reverseProceeding.requestDigest, 9),
      newerWinner
    );
  });
});

function writer(directory: string, generation: number): DurableRepoWriteOutcomeStoreV1 {
  return new DurableRepoWriteOutcomeStoreV1({ directory, ...axes(), generation });
}

function reject(
  store: DurableRepoWriteOutcomeStoreV1,
  input: RepoWriteProceedingInputV1,
  requestDigest: string,
  generation: number
) {
  return store.rejectHistoricalRecovery({
    ...axes(),
    generation,
    outerOpId: input.outerOpId,
    requestDigest,
    code: "AUTHORITY_V2_RECOVERY_CHANGE_MISMATCH"
  });
}

function proceedingInput(outerOpId: string, generation: number): RepoWriteProceedingInputV1 {
  const actor = actorStamp();
  return {
    ...axes(),
    generation,
    outerOpId,
    innerOpId: `inner-${outerOpId}`,
    authoritySemanticDigest: "1".repeat(64),
    canonicalCommand: repoWriteProgressCommand(actor, {
      requestId: "request-1",
      presentation: "json"
    }),
    authenticatedContext: {
      actor,
      presentation: { json: true }
    },
    receiptSeed: {
      schema: "repo-write-receipt-seed/v1",
      renderer: "cli-command-receipt/v2@1",
      generatedAt: "2026-07-23T12:00:00.000Z",
      command: "task create",
      action: "create",
      actorStampDigest: repoWriteActorStampDigestV1(actor)
    },
    recoveryContext: {
      authorityEnvelopeDigest: "1".repeat(64),
      bindingTokenDigest: "2".repeat(64)
    }
  };
}

function axes() {
  return {
    repoId: "repo-canonical",
    workspaceId: "workspace-canonical"
  } as const;
}

function actorStamp() {
  return {
    personId: "person_zeyu",
    displayName: "Zeyu Li",
    providerId: "local-socket",
    credential: {
      kind: "unix-socket-owner-boundary",
      issuer: "local-daemon",
      subject: "person_zeyu"
    }
  } as const;
}

function withDirectory(run: (directory: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-recovery-rejection-"));
  const directory = path.join(root, "outcomes");
  try {
    run(directory);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
