// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type {
  AuthorityHostAttribution,
  AuthorityHostCommand,
  CommandReceiptEnvelope,
  DaemonCommandHostServices,
  DaemonHostCommand,
  DaemonHostCommandResult,
  TaskHolderExecutor
} from "@harness-anything/application";
import type { HarnessDaemonRuntime } from "../src/runtime/repo-runtime.ts";
import {
  decodeRepoWriteCommand
} from "../src/runtime/repo-write-progress-command.ts";
import {
  RepoWriteDirectOutcomeUnknownError,
  RepoWriteNotStartedError,
  RepoWriteOutcomeUnknownError
} from "../src/runtime/repo-write-client.ts";
import { createDaemonCommandService } from "../src/service/command-service.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "../../cli/test/helpers/production-authority-connection.ts";

interface TestCommand extends DaemonHostCommand {
  readonly json: boolean;
  readonly action: {
    readonly kind: string;
    readonly dryRun?: boolean;
    readonly currentSessionOnly?: true;
  };
}

interface TestResult extends DaemonHostCommandResult {
  readonly ok: boolean;
  readonly command: string;
}

test("current-session materializer barrier fails closed without a runtime session", async () => {
  const service = createDaemonCommandService(
    unusedRuntime(),
    hostServices(() => { throw new Error("barrier must not reach command execution"); })
  );

  const receipt = await service.runCommand({
    command: {
      rootDir: "/repo",
      json: true,
      action: { kind: "materializer-run", dryRun: false, currentSessionOnly: true }
    }
  });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, "invalid_session", JSON.stringify(receipt));
  assert.match(receipt.error?.hint ?? "", /requires a runtime session/u);
});

test("materializer rendering receives the parsed harness layout input", async () => {
  let receivedRootInput: Parameters<DaemonCommandHostServices<
    TestCommand,
    TestResult,
    ReturnType<typeof productionAuthorityActor>
  >["materializerCommandResult"]>[1] | undefined;
  const runtime = {
    ...unusedRuntime(),
    enqueueMaterializerBatch: async () => ({
      dryRun: false,
      merged: 0,
      considered: 0,
      branches: [],
      warnings: []
    })
  };
  const service = createDaemonCommandService(
    runtime,
    hostServices(() => { throw new Error("materializer must not reach command execution"); }, {
      materializerCommandResult: (_report, rootInput) => {
        receivedRootInput = rootInput;
        return { ok: true, command: "materializer" };
      }
    })
  );

  await service.runCommand({
    command: {
      rootDir: "/repo with custom layout",
      layoutOverrides: { authoredRoot: ".custom-ledger" },
      json: true,
      action: { kind: "materializer-run", dryRun: false }
    }
  });

  assert.deepEqual(receivedRootInput, {
    rootDir: "/repo with custom layout",
    layoutOverrides: { authoredRoot: ".custom-ledger" }
  });
});

test("authority-backed runtime writes do not enqueue a second current-session materializer barrier", async () => {
  let materializerCalls = 0;
  const runtime = {
    ...unusedRuntime(),
    enqueueMaterializerBatch: async () => {
      materializerCalls += 1;
      return {
        dryRun: false,
        merged: 0,
        considered: 0,
        branches: [],
        warnings: [],
        projectionRebuilt: false,
        attributionEventsProjected: 0
      };
    }
  };
  const attribution = {
    writeAttribution: {
      actor: {
        principal: { kind: "person", personId: "person_alice" },
        executor: null
      },
      principalSource: {
        kind: "daemon-authenticated",
        providerId: "test-provider",
        credentialFingerprint: "credential-test"
      },
      executorSource: "none"
    },
    commitAuthor: { name: "Alice", email: "alice@example.test" },
    taskHolderPrincipal: {
      personId: "person_alice",
      displayName: "Alice",
      providerId: "test-provider",
      credential: { kind: "unix-socket-owner-boundary", issuer: "test", subject: "test" }
    },
    executor: null
  } as AuthorityHostAttribution;
  const service = createDaemonCommandService(
    runtime,
    hostServices(() => undefined, {
      actorAttribution: () => attribution,
      authorityCommand: (command) => command as unknown as AuthorityHostCommand
    }),
    {
      resolveAuthoritySubmissionV2: () => ({
        submit: async () => {
          throw new Error("authority submission should not be needed by this barrier test");
        }
      })
    }
  );

  const receipt = await service.runCommand({
    command: {
      rootDir: "/repo",
      json: true,
      action: { kind: "progress-append", taskId: "task-current-session", text: "authority-backed", dryRun: false }
    },
    session: { ...session(), source: "runtime" }
  }, {
    actor: productionAuthorityActor(),
    executor: { kind: "agent", id: "codex" },
    authorityConnection: {
      available: true,
      context: productionAuthorityConnection(productionAuthorityActor()),
      assertActive: () => undefined
    }
  });

  assert.equal(receipt.ok, true);
  assert.equal(materializerCalls, 0);
});

