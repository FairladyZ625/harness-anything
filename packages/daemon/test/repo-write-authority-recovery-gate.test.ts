// harness-test-tier: contract
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DurableRepoWriteOutcomeStoreV1,
  RepoWriteAuthorityRecoveryGate,
  repoWriteActorStampDigestV1,
  type RepoWriteProceedingInputV1
} from "../src/index.ts";

const recoveryTest = process.platform === "win32" ? test.skip : test;

recoveryTest("plan and inner recovery share one durable PROCEEDING and current fence", async () => {
  await withGate(async ({ events, gate, proceeding, durable }) => {
    const planResult = await gate.runPlannedRecovery({
      outerOpId: durable.outerOpId,
      outerRequestDigest: durable.requestDigest,
      outerGeneration: durable.generation
    }, (outcome) => {
      events.push(`plan:${outcome.innerOpId}`);
      return "plan-authorized";
    });
    const attemptResult = await gate.runAttemptRecovery(
      recoveryAttempt(proceeding, durable.requestDigest),
      async () => {
        events.push("inner-resume");
        return "attempt-authorized";
      }
    );

    assert.equal(planResult, "plan-authorized");
    assert.equal(attemptResult, "attempt-authorized");
    assert.deepEqual(events, [
      "writer-fence",
      `plan:${proceeding.innerOpId}`,
      "writer-fence",
      "inner-resume"
    ]);
  });
});

recoveryTest("request, generation, inner identity, and writer fence mismatches fail closed", async () => {
  await withGate(async ({ directory, gate, proceeding, durable }) => {
    await assert.rejects(gate.runPlannedRecovery({
      outerOpId: durable.outerOpId,
      outerRequestDigest: "0".repeat(64),
      outerGeneration: durable.generation
    }, () => undefined), /outer witness mismatch/u);
    await assert.rejects(gate.runPlannedRecovery({
      outerOpId: durable.outerOpId,
      outerRequestDigest: durable.requestDigest,
      outerGeneration: durable.generation + 1
    }, () => undefined), /outer witness mismatch/u);
    const wrongInner = recoveryAttempt(proceeding, durable.requestDigest);
    await assert.rejects(gate.runAttemptRecovery({
      ...wrongInner,
      witness: { ...wrongInner.witness, opId: "inner-other" }
    }, async () => undefined), /does not bind/u);

    const fenced = new RepoWriteAuthorityRecoveryGate({
      ...axes(),
      store: new DurableRepoWriteOutcomeStoreV1({
        directory,
        ...axes()
      }),
      assertCurrentWriterFence: () => {
        throw new Error("DAEMON_GENERATION_FENCED");
      }
    });
    await assert.rejects(fenced.runPlannedRecovery({
      outerOpId: durable.outerOpId,
      outerRequestDigest: durable.requestDigest,
      outerGeneration: durable.generation
    }, () => undefined), /DAEMON_GENERATION_FENCED/u);
  });
});

async function withGate(
  run: (fixture: {
    readonly directory: string;
    readonly events: string[];
    readonly gate: RepoWriteAuthorityRecoveryGate;
    readonly proceeding: RepoWriteProceedingInputV1;
    readonly durable: ReturnType<DurableRepoWriteOutcomeStoreV1["begin"]>;
  }) => Promise<void>
): Promise<void> {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-recovery-"));
  const events: string[] = [];
  const proceeding = proceedingInput();
  const store = new DurableRepoWriteOutcomeStoreV1({ directory, ...axes() });
  const durable = store.begin(proceeding);
  const gate = new RepoWriteAuthorityRecoveryGate({
    ...axes(),
    store,
    assertCurrentWriterFence: () => {
      events.push("writer-fence");
    }
  });
  try {
    await run({ directory, events, gate, proceeding, durable });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function axes() {
  return {
    repoId: "repo-recovery",
    workspaceId: "workspace-recovery",
    generation: 9
  } as const;
}

function proceedingInput(): RepoWriteProceedingInputV1 {
  const actor = {
    personId: "person_zeyu",
    displayName: "Zeyu Li",
    providerId: "local-socket",
    credential: {
      kind: "unix-socket-owner-boundary",
      issuer: "local-daemon",
      subject: "person_zeyu"
    }
  } as const;
  return {
    ...axes(),
    outerOpId: "outer-recovery",
    innerOpId: "inner-recovery",
    authoritySemanticDigest: "1".repeat(64),
    canonicalCommand: {
      commandName: "progress.append",
      actor,
      context: {},
      payload: {}
    },
    authenticatedContext: { actor },
    receiptSeed: {
      schema: "repo-write-receipt-seed/v1",
      renderer: "cli-command-receipt/v2@1",
      generatedAt: "2026-07-24T00:00:00.000Z",
      command: "progress append",
      action: "append",
      actorStampDigest: repoWriteActorStampDigestV1(actor)
    },
    recoveryContext: { fixed: "attempt" }
  };
}

function recoveryAttempt(
  proceeding: RepoWriteProceedingInputV1,
  requestDigest: string
) {
  return {
    schema: "authority-recovery-attempt/v1",
    attempt: {
      requestId: "request-recovery",
      presentationToken: new Uint8Array([1]),
      envelope: new Uint8Array([2])
    },
    witness: {
      repoId: proceeding.repoId,
      outerOpId: proceeding.outerOpId,
      outerRequestDigest: requestDigest,
      outerGeneration: proceeding.generation,
      authorityGeneration: 3,
      requestId: "request-recovery",
      workspaceId: proceeding.workspaceId,
      opId: proceeding.innerOpId,
      semanticDigest: proceeding.authoritySemanticDigest,
      admittedAtMs: "1",
      canonicalRequestEnvelope: "Ag",
      attribution: {
        actor: {
          principal: {
            kind: "person",
            personId: "person_zeyu"
          },
          executor: null
        },
        principalSource: {
          kind: "daemon-authenticated",
          providerId: "local-socket"
        },
        executorSource: "absent"
      }
    }
  };
}
