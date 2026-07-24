// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CommandReceiptEnvelope,
  DaemonCommandHostServices,
  DaemonHostCommand,
  DaemonHostCommandResult
} from "@harness-anything/application";
import type { HarnessDaemonRuntime } from "../src/runtime/repo-runtime.ts";
import {
  decodeRepoWriteCommand
} from "../src/runtime/repo-write-progress-command.ts";
import { createDaemonCommandService } from "../src/service/command-service.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "../../cli/test/helpers/production-authority-connection.ts";

interface TestCommand extends DaemonHostCommand {
  readonly action: {
    readonly kind: string;
    readonly dryRun?: boolean;
  };
}

interface TestResult extends DaemonHostCommandResult {
  readonly ok: boolean;
  readonly command: string;
}

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
      action: {
        kind: "task-claim",
        taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4",
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
  assert.deepEqual(directKinds, ["task-claim"]);
  assert.equal(inlineExecutions, 0);
});

function hostServices(onExecute: () => void): DaemonCommandHostServices<
  TestCommand,
  TestResult,
  ReturnType<typeof productionAuthorityActor>
> {
  return {
    parseCommandPayload: (payload) =>
      payload!.command as unknown as TestCommand,
    normalizeCommand: async (command) => command,
    authorityCommand: () => undefined,
    authorityIngressFor: () => "generic",
    repoWriteChildExecutionMode: (command) =>
      command.action.kind === "progress-append" ? "durable" : "direct",
    receiptSeed: (command) => ({
      command: command.action.kind,
      action: command.action.kind
    }),
    actorAttribution: () => {
      throw new Error("parent actor attribution should not run");
    },
    migrationWriteAttribution: (attribution) => attribution,
    isActorAttributionError: () => false,
    isDryRunAction: (command) => command.action.dryRun === true,
    executeCommand: async (command) => {
      onExecute();
      return { ok: true, command: command.action.kind };
    },
    materializerCommandResult: () => ({
      ok: true,
      command: "materializer"
    }),
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