test("non-authority runtime writes retain the current-session materializer barrier", async () => {
  let materializerCalls = 0;
  const runtime = {
    ...unusedRuntime(),
    enqueueMaterializerBatch: async () => {
      materializerCalls += 1;
      return {
        dryRun: false,
        merged: 0,
        considered: 0,
        branches: [],
        warnings: [],
        projectionRebuilt: false,
        attributionEventsProjected: 0
      };
    }
  };
  const service = createDaemonCommandService(runtime, hostServices(() => undefined));
  const receipt = await service.runCommand({
    command: {
      rootDir: "/repo",
      json: true,
      action: { kind: "progress-append", taskId: "task-current-session", text: "queued barrier", dryRun: false }
    },
    session: { ...session(), source: "runtime" }
  });

  assert.equal(receipt.ok, true);
  assert.equal(materializerCalls, 1);
});

test("parent command service sends durable governed writes to the child and never invokes inline execution", async () => {
  const actor = productionAuthorityActor();
  const submitted: Array<ReturnType<
    typeof decodeRepoWriteCommand
  >> = [];
  let inlineExecutions = 0;
  const service = createDaemonCommandService(
    unusedRuntime(),
    hostServices(() => {
      inlineExecutions += 1;
    }),
    {
      repoWriteDispatch: {
        repoId: "canonical",
        submit: async (command) => {
          submitted.push(decodeRepoWriteCommand(command));
          return committedReceipt();
        },
        direct: async () => { throw new Error("unexpected direct route"); }
      }
    }
  );
  const receipt = await service.runCommand({
    command: {
      rootDir: "/repo",
      json: true,
      action: {
        kind: "progress-append",
        taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
        text: "child only",
        evidence: [],
        dryRun: false
      }
    },
    session: session()
  }, {
    actor,
    executor: { kind: "agent", id: "codex" },
    authorityConnection: {
      available: true,
      context: productionAuthorityConnection(actor),
      assertActive: () => undefined
    }
  });

  assert.equal(receipt.ok, true);
  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.actor.personId, actor.personId);
  assert.equal(inlineExecutions, 0);
});

test("parent command service sends operation-derived writes to the child direct lane", async () => {
  const actor = productionAuthorityActor();
  let inlineExecutions = 0;
  const directKinds: string[] = [];
  const service = createDaemonCommandService(
    unusedRuntime(),
    hostServices(() => {
      inlineExecutions += 1;
    }),
    {
      repoWriteDispatch: {
        repoId: "canonical",
        submit: async () => {
          throw new Error("unexpected durable route");
        },
        direct: async (command) => {
          directKinds.push(command.commandName);
          return committedReceipt();
        }
      }
    }
  );
  const receipt = await service.runCommand({
    command: {
      rootDir: "/repo",
      json: true,
      action: {
        kind: "task-claim",
        taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4"
      }
    },
    session: session()
  }, {
    actor,
    executor: { kind: "agent", id: "codex" },
    authorityConnection: {
      available: true,
      context: productionAuthorityConnection(actor),
      assertActive: () => undefined
    }
  });

  assert.equal(receipt.ok, true);
  assert.deepEqual(directKinds, ["task-claim"]);
  assert.equal(inlineExecutions, 0);
});

test("parent command service preserves a structured child rejection before proceed", async () => {
  const actor = productionAuthorityActor();
  const service = createDaemonCommandService(
    unusedRuntime(),
    hostServices(() => undefined),
    {
      repoWriteDispatch: {
        repoId: "canonical",
        submit: async () => {
          throw new RepoWriteNotStartedError(
            "authority_ingress_rejected",
            "AUTHORITY_MANUAL_ENTITY_ID_FORBIDDEN: omit --id; decision-propose identity is generated by canonical ingress"
          );
        },
        direct: async () => {
          throw new Error("unexpected direct route");
        }
      }
    }
  );
  const receipt = await service.runCommand({
    command: {
      rootDir: "/repo",
      json: true,
      action: {
        kind: "progress-append",
        taskId: "task-rejected",
        text: "rejected before proceed",
        dryRun: false
      }
    },
    session: session()
  }, {
    actor,
    executor: { kind: "agent", id: "codex" },
    authorityConnection: {
      available: true,
      context: productionAuthorityConnection(actor),
      assertActive: () => undefined
    }
  });

  assert.equal(receipt.ok, false);
  assert.equal(receipt.error?.code, "authority_ingress_rejected", JSON.stringify(receipt));
  assert.match(receipt.error?.hint ?? "", /AUTHORITY_MANUAL_ENTITY_ID_FORBIDDEN/u);
});

