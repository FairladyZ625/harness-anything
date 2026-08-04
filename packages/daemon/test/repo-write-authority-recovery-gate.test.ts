// harness-test-tier: contract
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
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

recoveryTest("historical recovery terminalizes only from matching canonical publication evidence", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-historical-recovery-"));
  const historical = { ...proceedingInput(), generation: 403 };
  const previous = new DurableRepoWriteOutcomeStoreV1({
    directory,
    repoId: historical.repoId,
    workspaceId: historical.workspaceId,
    generation: historical.generation
  }).begin(historical);
  const proceedingPath = path.join(
    directory,
    readdirSync(directory).find((name) => name.endsWith(".proceeding.json"))!
  );
  const proceedingBytes = readFileSync(proceedingPath);
  const proceedingSha256 = createHash("sha256").update(proceedingBytes).digest("hex");
  const publicationCommitSha = "a".repeat(40);
  const evidence = committedEvidence(historical, publicationCommitSha);
  const current = new DurableRepoWriteOutcomeStoreV1({
    directory,
    repoId: historical.repoId,
    workspaceId: historical.workspaceId,
    generation: 409
  });
  const gate = new RepoWriteAuthorityRecoveryGate({
    repoId: historical.repoId,
    workspaceId: historical.workspaceId,
    generation: 409,
    store: current,
    assertCurrentWriterFence: () => undefined,
    resolveHistoricalPublication: async () => ({
      commitSha: publicationCommitSha,
      semanticDigest: historical.authoritySemanticDigest
    }),
    recoverHistoricalCommittedReceipt: async () => evidence
  });

  const pending = current.listHistoricalProceedings();
  assert.equal(pending.length, 1);
  await gate.recoverHistoricalProceeding(pending[0]!);

  const terminal = current.lookup(previous.outerOpId);
  assert.equal(terminal.state, "terminal");
  assert.equal(terminal.generation, "historical");
  if (terminal.state !== "terminal") return;
  assert.equal(terminal.outcome.terminalProof.evidence.commitSha, publicationCommitSha);
  assert.equal(
    (terminal.outcome.receipt.details?.data as {
      readonly repoWrite?: { readonly recoveryEvidence?: string };
    })?.repoWrite?.recoveryEvidence,
    `cross-generation-publication:${publicationCommitSha}`
  );
  assert.deepEqual(readFileSync(proceedingPath), proceedingBytes);
  assert.equal(
    createHash("sha256").update(readFileSync(proceedingPath)).digest("hex"),
    proceedingSha256
  );
});

