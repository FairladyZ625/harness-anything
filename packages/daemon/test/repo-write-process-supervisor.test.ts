// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  forkRepoWriteProcess
} from "../src/runtime/repo-write-child-process-transport.ts";
import {
  RepoWriteProcessSupervisor,
  mostActionableRepoWriteErrorMessage
} from "../src/runtime/repo-write-process-supervisor.ts";
import {
  RepoWriteDirectOutcomeUnknownError,
  RepoWriteOutcomeUnknownError,
  RepoWriteProtocolViolationError,
  RepoWriteReadyTimeoutError
} from "../src/runtime/repo-write-client.ts";
import {
  calculateDaemonArtifactIdentity
} from "../src/protocol/daemon-artifact-identity.ts";
import type { RepoWriteRequestTimeoutDiagnostic } from "../src/runtime/repo-write-client-contract.ts";
import { formatRepoWriteTimeoutDiagnostic } from "../src/runtime/repo-write-stall-diagnostic.ts";
import {
  createDaemonRequestPerformanceTrace,
  runWithDaemonRequestPerformanceTrace
} from "../src/observability/request-performance.ts";
import { classifyProvenanceCapacitySample } from "../src/observability/provenance-capacity-trigger.ts";
import { repoWriteProductionCommandFixture } from "./support/repo-write-production-command-fixture.ts";

const fixturePath = fileURLToPath(
  new URL("./support/repo-write-ipc-child.ts", import.meta.url)
);

test("nested authority failures lead with the innermost actionable reason", () => {
  const nested = new Error([
    "Error: AUTHORITY_INDETERMINATE:PUBLICATION_OUTCOME_UNKNOWN:",
    JSON.stringify({
      _tag: "JournalUnavailable",
      cause: {
        name: "(FiberFailure) Error",
        message: JSON.stringify({
          _tag: "WriteRejected",
          taskId: "task_nested",
          reason: "invalid document path segment: ops/qa/"
        })
      }
    })
  ].join(" "));

  assert.equal(
    mostActionableRepoWriteErrorMessage(nested),
    "invalid document path segment: ops/qa/"
  );
});

test("supervisor submits through one child and drains it without inline fallback", async (context) => {
  let forks = 0;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["roundtrip"]
      });
    }
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  await supervisor.start();
  const receipt = await supervisor.submit(command());

  assert.equal(receipt.ok, true);
  assert.equal(receipt.summary, "transport submission");
  assert.equal(forks, 1);
  assert.equal(supervisor.status().connected, true);
  await supervisor.stop();
  assert.equal(supervisor.status().connected, false);
});

test("expected direct rejection returns a failed receipt without replacing the writer", async (context) => {
  let forks = 0;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["expected-direct-rejection"]
      });
    }
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  const receipt = await supervisor.direct(command("direct-rejection"));

  assert.equal(receipt.ok, false, JSON.stringify(receipt));
  if (!receipt.ok) {
    assert.equal(receipt.error?.code, "task_holder_required");
    assert.deepEqual(receipt.error?.context, { taskId: "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG8" });
  }
  assert.equal(forks, 1);
});

test("supervisor forwards startup recovery diagnostics before READY", async (context) => {
  const diagnostics: unknown[] = [];
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    spawn: () => forkRepoWriteProcess({
      modulePath: fixturePath,
      args: ["recovery-deferred"]
    }),
    onDiagnostic: (frame) => diagnostics.push(frame)
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  await supervisor.start();
  assert.deepEqual(diagnostics, [{
    protocol: "harness-repo-write-ipc/v1",
    repoId: "repo-transport",
    generation: 1,
    kind: "recovery-deferred",
    outerOpId: "repo-write:historical",
    code: "GIT_PATH_NOT_SAFE",
    diagnostic: "historical recovery remains fail-closed"
  }]);
});