test("unknown child receipts expose a caller-executable final-state query", async () => {
  const actor = productionAuthorityActor();
  for (const [kind, failure] of [
    ["durable", new RepoWriteOutcomeUnknownError("EXECUTION_OUTCOME_UNKNOWN", "write may have committed", "outer-op")],
    ["direct", new RepoWriteDirectOutcomeUnknownError("DIRECT_EXECUTION_OUTCOME_UNKNOWN", "write may have committed")]
  ] as const) {
    const service = createDaemonCommandService(
      unusedRuntime(),
      hostServices(() => undefined),
      {
        repoWriteDispatch: {
          repoId: "canonical",
          submit: async () => {
            if (kind !== "durable") throw new Error("unexpected durable route");
            throw failure;
          },
          direct: async () => {
            if (kind !== "direct") throw new Error("unexpected direct route");
            throw failure;
          }
        }
      }
    );
    const receipt = await service.runCommand({
      command: {
        rootDir: "/repo",
        json: true,
        action: kind === "durable"
          ? { kind: "progress-append", taskId: "task-queryable", text: "unknown", dryRun: false }
          : { kind: "task-claim", taskId: "task-queryable" }
      },
      session: session()
    }, {
      actor,
      executor: { kind: "agent", id: "codex" },
      authorityConnection: {
        available: true,
        context: productionAuthorityConnection(actor),
        assertActive: () => undefined
      }
    });

    assert.equal(receipt.ok, false, JSON.stringify(receipt));
    assert.equal(receipt.error?.code, "repo_write_outcome_unknown");
    const data = receipt.details?.data as Record<string, unknown>;
    const query = data.query as Record<string, unknown>;
    assert.equal(data.outcome, "unknown");
    assert.equal(query.schema, "command-outcome-query/v1");
    assert.equal(query.method, "task.show");
    assert.equal(query.command, "ha task show task-queryable --json");
    assert.match(receipt.error?.hint ?? "", /ha task show task-queryable --json/u);
    assert.doesNotMatch(receipt.error?.hint ?? "", /query the stable outer opId|repo-write\.lookup/u);
  }
});

test("decision outcome-unknown receipts give a concrete read-only projection check", async () => {
  const actor = productionAuthorityActor();
  const service = createDaemonCommandService(
    unusedRuntime(),
    hostServices(() => undefined),
    {
      repoWriteDispatch: {
        repoId: "canonical",
        submit: async () => {
          throw new RepoWriteOutcomeUnknownError(
            "EXECUTION_OUTCOME_UNKNOWN",
            "AUTHORITY_INDETERMINATE:PUBLICATION_OUTCOME_UNKNOWN:durable write may have committed. Exact repo-write outcome lookup failed for repo-write:decision-live; query the stable outer opId repo-write:decision-live.",
            "repo-write:decision-live"
          );
        },
        direct: async () => { throw new Error("unexpected direct route"); }
      }
    }
  );

  const receipt = await service.runCommand({
    command: {
      rootDir: "/repo",
      json: true,
      action: {
        kind: "decision-propose",
        decisionId: "dec_live",
        proposedAt: "2026-08-09T00:00:00.000Z",
        title: "Live decision",
        question: "Did the write commit?",
        chosen: [{ text: "Verify the projection" }],
        rejected: [{ text: "Replay immediately" }],
        claims: [],
        claimLoadBearing: false,
        fulfillments: [],
        riskTier: "high",
        urgency: "high",
        modules: [],
        productLines: [],
        evidenceRelations: [],
        dryRun: false
      }
    },
    session: session()
  }, {
    actor,
    executor: { kind: "agent", id: "codex" },
    authorityConnection: {
      available: true,
      context: productionAuthorityConnection(actor),
      assertActive: () => undefined
    }
  });

  assert.equal(receipt.error?.code, "repo_write_outcome_unknown");
  assert.equal(
    receipt.error?.hint,
    "The child writer may already have committed decision-propose, but its final outcome is unknown: AUTHORITY_INDETERMINATE:PUBLICATION_OUTCOME_UNKNOWN:durable write may have committed. Run `ha decision show dec_live --json` to inspect the canonical projection. If the decision is absent, the outcome is still unknown; do not replay the write."
  );
  assert.deepEqual(receipt.details?.data?.query, {
    schema: "command-outcome-query/v1",
    method: "decision.show",
    command: "ha decision show dec_live --json",
    parameters: { decisionId: "dec_live" },
    retry: "forbidden-after-absence"
  });
});

