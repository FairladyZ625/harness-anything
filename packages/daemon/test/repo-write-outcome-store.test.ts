// harness-test-tier: contract
import assert from "node:assert/strict";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { CommandReceiptEnvelope } from "@harness-anything/application";
import { stableStringify } from "@harness-anything/kernel";
import {
  canonicalRepoWriteOutcomeText,
  DurableRepoWriteOutcomeStoreV1,
  repoWriteActorStampDigestV1,
  repoWriteRequestDigestV1,
  RepoWriteOutcomeConflictError,
  RepoWriteOutcomeCorruptionError,
  RepoWriteOutcomeGenerationFenceError,
  type RepoWriteProceedingInputV1,
  type RepoWriteTerminalEvidenceV1
} from "../src/index.ts";

const outcomeTest = process.platform === "win32" ? test.skip : test;

outcomeTest("PROCEEDING is canonical, private, durable, and same-request idempotent", () => {
  withStore(({ directory, store }) => {
    const input = proceedingInput("outer-canonical");
    const first = store.begin(input);
    const duplicate = store.begin({
      ...input,
      canonicalCommand: {
        payload: { title: "性能优化", parent: null },
        context: { presentation: "json", requestId: "request-1" },
        actor: actorStamp(),
        commandName: "task.create"
      }
    });

    assert.deepEqual(duplicate, first);
    assert.equal(first.phase, "PROCEEDING");
    assert.deepEqual(first.authenticatedContext, input.authenticatedContext);
    assert.deepEqual(first.receiptSeed, input.receiptSeed);
    assert.deepEqual(first.recoveryContext, input.recoveryContext);
    assert.match(first.requestDigest, /^[a-f0-9]{64}$/u);
    const [proceedingFile] = files(directory, "proceeding");
    assert.ok(proceedingFile);
    assert.equal(
      readFileSync(path.join(directory, proceedingFile), "utf8"),
      canonicalRepoWriteOutcomeText(first)
    );
    if (process.platform !== "win32") {
      assert.equal(statSync(directory).mode & 0o777, 0o700);
      assert.equal(statSync(path.join(directory, proceedingFile)).mode & 0o777, 0o600);
    }
  });
});

outcomeTest("same outer opId rejects a different request digest or immutable recovery identity", () => {
  withStore(({ store }) => {
    const input = proceedingInput("outer-conflict");
    assert.notEqual(
      repoWriteRequestDigestV1(input),
      repoWriteRequestDigestV1({ ...input, repoId: "repo-other" })
    );
    assert.notEqual(
      repoWriteRequestDigestV1(input),
      repoWriteRequestDigestV1({ ...input, workspaceId: "workspace-other" })
    );
    assert.notEqual(
      repoWriteRequestDigestV1(input),
      repoWriteRequestDigestV1({ ...input, authoritySemanticDigest: "2".repeat(64) })
    );
    assert.throws(() => store.begin({
      ...input,
      canonicalCommand: {
        ...input.canonicalCommand,
        actor: { ...actorStamp(), personId: "person_forged" }
      }
    }), /canonical equality with authenticatedContext\.actor/u);
    const first = store.begin(input);

    assert.throws(() => store.begin({
      ...input,
      canonicalCommand: {
        ...input.canonicalCommand,
        payload: { title: "different request" }
      }
    }), conflict);
    assert.throws(() => store.begin({
      ...input,
      innerOpId: "inner-different"
    }), conflict);
    assert.deepEqual(store.get(input.outerOpId), first);
  });
});