test("post-proceed child crash performs one exact op lookup in a replacement capsule", async (context) => {
  let forks = 0;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["crash-after-proceed"]
      });
    }
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  const receipt = await supervisor.submit(command());

  assert.equal(receipt.ok, true);
  assert.equal(receipt.summary, "transport recovery");
  assert.equal(forks, 2);
  assert.equal(supervisor.status().generation, 1);
});

test("replacement child gets a fresh client whose first request is cold-start sequence one", async (context) => {
  let forks = 0;
  const telemetryRequestIds: string[] = [];
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["roundtrip"]
      });
    },
    onTelemetry: (frame) => telemetryRequestIds.push(frame.requestId)
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  await supervisor.start();
  const firstPid = supervisor.status().pid!;
  await supervisor.lookup("before-replacement");
  process.kill(firstPid, "SIGKILL");
  await waitFor(() => !supervisor.status().connected);

  await supervisor.lookup("after-replacement");
  const replacementPid = supervisor.status().pid!;

  assert.equal(forks, 2);
  assert.notEqual(replacementPid, firstPid);
  assert.deepEqual(telemetryRequestIds, ["1:1", "1:1"]);
  assert.equal(classifyProvenanceCapacitySample(telemetryRequestIds[1]!, 1), "cold-start");
});

test("connected child that never announces READY is terminated at the readiness deadline", async (context) => {
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    limits: {
      readyTimeoutMs: 40
    },
    spawn: () => forkRepoWriteProcess({
      modulePath: fixturePath,
      args: ["never-ready"]
    })
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  await assert.rejects(supervisor.start(), (error) => {
    assert.ok(error instanceof RepoWriteReadyTimeoutError);
    assert.equal(error.code, "REPO_WRITE_READY_TIMEOUT");
    return true;
  });
  assert.equal(supervisor.status().connected, false);
});

test("child that swallows PROCEED is replaced after the bounded stall window and recovered by exact lookup", async (context) => {
  let forks = 0;
  const timeoutDiagnostics: RepoWriteRequestTimeoutDiagnostic[] = [];
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    limits: {
      requestTimeoutMs: 40
    },
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["swallow-proceed"]
      });
    },
    onRequestTimeout: (diagnostic) => timeoutDiagnostics.push(diagnostic)
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  // Boundedness is asserted by awaiting the rejection itself: an unbounded
  // regression hangs into the runner's per-test timeout instead of racing a
  // wall-clock budget that slow CI child spawns cannot meet.
  const outcome = await supervisor.submit(command()).then(
    () => ({ kind: "committed" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error })
  );

  assert.equal(outcome.kind, "rejected");
  assert.ok(outcome.kind === "rejected" && outcome.error instanceof RepoWriteOutcomeUnknownError);
  assert.equal(outcome.error.code, "REPO_WRITE_STALL_TIMEOUT");
  assert.equal(forks, 2);
  assert.deepEqual(
    timeoutDiagnostics.map((diagnostic) => [
      diagnostic.watchdogStage,
      diagnostic.deadlineMs,
      diagnostic.opId,
      diagnostic.lastTelemetry?.phase
    ]),
    [
      ["observation", 40, timeoutDiagnostics[0]?.opId, "git"],
      ["escalation", 80, timeoutDiagnostics[0]?.opId, "git"]
    ]
  );
});

