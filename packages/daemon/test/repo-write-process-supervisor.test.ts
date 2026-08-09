// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  forkRepoWriteProcess,
  type RepoWriteParentProcessTransport
} from "../src/runtime/repo-write-child-process-transport.ts";
import {
  RepoWriteProcessSupervisor,
  mostActionableRepoWriteErrorMessage
} from "../src/runtime/repo-write-process-supervisor.ts";
import {
  RepoWriteDirectOutcomeUnknownError,
  RepoWriteOutcomeUnknownError,
  RepoWriteProtocolViolationError,
  RepoWriteStartupStalledError
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
import { forceTerminateChildAndWait } from "../../../tools/test-child-process-lifecycle.mjs";

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

test("a failed graceful drain still stops the child without reporting a false stop failure", {
  skip: process.platform === "win32" ? "POSIX child signal semantics are required" : false
}, async (context) => {
  let transport: RepoWriteParentProcessTransport | undefined;
  const gracefulStopFailures: unknown[] = [];
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    onGracefulStopFailure: (error) => {
      gracefulStopFailures.push(error);
    },
    spawn: () => {
      transport = forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["shutdown-failure"]
      });
      return transport;
    }
  });
  context.after(async () => {
    if (transport?.child.exitCode === null && transport.child.signalCode === null) {
      await forceTerminateChildAndWait(transport.child, {
        label: "failed-drain repo writer cleanup"
      });
    }
  });

  await supervisor.start();
  await supervisor.stop({ timeoutMs: 500 });

  assert.equal(supervisor.status().connected, false);
  assert.equal(transport?.child.signalCode, "SIGTERM");
  assert.equal(gracefulStopFailures.length, 1);
  assert.match(String(gracefulStopFailures[0]), /fixture graceful drain failed/u);
});

test("the default stop budget does not preempt a child that drains gracefully", {
  skip: process.platform === "win32" ? "POSIX child signal semantics are required" : false
}, async (context) => {
  let transport: RepoWriteParentProcessTransport | undefined;
  const gracefulStopFailures: unknown[] = [];
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    onGracefulStopFailure: (error) => {
      gracefulStopFailures.push(error);
    },
    spawn: () => {
      transport = forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["slow-shutdown-success"]
      });
      return transport;
    }
  });
  context.after(async () => {
    if (transport?.child.exitCode === null && transport.child.signalCode === null) {
      await forceTerminateChildAndWait(transport.child, {
        label: "slow-drain repo writer cleanup"
      });
    }
  });

  await supervisor.start();
  await supervisor.stop();

  assert.deepEqual(gracefulStopFailures, []);
  assert.equal(transport?.child.signalCode, "SIGTERM");
});

test("stop escalates past an ignored SIGTERM and confirms the child is gone", {
  skip: process.platform === "win32" ? "POSIX child signal semantics are required" : false
}, async (context) => {
  let transport: RepoWriteParentProcessTransport | undefined;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    spawn: () => {
      transport = forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["ignore-sigterm-shutdown-failure"]
      });
      return transport;
    }
  });
  context.after(async () => {
    if (transport?.child.exitCode === null && transport.child.signalCode === null) {
      await forceTerminateChildAndWait(transport.child, {
        label: "SIGTERM-resistant repo writer cleanup"
      });
    }
  });

  await supervisor.start();
  await supervisor.stop({ timeoutMs: 500 });

  assert.equal(supervisor.status().connected, false);
  assert.equal(transport?.child.signalCode, "SIGKILL");
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

test("connected child with no startup progress is terminated after the stall window", async (context) => {
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
    assert.ok(error instanceof RepoWriteStartupStalledError);
    assert.equal(error.code, "REPO_WRITE_STARTUP_STALLED");
    assert.match(error.message, /startup stalled/u);
    return true;
  });
  assert.equal(supervisor.status().connected, false);
});

/**
 * The stall window also covers the child's own process boot, because the first
 * progress frame cannot arrive before the fork is running. A window sized below
 * that boot cost measures runner speed rather than the detector: at 1_000ms this
 * test failed on CI with zero frames observed while boot took ~1.2s. Production
 * has no such squeeze (`readyTimeoutMs` is 30_000), so the window here stays
 * several times the observed boot cost, and the fixture's inter-frame gap stays
 * several times below the window. Both margins are load-bearing — shrink either
 * and the test starts reporting how busy the machine is.
 */
const STARTUP_STALL_WINDOW_MS = 3_000;

test("slow startup with distinct work units may exceed one stall window", async (context) => {
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    limits: { readyTimeoutMs: STARTUP_STALL_WINDOW_MS },
    spawn: () => forkRepoWriteProcess({
      modulePath: fixturePath,
      args: ["slow-startup-progress"]
    })
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  const startedAt = performance.now();
  await supervisor.start();

  // Reaching READY later than one whole window is the discriminating claim:
  // without renewal on each new work unit the child would have been killed.
  assert.ok(performance.now() - startedAt > STARTUP_STALL_WINDOW_MS);
  assert.equal(supervisor.status().connected, true);
});