outcomeTest("TERMINAL committed receipt survives restart byte-for-byte and cannot change", () => {
  withStore(({ directory, options, store }) => {
    const input = proceedingInput("outer-committed");
    const proceeding = store.begin(input);
    assert.equal(proceeding.phase, "PROCEEDING");
    const receipt = successReceipt();

    const terminal = store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt,
      authorityEvidence: terminalEvidence(input, "committed")
    });
    assert.equal(terminal.terminalKind, "committed");
    assert.deepEqual(terminal.receipt, receipt);
    assert.deepEqual(terminal.terminalProof.evidence, terminalEvidence(input, "committed"));
    assert.match(terminal.terminalProof.evidenceDigest, /^[a-f0-9]{64}$/u);
    assert.deepEqual(store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt,
      authorityEvidence: terminalEvidence(input, "committed")
    }), terminal);
    assert.deepEqual(store.begin(input), terminal);

    const restarted = new DurableRepoWriteOutcomeStoreV1(options);
    assert.deepEqual(restarted.get(input.outerOpId), terminal);
    const [terminalFile] = files(directory, "terminal");
    assert.ok(terminalFile);
    assert.equal(
      readFileSync(path.join(directory, terminalFile), "utf8"),
      canonicalRepoWriteOutcomeText(terminal)
    );
    assert.throws(() => restarted.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: {
        ...receipt,
        summary: "changed after terminal persistence"
      },
      authorityEvidence: terminalEvidence(input, "committed")
    }), conflict);
  });
});

outcomeTest("TERMINAL preserves an exact rejected command-receipt/v2", () => {
  withStore(({ options, store }) => {
    const input = proceedingInput("outer-rejected");
    const proceeding = store.begin(input);
    const receipt = rejectedReceipt();
    const evidence = { ...terminalEvidence(input, "rejected"), reason: "known\nrejection\u0001" };
    const terminal = store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt,
      authorityEvidence: evidence
    });

    assert.equal(terminal.terminalKind, "rejected");
    assert.deepEqual(terminal.receipt, receipt);
    assert.deepEqual(terminal.terminalProof.evidence, evidence);
    assert.deepEqual(new DurableRepoWriteOutcomeStoreV1(options).get(input.outerOpId), terminal);
  });
});

outcomeTest("repo, workspace, write generation, request digest, and predecessor mismatches fail closed", () => {
  withStore(({ directory, store }) => {
    const input = proceedingInput("outer-axes");
    const proceeding = store.begin(input);
    assert.throws(() => store.begin({ ...input, repoId: "repo-other" }), conflict);
    assert.throws(() => store.begin({ ...input, workspaceId: "workspace-other" }), conflict);
    assert.throws(() => store.begin({ ...input, generation: 8 }), conflict);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: "0".repeat(64),
      receipt: successReceipt(),
      authorityEvidence: terminalEvidence(input, "committed")
    }), conflict);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: "outer-without-predecessor",
      requestDigest: proceeding.requestDigest,
      receipt: successReceipt(),
      authorityEvidence: terminalEvidence(input, "committed")
    }), conflict);

    const wrongGeneration = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: axes().repoId,
      workspaceId: axes().workspaceId,
      generation: 2
    });
    assert.deepEqual(wrongGeneration.get(input.outerOpId), proceeding);
    assert.deepEqual(wrongGeneration.lookup(input.outerOpId), {
      state: "outcome-unknown",
      generation: "historical",
      observedPhase: "PROCEEDING",
      recovery: "fenced-resume-required",
      outcome: proceeding
    });
    assert.throws(() => wrongGeneration.begin({
      ...input,
      generation: 2
    }), conflict);
    assert.throws(() => wrongGeneration.terminalize({
      ...axes(),
      generation: 2,
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: successReceipt(),
      authorityEvidence: terminalEvidence(input, "committed")
    }), conflict);

    const wrongRepo = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: "repo-other",
      workspaceId: axes().workspaceId,
      generation: 2
    });
    assert.throws(() => wrongRepo.get(input.outerOpId), corrupt);
    const wrongWorkspace = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: axes().repoId,
      workspaceId: "workspace-other",
      generation: 2
    });
    assert.throws(() => wrongWorkspace.get(input.outerOpId), corrupt);
  });
});

outcomeTest("a new generation can replay historical TERMINAL exactly but cannot mutate it", () => {
  withStore(({ directory, store }) => {
    const input = proceedingInput("outer-historical-terminal");
    const proceeding = store.begin(input);
    const terminal = store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: successReceipt(),
      authorityEvidence: terminalEvidence(input, "committed")
    });
    const restarted = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: axes().repoId,
      workspaceId: axes().workspaceId,
      generation: 2
    });

    assert.deepEqual(restarted.get(input.outerOpId), terminal);
    assert.deepEqual(restarted.lookup(input.outerOpId), {
      state: "terminal",
      generation: "historical",
      outcome: terminal
    });
    assert.throws(() => restarted.terminalize({
      ...axes(),
      generation: 2,
      outerOpId: input.outerOpId,
      requestDigest: terminal.requestDigest,
      receipt: successReceipt(),
      authorityEvidence: terminalEvidence(input, "committed")
    }), conflict);
  });
});