test("non-durable task-claim timeout replaces the child without replay or lookup", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-direct-"));
  const tracePath = path.join(root, "trace.log");
  let forks = 0;
  let timeoutDiagnostic: RepoWriteRequestTimeoutDiagnostic | undefined;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    limits: { requestTimeoutMs: 40 },
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: [forks === 1 ? "swallow-direct" : "roundtrip", tracePath]
      });
    },
    onRequestTimeout: (diagnostic) => {
      timeoutDiagnostic = diagnostic;
    }
  });
  context.after(async () => {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const trace = createDaemonRequestPerformanceTrace({
    method: "repo.command.run",
    requestId: "direct-timeout-recovery",
    receivedAtMs: performance.now()
  });
  await runWithDaemonRequestPerformanceTrace(trace, () => assert.rejects(
      supervisor.direct(command("", "task-claim")),
      (error) => error instanceof RepoWriteDirectOutcomeUnknownError
    ));
  const performanceSummary = trace.finish("response-written");
  assert.equal(forks, 2);
  assert.ok((performanceSummary.phasesMs["repo-write-recovery"] ?? 0) > 0);
  assert.ok(timeoutDiagnostic);
  assert.match(
    formatRepoWriteTimeoutDiagnostic(timeoutDiagnostic),
    /command=task-claim;lane=direct;waiting=daemon-write-queue:authority-publication;lastPhase=projection/u
  );
  assert.deepEqual(
    readFileSync(tracePath, "utf8").trim().split("\n"),
    ["direct:task-claim"]
  );
});

test("replacement recovers new-task A before admitting decision-propose B", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-order-"));
  const tracePath = path.join(root, "trace.log");
  let forks = 0;
  let queued: Promise<unknown> | undefined;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    spawn: () => {
      forks += 1;
      const transport = forkRepoWriteProcess({
        modulePath: fixturePath,
        args: [forks === 1 ? "crash-after-proceed" : "roundtrip", tracePath]
      });
      if (forks === 1) {
        transport.onDisconnect(() => {
          queued = supervisor.submit(command("B", "decision-propose"));
        });
      }
      return transport;
    }
  });
  context.after(async () => {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const recovered = await supervisor.submit(command("A", "new-task"));
  await queued;
  assert.equal(recovered.ok, true);
  const trace = readFileSync(tracePath, "utf8").trim().split("\n");
  assert.ok(
    trace.indexOf("status:op-1:1") < trace.indexOf("submit:B"),
    `expected recovery before B, received ${trace.join(",")}`
  );
});

test("replacement rejects an entrypoint whose artifact changed after initial READY", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-entrypoint-"));
  const childPath = path.join(root, "pinned-child.mjs");
  const identityModule = new URL(
    "../src/protocol/daemon-artifact-identity.ts",
    import.meta.url
  ).href;
  const source = pinnedChildSource(identityModule);
  writeFileSync(childPath, source, "utf8");
  const expectedArtifactIdentity =
    calculateDaemonArtifactIdentity(childPath).identity;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    expectedArtifactIdentity,
    spawn: () => forkRepoWriteProcess({
      modulePath: childPath
    })
  });
  context.after(async () => {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  await supervisor.start();
  writeFileSync(childPath, `${source}\n// drift after READY\n`, "utf8");
  process.kill(supervisor.status().pid!, "SIGKILL");
  await waitFor(() => !supervisor.status().connected);

  await assert.rejects(supervisor.submit(command("", "decision-propose")), (error) => {
    assert.ok(error instanceof RepoWriteProtocolViolationError);
    assert.match(error.message, /artifact identity/u);
    return true;
  });
});

function command(
  label = "",
  commandName: Parameters<typeof repoWriteProductionCommandFixture>[0] =
    "decision-propose"
) {
  return repoWriteProductionCommandFixture(commandName, label);
}

function pinnedChildSource(identityModule: string): string {
  return [
    `import { calculateDaemonArtifactIdentity } from ${JSON.stringify(identityModule)};`,
    "const artifactIdentity = calculateDaemonArtifactIdentity(process.argv[1]).identity;",
    "const base = { protocol: 'harness-repo-write-ipc/v1', repoId: 'repo-transport', generation: 1 };",
    "process.send({ ...base, kind: 'ready', artifactIdentity });",
    "process.on('message', (message) => {",
    "  if (message.kind === 'status') process.send({ ...base, kind: 'status', requestId: message.requestId, opId: message.opId, state: 'not-found' });",
    "  if (message.kind === 'shutdown') process.send({ ...base, kind: 'drained', requestId: message.requestId }, () => process.disconnect());",
    "});",
    ""
  ].join("\n");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for child state");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