test("alive child repeating one startup work unit is terminated as stalled", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-startup-stall-"));
  const tracePath = path.join(root, "trace.log");
  let transport: RepoWriteParentProcessTransport | undefined;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    limits: { readyTimeoutMs: STARTUP_STALL_WINDOW_MS },
    spawn: () => {
      transport = forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["repeat-startup-work-unit", tracePath]
      });
      return transport;
    }
  });
  context.after(async () => {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const starting = supervisor.start();
  await waitFor(() => existsSync(tracePath));
  assert.ok(transport);
  assert.equal(transport.child.exitCode, null);
  assert.equal(transport.child.signalCode, null);

  await assert.rejects(starting, (error) => {
    assert.ok(error instanceof RepoWriteStartupStalledError);
    assert.equal(error.phase, "historical-recovery");
    assert.equal(error.workUnit, "repo-write:outer-op-stuck");
    assert.ok(error.repeatedProgressFrames > 0);
    assert.match(error.message, /startup stalled/u);
    assert.doesNotMatch(error.message, /still starting/u);
    return true;
  });
  assert.equal(supervisor.status().connected, false);
});

test("child that swallows PROCEED is replaced after the bounded stall window and recovered by exact lookup", async (context) => {
  const requestTimeoutMs = 40;
  const proceededStallTimeoutMs = requestTimeoutMs * 2;
  let forks = 0;
  const timeoutDiagnostics: RepoWriteRequestTimeoutDiagnostic[] = [];
  let timeoutDiagnostic: RepoWriteRequestTimeoutDiagnostic | undefined;
  let confirmProceedStalled!: () => void;
  const proceedStalled = new Promise<void>((resolve) => {
    confirmProceedStalled = resolve;
  });
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    limits: {
      requestTimeoutMs,
      proceededStallTimeoutMs
    },
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["swallow-proceed"]
      });
    },
    onRequestTimeout: (diagnostic) => {
      timeoutDiagnostic = diagnostic;
      timeoutDiagnostics.push(diagnostic);
    },
    onDiagnostic: (frame) => {
      if (frame.code === "FIXTURE_PROCEED_STALLED") confirmProceedStalled();
    }
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  await supervisor.start();
  context.mock.timers.enable({ apis: ["setTimeout"] });

  const pendingOutcome = supervisor.submit(command());
  const outcome = pendingOutcome.then(
    () => ({ kind: "committed" as const }),
    (error: unknown) => ({ kind: "rejected" as const, error })
  );
  await proceedStalled;
  assert.equal(timeoutDiagnostic, undefined);

  context.mock.timers.tick(requestTimeoutMs);
  assert.equal(timeoutDiagnostic?.watchdogStage, "observation");
  assert.ok(timeoutDiagnostic);
  assert.equal(timeoutDiagnostic.deadlineMs, requestTimeoutMs);
  assert.equal(timeoutDiagnostic.lastTelemetry?.phase, "git");

  context.mock.timers.tick(proceededStallTimeoutMs - requestTimeoutMs);
  const settledOutcome = await outcome;

  assert.equal(settledOutcome.kind, "rejected");
  assert.ok(settledOutcome.kind === "rejected" && settledOutcome.error instanceof RepoWriteOutcomeUnknownError);
  assert.equal(settledOutcome.error.code, "REPO_WRITE_STALL_TIMEOUT");
  assert.equal(forks, 2);
  assert.deepEqual(
    timeoutDiagnostics.map((diagnostic) => [
      diagnostic.watchdogStage,
      diagnostic.deadlineMs,
      diagnostic.opId,
      diagnostic.lastTelemetry?.phase
    ]),
    [
      ["observation", requestTimeoutMs, timeoutDiagnostics[0]?.opId, "git"],
      ["escalation", proceededStallTimeoutMs, timeoutDiagnostics[0]?.opId, "git"]
    ]
  );
});

test("non-durable task-claim timeout replaces the child without replay or lookup", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-direct-"));
  const tracePath = path.join(root, "trace.log");
  const requestTimeoutMs = 40;
  let forks = 0;
  let lastTelemetryPhase: string | undefined;
  let timeoutDiagnostic: RepoWriteRequestTimeoutDiagnostic | undefined;
  let confirmDirectStalled!: () => void;
  const directStalled = new Promise<void>((resolve) => {
    confirmDirectStalled = resolve;
  });
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    limits: { requestTimeoutMs },
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: [forks === 1 ? "swallow-direct" : "roundtrip", tracePath]
      });
    },
    onRequestTimeout: (diagnostic) => {
      timeoutDiagnostic = diagnostic;
    },
    onTelemetry: (frame) => {
      lastTelemetryPhase = frame.phase;
    },
    onDiagnostic: (frame) => {
      if (frame.code === "FIXTURE_DIRECT_STALLED") confirmDirectStalled();
    }
  });
  context.after(async () => {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  await supervisor.start();
  context.mock.timers.enable({ apis: ["setTimeout"] });

  const trace = createDaemonRequestPerformanceTrace({
    method: "repo.command.run",
    requestId: "direct-timeout-recovery",
    receivedAtMs: performance.now()
  });
  const outcome = runWithDaemonRequestPerformanceTrace(trace, () =>
    supervisor.direct(command("", "task-claim")));
  void outcome.catch(() => undefined);
  // Wait for the child to report its phase, then advance the modeled deadline;
  // neither assertion depends on which real-time callback the runner schedules first.
  await directStalled;
  assert.equal(timeoutDiagnostic, undefined);
  context.mock.timers.tick(requestTimeoutMs);
  await assert.rejects(
    outcome,
    (error) => error instanceof RepoWriteDirectOutcomeUnknownError
  );
  assert.equal(lastTelemetryPhase, "projection");
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