outcomeTest("a lower generation cannot observe or replay a future-generation outcome", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-future-generation-"));
  try {
    const directory = path.join(root, "outcomes");
    const futureInput = { ...proceedingInput("outer-future"), generation: 2 };
    new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: futureInput.repoId,
      workspaceId: futureInput.workspaceId,
      generation: 2
    }).begin(futureInput);
    const stale = new DurableRepoWriteOutcomeStoreV1({
      directory,
      repoId: futureInput.repoId,
      workspaceId: futureInput.workspaceId,
      generation: 1
    });

    assert.throws(() => stale.get(futureInput.outerOpId), (error) =>
      error instanceof RepoWriteOutcomeGenerationFenceError
      && error.code === "REPO_WRITE_OUTCOME_GENERATION_FENCED");
    assert.throws(() => stale.lookup(futureInput.outerOpId), RepoWriteOutcomeGenerationFenceError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

outcomeTest("partial, non-canonical, insecure, orphan, and divergent durable files fail closed", () => {
  withStore(({ directory, store }) => {
    const tornInput = proceedingInput("outer-torn");
    store.begin(tornInput);
    const tornPath = path.join(directory, files(directory, "proceeding")[0]!);
    writeFileSync(tornPath, "{\"schema\":");
    assert.throws(() => store.get(tornInput.outerOpId), corrupt);
  });

  withStore(({ directory, store }) => {
    const input = proceedingInput("outer-noncanonical");
    const proceeding = store.begin(input);
    const proceedingPath = path.join(directory, files(directory, "proceeding")[0]!);
    writeFileSync(proceedingPath, `${JSON.stringify(proceeding, null, 2)}\n`);
    assert.throws(() => store.get(input.outerOpId), corrupt);
  });

  if (process.platform !== "win32") {
    withStore(({ directory, store }) => {
      const input = proceedingInput("outer-mode");
      store.begin(input);
      const proceedingPath = path.join(directory, files(directory, "proceeding")[0]!);
      chmodSync(proceedingPath, 0o644);
      assert.throws(() => store.get(input.outerOpId), corrupt);
    });
  }

  withStore(({ directory, store }) => {
    const input = proceedingInput("outer-orphan");
    const proceeding = store.begin(input);
    store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: successReceipt(),
      authorityEvidence: terminalEvidence(input, "committed")
    });
    unlinkSync(path.join(directory, files(directory, "proceeding")[0]!));
    assert.throws(() => store.get(input.outerOpId), corrupt);
  });

  withStore(({ directory, store }) => {
    const input = proceedingInput("outer-divergent");
    const proceeding = store.begin(input);
    store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: successReceipt(),
      authorityEvidence: terminalEvidence(input, "committed")
    });
    const terminalPath = path.join(directory, files(directory, "terminal")[0]!);
    const terminal = JSON.parse(readFileSync(terminalPath, "utf8")) as Record<string, unknown>;
    terminal.innerOpId = "inner-tampered";
    writeFileSync(terminalPath, `${stableStringify(terminal)}\n`);
    assert.throws(() => store.get(input.outerOpId), corrupt);
  });
});

outcomeTest("receipt validation rejects drift before terminal publication", () => {
  withStore(({ directory, store }) => {
    const input = proceedingInput("outer-invalid-receipt");
    const proceeding = store.begin(input);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: {
        ...successReceipt(),
        schema: "not-command-receipt/v2"
      } as unknown as CommandReceiptEnvelope,
      authorityEvidence: terminalEvidence(input, "committed")
    }), /command-receipt\/v2/u);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: successReceipt(),
      authorityEvidence: terminalEvidence(input, "rejected")
    }), /classification matching receipt\.ok/u);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: {
        ...successReceipt(),
        meta: {
          ...successReceipt().meta,
          generatedAt: "2026-07-23T12:00:01.000Z"
        }
      },
      authorityEvidence: terminalEvidence(input, "committed")
    }), /fixed by receiptSeed/u);
    assert.deepEqual(files(directory, "terminal"), []);
    assert.equal(store.get(input.outerOpId)?.phase, "PROCEEDING");
  });
});