recoveryTest("immutable historical recovery mismatch is durably rejected and not replayed after restart", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-historical-rejected-"));
  try {
    const historical = { ...proceedingInput(), generation: 403 };
    const previous = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: historical.generation
    }).begin(historical);
    const current = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 409
    });
    const gate = new RepoWriteAuthorityRecoveryGate({
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 409,
      store: current,
      assertCurrentWriterFence: () => undefined,
      resolveHistoricalPublication: async () => ({
        commitSha: "a".repeat(40),
        semanticDigest: historical.authoritySemanticDigest
      }),
      recoverHistoricalCommittedReceipt: async () => {
        throw new Error("AUTHORITY_V2_RECOVERY_CHANGE_MISMATCH");
      }
    });

    assert.deepEqual(
      await gate.recoverHistoricalProceeding(current.listHistoricalProceedings()[0]!),
      {
        disposition: "permanently-rejected",
        code: "AUTHORITY_V2_RECOVERY_CHANGE_MISMATCH"
      }
    );

    assert.equal(current.lookup(previous.outerOpId).state, "outcome-unknown");
    assert.deepEqual(current.getHistoricalRecoveryRejection(previous.outerOpId), {
      schema: "repo-write-historical-recovery-rejection/v1",
      disposition: "permanently-rejected",
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      proceedingGeneration: historical.generation,
      rejectedByGeneration: 409,
      outerOpId: historical.outerOpId,
      requestDigest: previous.requestDigest,
      innerOpId: historical.innerOpId,
      authoritySemanticDigest: historical.authoritySemanticDigest,
      code: "AUTHORITY_V2_RECOVERY_CHANGE_MISMATCH"
    });
    assert.equal(
      readdirSync(directory).filter((name) => name.endsWith(".terminal.json")).length,
      0
    );

    const restarted = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 410
    });
    assert.deepEqual(restarted.listHistoricalProceedings(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

recoveryTest("NON_LINEAR semicolon diagnostic is durably rejected once", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-historical-nonlinear-"));
  try {
    const historical = { ...proceedingInput(), generation: 403 };
    const previous = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: historical.generation
    }).begin(historical);
    const current = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 409
    });
    const gate = new RepoWriteAuthorityRecoveryGate({
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 409,
      store: current,
      assertCurrentWriterFence: () => undefined,
      resolveHistoricalPublication: async () => {
        throw new Error(
          "AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR;expectedPreviousHead=abc"
        );
      }
    });

    assert.deepEqual(
      await gate.recoverHistoricalProceeding(current.listHistoricalProceedings()[0]!),
      {
        disposition: "permanently-rejected",
        code: "AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR"
      }
    );
    assert.equal(
      current.getHistoricalRecoveryRejection(previous.outerOpId)?.code,
      "AUTHORITY_CANONICAL_PUBLICATION_NON_LINEAR"
    );
    assert.deepEqual(current.listHistoricalProceedings(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

recoveryTest("historical recovery durably rejects once when publication is absent", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-historical-absent-"));
  try {
    const historical = { ...proceedingInput(), generation: 403 };
    const previous = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: historical.generation
    }).begin(historical);
    const current = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 409
    });
    const gate = new RepoWriteAuthorityRecoveryGate({
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 409,
      store: current,
      assertCurrentWriterFence: () => undefined,
      resolveHistoricalPublication: async () => {
        throw new Error("AUTHORITY_CANONICAL_PUBLICATION_NOT_FOUND");
      }
    });
    assert.deepEqual(
      await gate.recoverHistoricalProceeding(current.listHistoricalProceedings()[0]!),
      {
        disposition: "permanently-rejected",
        code: "AUTHORITY_CANONICAL_PUBLICATION_NOT_FOUND"
      }
    );
    assert.equal(current.lookup(previous.outerOpId).state, "outcome-unknown");
    assert.equal(
      current.getHistoricalRecoveryRejection(previous.outerOpId)?.code,
      "AUTHORITY_CANONICAL_PUBLICATION_NOT_FOUND"
    );
    assert.equal(readdirSync(directory).filter((name) => name.endsWith(".terminal.json")).length, 0);
    assert.deepEqual(current.listHistoricalProceedings(), []);

    const restarted = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 410
    });
    assert.deepEqual(restarted.listHistoricalProceedings(), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

recoveryTest("historical recovery stays outcome-unknown when publication is not unique", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-historical-nonunique-"));
  try {
    const historical = { ...proceedingInput(), generation: 403 };
    const previous = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: historical.generation
    }).begin(historical);
    const current = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 409
    });
    const gate = new RepoWriteAuthorityRecoveryGate({
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 409,
      store: current,
      assertCurrentWriterFence: () => undefined,
      resolveHistoricalPublication: async () => {
        throw new Error("AUTHORITY_CANONICAL_PUBLICATION_NOT_UNIQUE");
      }
    });

    await assert.rejects(
      gate.recoverHistoricalProceeding(current.listHistoricalProceedings()[0]!),
      /AUTHORITY_CANONICAL_PUBLICATION_NOT_UNIQUE/u
    );
    assert.equal(current.lookup(previous.outerOpId).state, "outcome-unknown");
    assert.equal(readdirSync(directory).filter((name) => name.endsWith(".terminal.json")).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

recoveryTest("historical recovery stays outcome-unknown when publication semantic digest differs", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-historical-digest-"));
  try {
    const historical = { ...proceedingInput(), generation: 403 };
    const previous = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: historical.generation
    }).begin(historical);
    const current = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 409
    });
    const gate = new RepoWriteAuthorityRecoveryGate({
      repoId: historical.repoId,
      workspaceId: historical.workspaceId,
      generation: 409,
      store: current,
      assertCurrentWriterFence: () => undefined,
      resolveHistoricalPublication: async () => ({
        commitSha: "a".repeat(40),
        semanticDigest: "9".repeat(64)
      })
    });
    await assert.rejects(
      gate.recoverHistoricalProceeding(current.listHistoricalProceedings()[0]!),
      /semantic digest does not match/u
    );
    assert.equal(current.lookup(previous.outerOpId).state, "outcome-unknown");
    assert.equal(readdirSync(directory).filter((name) => name.endsWith(".terminal.json")).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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

function committedEvidence(
  proceeding: RepoWriteProceedingInputV1,
  commitSha: string
) {
  return {
    tag: "COMMITTED" as const,
    workspaceId: proceeding.workspaceId,
    opId: proceeding.innerOpId,
    semanticDigest: proceeding.authoritySemanticDigest,
    revision: 1,
    commitSha,
    previousCommit: "b".repeat(40),
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2" as const,
      semanticRequestDigest: proceeding.authoritySemanticDigest,
      semanticMutationSetDigest: "2".repeat(64),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "3".repeat(64),
      canonicalMutationSet: { registryVersion: 1 as const, mutations: [] }
    },
    integrityTuple: {
      schema: "authority-integrity-tuple/v2" as const,
      canonicalEventDigest: "4".repeat(64),
      changeSetDigest: "5".repeat(64),
      semanticMutationSetDigest: "2".repeat(64),
      actorAxesBindingDigest: "3".repeat(64)
    }
  };
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