function hostServices(onExecute: () => void, overrides: {
  readonly actorAttribution?: (
    actor: ReturnType<typeof productionAuthorityActor>,
    command: TestCommand,
    executor: TaskHolderExecutor | null
  ) => AuthorityHostAttribution;
  readonly authorityCommand?: (command: TestCommand) => AuthorityHostCommand | undefined;
  readonly materializerCommandResult?: DaemonCommandHostServices<
    TestCommand,
    TestResult,
    ReturnType<typeof productionAuthorityActor>
  >["materializerCommandResult"];
} = {}): DaemonCommandHostServices<
  TestCommand,
  TestResult,
  ReturnType<typeof productionAuthorityActor>
> {
  return {
    parseCommandPayload: (payload) =>
      payload!.command as unknown as TestCommand,
    normalizeCommand: async (command) => command,
    authorityCommand: overrides.authorityCommand ?? (() => undefined),
    authorityIngressFor: () => "generic",
    repoWriteChildExecutionMode: (command) =>
      command.action.kind === "progress-append"
        || command.action.kind === "decision-propose"
        ? "durable"
        : "direct",
    receiptSeed: (command) => ({
      command: command.action.kind,
      action: command.action.kind
    }),
    actorAttribution: overrides.actorAttribution ?? (() => {
      throw new Error("parent actor attribution should not run");
    }),
    migrationWriteAttribution: (attribution) => attribution,
    isActorAttributionError: () => false,
    isDryRunAction: (command) => command.action.dryRun === true,
    executeCommand: async (command) => {
      onExecute();
      return { ok: true, command: command.action.kind };
    },
    materializerCommandResult: overrides.materializerCommandResult ?? (() => ({
      ok: true,
      command: "materializer"
    })),
    toReceipt: () => committedReceipt(),
    toErrorReceipt: ({ command, error }) => ({
      ok: false,
      schema: "command-receipt/v2",
      command,
      action: "run",
      summary: error.context.cause,
      meta: {
        generatedAt: "2026-07-24T00:00:00.000Z",
        compatibility: { legacyReceipt: "CommandReceipt/v1" }
      },
      error: { code: error.code, hint: error.context.cause }
    })
  };
}

function unusedRuntime(): HarnessDaemonRuntime {
  return {
    start: async () => { throw new Error("unused"); },
    stop: async () => undefined,
    status: () => ({ started: true }) as ReturnType<HarnessDaemonRuntime["status"]>,
    enqueueInteractiveWrite: async () => { throw new Error("parent inline write"); },
    enqueueBackgroundBatch: async () => { throw new Error("parent background write"); },
    enqueueMaterializerBatch: async () => { throw new Error("parent materializer"); },
    enqueueAuthorityPublication: async () => { throw new Error("parent authority"); },
    queryExecutionEvidencePage: async () => ({ rows: [], nextCursor: null }),
    createAttributedCoordinator: () => { throw new Error("parent coordinator"); },
    assertWriteFenceHeld: async () => { throw new Error("parent fence"); },
    admissionBudget: {} as HarnessDaemonRuntime["admissionBudget"],
    subscribeProjectionChanges: () => () => undefined
  };
}

function committedReceipt(): CommandReceiptEnvelope {
  return {
    ok: true,
    schema: "command-receipt/v2",
    command: "progress append",
    action: "append",
    summary: "child committed",
    next: [],
    meta: {
      generatedAt: "2026-07-24T00:00:00.000Z",
      compatibility: { legacyReceipt: "CommandReceipt/v1" }
    }
  };
}

function session() {
  return {
    runtime: "codex",
    sessionId: "session-child-route",
    source: "manual",
    detectedAt: "2026-07-24T00:00:00.000Z"
  };
}