outcomeTest("terminalization requires exact authoritative committed or not-committed evidence", () => {
  withStore(({ directory, store }) => {
    const input = proceedingInput("outer-authority-evidence");
    const proceeding = store.begin(input);
    const incompleteCommitted = {
      ...terminalEvidence(input, "committed"),
      integrityTuple: undefined
    };
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: successReceipt(),
      authorityEvidence: incompleteCommitted as unknown as RepoWriteTerminalEvidenceV1
    }), /exact authority evidence fields|complete V2 COMMITTED|integrityTuple: expected plain object/u);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: rejectedReceipt(),
      authorityEvidence: {
        tag: "INDETERMINATE",
        workspaceId: input.workspaceId,
        opId: input.innerOpId,
        semanticDigest: "1".repeat(64),
        reason: "outcome unknown"
      } as unknown as RepoWriteTerminalEvidenceV1
    }), /COMMITTED, REJECTED, or RETRYABLE_NOT_COMMITTED/u);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: rejectedReceipt(),
      authorityEvidence: {
        ...terminalEvidence(input, "rejected"),
        workspaceId: "workspace-forged"
      }
    }), /authority workspaceId, fixed inner opId/u);
    for (const [receipt, evidence] of [
      [successReceipt(), terminalEvidence(input, "committed")],
      [rejectedReceipt(), terminalEvidence(input, "rejected")]
    ] as const) {
      const authorityEvidence = evidence.tag === "COMMITTED"
        ? { ...evidence, semanticDigest: "9".repeat(64), authorityIntegrity: {
            ...evidence.authorityIntegrity, semanticRequestDigest: "9".repeat(64)
          } }
        : { ...evidence, semanticDigest: "9".repeat(64) };
      assert.throws(() => store.terminalize({
        ...axes(), outerOpId: input.outerOpId, requestDigest: proceeding.requestDigest,
        receipt, authorityEvidence
      }), /semantic digest/u);
    }
    assert.deepEqual(files(directory, "terminal"), []);
  });

  withStore(({ store }) => {
    const input = proceedingInput("outer-retryable");
    const proceeding = store.begin(input);
    const retryable: RepoWriteTerminalEvidenceV1 = {
      tag: "RETRYABLE_NOT_COMMITTED",
      workspaceId: input.workspaceId,
      opId: input.innerOpId,
      semanticDigest: "1".repeat(64),
      reason: "canonical publication proved absent"
    };
    const terminal = store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: rejectedReceipt(),
      authorityEvidence: retryable
    });
    assert.equal(terminal.terminalKind, "rejected");
    assert.deepEqual(terminal.terminalProof.evidence, retryable);
  });
});

outcomeTest("receipt arrays and aggregate JSON bytes are bounded before persistence", () => {
  withStore(({ directory, store }) => {
    const input = proceedingInput("outer-receipt-budget");
    const proceeding = store.begin(input);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: {
        ...successReceipt(),
        paths: Array.from({ length: 16_385 }, (_, index) => ({
          role: "artifact",
          path: `artifacts/${index}`
        }))
      },
      authorityEvidence: terminalEvidence(input, "committed")
    }), /bounded JSON array item count/u);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: {
        ...successReceipt(),
        next: Array.from({ length: 16_385 }, () => ({ command: "ha task show task_01KY" }))
      },
      authorityEvidence: terminalEvidence(input, "committed")
    }), /bounded JSON array item count/u);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: {
        ...successReceipt(),
        warnings: Array.from({ length: 1_100 }, () => "x".repeat(1_000))
      },
      authorityEvidence: terminalEvidence(input, "committed")
    }), /bounded aggregate JSON bytes/u);
    assert.deepEqual(files(directory, "terminal"), []);
  });
});

function proceedingInput(outerOpId: string): RepoWriteProceedingInputV1 {
  return {
    ...axes(),
    outerOpId,
    innerOpId: `inner-${outerOpId}`,
    authoritySemanticDigest: "1".repeat(64),
    canonicalCommand: {
      commandName: "task.create",
      actor: actorStamp(),
      context: { requestId: "request-1", presentation: "json" },
      payload: { parent: null, title: "性能优化" }
    },
    authenticatedContext: {
      actor: actorStamp(),
      presentation: { json: true }
    },
    receiptSeed: {
      schema: "repo-write-receipt-seed/v1",
      renderer: "cli-command-receipt/v2@1",
      generatedAt: "2026-07-23T12:00:00.000Z",
      command: "task create",
      action: "create",
      actorStampDigest: repoWriteActorStampDigestV1(actorStamp())
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
    workspaceId: "workspace-canonical",
    generation: 1
  } as const;
}

function successReceipt(): CommandReceiptEnvelope {
  return {
    ok: true,
    schema: "command-receipt/v2",
    command: "task create",
    action: "create",
    summary: "created task",
    entity: { kind: "task", id: "task_01KY" },
    paths: [{ role: "package", path: "harness/tasks/task_01KY" }],
    warnings: [{ code: "pending_materialization", message: "projection follows" }],
    details: {
      actor: actorStamp(),
      data: {
        taskId: "task_01KY",
        actorStamp: { personId: "person_zeyu", signature: "exact-child-value" }
      }
    },
    meta: {
      generatedAt: "2026-07-23T12:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

function rejectedReceipt(): CommandReceiptEnvelope {
  return {
    ok: false,
    schema: "command-receipt/v2",
    command: "task create",
    action: "create",
    summary: "lease rejected",
    error: {
      code: "task_lease_required",
      hint: "Claim the task lease.",
      context: { taskId: "task_01KY" }
    },
    next: [{ command: "ha task claim task_01KY", description: "Claim and retry." }],
    details: {
      actor: actorStamp()
    },
    meta: {
      generatedAt: "2026-07-23T12:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

function files(directory: string, phase: "proceeding" | "terminal"): ReadonlyArray<string> {
  return readdirSync(directory)
    .filter((name) => name.endsWith(`.${phase}.json`))
    .sort();
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

function terminalEvidence(
  input: Pick<RepoWriteProceedingInputV1, "innerOpId" | "workspaceId">,
  disposition: "committed" | "rejected"
): RepoWriteTerminalEvidenceV1 {
  return disposition === "committed" ? {
    tag: "COMMITTED",
    workspaceId: input.workspaceId,
    opId: input.innerOpId,
    semanticDigest: "1".repeat(64),
    revision: 1,
    commitSha: "a".repeat(40),
    previousCommit: null,
    authorityIntegrity: {
      schema: "authority-operation-integrity/v2",
      semanticRequestDigest: "1".repeat(64),
      semanticMutationSetDigest: "2".repeat(64),
      mutationRegistryVersion: 1,
      actorAxesBindingDigest: "3".repeat(64),
      canonicalMutationSet: { registryVersion: 1, mutations: [] }
    },
    integrityTuple: {
      schema: "authority-integrity-tuple/v2",
      canonicalEventDigest: "4".repeat(64),
      changeSetDigest: "5".repeat(64),
      semanticMutationSetDigest: "2".repeat(64),
      actorAxesBindingDigest: "3".repeat(64)
    }
  } : {
    tag: "REJECTED",
    workspaceId: input.workspaceId,
    opId: input.innerOpId,
    semanticDigest: "1".repeat(64),
    reason: "known durable rejection"
  };
}

function withStore(
  run: (fixture: {
    readonly directory: string;
    readonly options: ConstructorParameters<typeof DurableRepoWriteOutcomeStoreV1>[0];
    readonly store: DurableRepoWriteOutcomeStoreV1;
  }) => void
): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-outcome-"));
  try {
    const options = {
      directory: path.join(root, "outcomes"),
      ...axes()
    };
    run({
      directory: options.directory,
      options,
      store: new DurableRepoWriteOutcomeStoreV1(options)
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function conflict(error: unknown): boolean {
  return error instanceof RepoWriteOutcomeConflictError
    && error.code === "REPO_WRITE_OUTCOME_CONFLICT";
}

function corrupt(error: unknown): boolean {
  return error instanceof RepoWriteOutcomeCorruptionError
    && error.code === "REPO_WRITE_OUTCOME_CORRUPT";
}
