// harness-test-tier: integration
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { requestDaemonJsonRpcAt } from "../../daemon/src/client/local-json-rpc-client.ts";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../../daemon/src/dispatch-stream.ts";
import { makeTaskEventStore, makeTaskProjection } from "../../kernel/src/index.ts";
import {
  daemonGuiReadMethods,
  type DaemonGuiRpcReadMethod,
} from "../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  parseDaemonGuiActionResponse,
  parseDaemonGuiReadResponse,
  parseDaemonGuiReadResult,
} from "../../daemon/src/protocol/gui-result-validation.ts";
import { createLocalGuiServiceBridge } from "../src/index.ts";
import { startGuiResidentDaemonFixture } from "../test-support/resident-daemon.mjs";
import { writeTriadicLedger } from "../test-support/triadic-ledger.mjs";
import type { Failure } from "./service-bridge.fixtures.ts";
import { restoreEnv } from "./service-bridge.fixtures.ts";

import { seedEntityDeclarations, seedRuntime } from "./service-bridge.fixtures.ts";
const SEEDED_SQUAD_RUN_ID = "squad_aabbccddeeff001122334455";

test("GUI client reaches every shipped read through a real resident daemon", async () => {
  const fixture = await startGuiResidentDaemonFixture({
    task: { taskId: "task-gui-smoke", title: "Resident GUI task" },
    beforeRestart: (rootDir: string, repoId: string) => {
      seedRuntime(rootDir, repoId);
      seedSquadRunState(rootDir, repoId);
    },
  });
  const previous = {
    userRoot: process.env.HARNESS_DAEMON_USER_ROOT,
    daemonId: process.env.HARNESS_DAEMON_ID,
    repoId: process.env.HARNESS_DAEMON_REPO_ID,
  };
  Object.assign(process.env, fixture.env);
  try {
    writeTriadicLedger(fixture.rootDir);
    await seedEntityDeclarations(fixture.endpoint, fixture.repoId);
    const seededSquadRun = SEEDED_SQUAD_RUN_ID;
    const bridge = createLocalGuiServiceBridge(fixture.rootDir),
      executionId = "execution-gui-bridge",
      scope = { repoId: fixture.repoId };
    const started = parseDaemonGuiActionResponse(
      "repo.task.start",
      await bridge.invoke("startTask", {
        ...scope,
        taskId: "task-gui-smoke",
        executionId,
      }),
    );
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal(started.outcome, "applied");
    const documentBody = "# Canonical GUI document\n",
      documentPath = "tasks/task-gui-smoke-resident-gui-task/notes.md",
      authored = path.join(fixture.rootDir, "harness", documentPath);
    mkdirSync(path.dirname(authored), { recursive: true });
    writeFileSync(authored, documentBody);
    const status = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.run",
      {
        repo: { repoId: fixture.repoId },
        payload: { action: { kind: "doc-status", paths: [documentPath] } },
      },
      1_000,
    );
    assert.equal(status.ok, true, JSON.stringify(status));
    const synced = await requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.run",
      {
        repo: { repoId: fixture.repoId },
        payload: {
          action: { kind: "doc-submit", executionId, paths: [documentPath] },
        },
      },
      1_000,
    );
    assert.equal(synced.ok, true, JSON.stringify(synced));
    writeFileSync(authored, "# Uncommitted filesystem edit\n");
    const control = (await bridge.invoke("requestDaemonControl", {
      kind: "restart",
      authorityRepoId: fixture.repoId,
    })) as { operationId: string };
    const catalog = (await bridge.invoke("getCatalogSnapshot", scope)) as {
      defaults: { presetId: string };
    };
    const reread = (await bridge.invoke("rereadCatalog", {
      ...scope,
      expectedDigest: (catalog as { catalogDigest: string }).catalogDigest,
    })) as { schema: string; ok: boolean; operationId: string; repoId: string };
    assert.deepEqual(
      { schema: reread.schema, ok: reread.ok, repoId: reread.repoId },
      { schema: "catalog-reread-receipt/v1", ok: true, repoId: fixture.repoId },
    );
    assert.match(reread.operationId, /^catalog-/u);
    const results = new Map<DaemonGuiRpcReadMethod, unknown>();
    for (const contract of daemonGuiReadMethods) {
      const payload =
        contract.id === "gui.system.read"
          ? null
          : contract.id === "gui.control.receipt"
            ? { operationId: control.operationId }
            : contract.id === "observe.tail"
              ? { ...scope, kind: "events" }
              : contract.id === "tasks.document.read"
                ? { ...scope, taskId: "task-gui-smoke", path: "notes.md" }
                : contract.id === "tasks.documents.list" || contract.id === "task.dispatches"
                  ? { ...scope, taskId: "task-gui-smoke" }
                  : contract.id === "agentRuntime.sessions.read"
                    ? { ...scope, runtimeSessionId: "runtime-gui" }
                    : contract.id === "agentRuntime.events.read"
                      ? {
                          ...scope,
                          runtimeSessionId: "runtime-gui",
                          afterCursor: "lifecycle:0",
                        }
                      : contract.id === "agent.entity.read"
                        ? { ...scope, agentId: "terra" }
                        : contract.id === "squad.entity.read"
                          ? { ...scope, squadId: "core-squad" }
                          : contract.id === "squad.run.read"
                            ? { ...scope, squadRunId: seededSquadRun }
                            : contract.id === "gui.catalog.preset.read"
                              ? { ...scope, presetId: catalog.defaults.presetId }
                              : scope;
      const result = await bridge.invoke(contract.guiBridgeMethod, payload);
      const parsed =
        contract.id === "gui.control.receipt"
          ? parseDaemonGuiReadResult(contract.method, result)
          : parseDaemonGuiReadResponse(contract.method, result);
      if (contract.id === "gui.control.receipt")
        assert.equal(parsed.schema, "daemon-control-receipt/v1", contract.method);
      else assert.equal(parsed.ok, true, `${contract.method}: ${JSON.stringify(parsed)}`);
      results.set(contract.method, result);
    }
    assert.deepEqual(
      [...results.keys()],
      daemonGuiReadMethods.map(({ method }) => method),
    );
    const observability = parseDaemonGuiReadResult("observe.tail", results.get("observe.tail"));
    assert.equal(observability.schema, "daemon.observe-tail/v1");
    assert.equal(observability.repoId, fixture.repoId);
    assert.equal(observability.kind, "events");
    // G7 路线 A:catalog preset 读面携带 resolver 文档正文,GUI 详情页是它的消费者。
    // 上面的循环已用 validateCatalogPreset 校过闭形状,这里断言正文真实过桥。
    const presetDetail = results.get("repo.gui.catalog.preset.read") as {
      readonly resolved: {
        readonly documents: ReadonlyArray<{ readonly body: string; readonly mediaType: string }>;
      };
    };
    assert.ok(presetDetail.resolved.documents.length > 0, JSON.stringify(presetDetail));
    assert.ok(presetDetail.resolved.documents.every((document) => document.body.length > 0));
    assert.ok(
      presetDetail.resolved.documents.every((document) => ["text/markdown", "text/plain"].includes(document.mediaType)),
    );
    const agentCatalog = parseDaemonGuiReadResult("repo.agent.entities.list", results.get("repo.agent.entities.list"));
    assert.equal(agentCatalog.ok, true);
    assert.deepEqual(
      agentCatalog.agents.map(({ id }) => id),
      ["terra"],
    );
    assert.deepEqual(
      agentCatalog.agents[0] && {
        runtimeType: agentCatalog.agents[0].runtimeType,
        role: agentCatalog.agents[0].role,
        layer: agentCatalog.agents[0].layer,
        validity: agentCatalog.agents[0].validity,
      },
      {
        runtimeType: "codex",
        role: "worker",
        layer: "user",
        validity: "valid",
      },
    );
    const agentDetail = parseDaemonGuiReadResult("repo.agent.entity.read", results.get("repo.agent.entity.read"));
    assert.equal(agentDetail.ok, true);
    assert.deepEqual(
      agentDetail.agent && {
        id: agentDetail.agent.id,
        role: agentDetail.agent.role,
        instructions: agentDetail.agent.instructions,
      },
      { id: "terra", role: "worker", instructions: "Review precisely." },
    );
    const squadCatalog = parseDaemonGuiReadResult("repo.squad.entities.list", results.get("repo.squad.entities.list"));
    assert.equal(squadCatalog.ok, true);
    assert.deepEqual(
      squadCatalog.squads.map(({ id }) => id),
      ["core-squad"],
    );
    const squadDetail = parseDaemonGuiReadResult("repo.squad.entity.read", results.get("repo.squad.entity.read"));
    assert.equal(squadDetail.ok, true);
    assert.deepEqual(
      squadDetail.squad && {
        leader: squadDetail.squad.leader,
        workers: squadDetail.squad.workers,
      },
      { leader: "terra", workers: ["terra"] },
    );
    // G12 §2c:repo.squad.run.read 把 `ha squad status` 的编排流转(leader 轮次 →
    // worker 派工链)对 GUI 开放;这里断言种子状态真实过桥,且无台账的 worker
    // 尝试以 null 呈现而非伪造。
    const squadRun = parseDaemonGuiReadResult("repo.squad.run.read", results.get("repo.squad.run.read"));
    assert.equal(squadRun.ok, true);
    assert.equal(squadRun.run.phase, "converged");
    assert.equal(squadRun.run.mission, "Resident GUI squad run");
    assert.deepEqual(
      squadRun.run.leaderTurns.map(({ turnId, trigger, decision }) => ({ turnId, trigger, decision })),
      [{ turnId: "leader-1", trigger: { kind: "initial" }, decision: { kind: "converged" } }],
    );
    assert.deepEqual(
      squadRun.run.workerAttempts.map(({ attemptId, workerId, status, startedAt }) => ({
        attemptId,
        workerId,
        status,
        startedAt,
      })),
      [{ attemptId: "worker-1", workerId: "terra", status: null, startedAt: null }],
    );
    assert.equal(typeof squadRun.run.leaderTurns[0]?.startedAt, "string");
    const squadRunList = parseDaemonGuiReadResult("repo.squad.runs.list", results.get("repo.squad.runs.list"));
    assert.deepEqual(
      squadRunList.runs.map(({ squadRunId, phase }) => ({ squadRunId, phase })),
      [{ squadRunId: seededSquadRun, phase: "converged" }],
    );
    const tasks = parseDaemonGuiReadResult("repo.tasks.list", results.get("repo.tasks.list"));
    assert.deepEqual(
      tasks.rows.map(({ taskId }) => taskId),
      ["task-gui-smoke"],
    );
    assert.equal(tasks.rows[0]?.snapshot.task?.title, "Resident GUI task");
    assert.equal(tasks.rows[0]?.snapshot.task?.status, "active");
    assert.equal(tasks.rows[0]?.snapshot.lease?.executionId, executionId);
    const summary = parseDaemonGuiReadResult("repo.workspace.summary.read", results.get("repo.workspace.summary.read"));
    assert.deepEqual(
      {
        total: summary.tasks.total,
        active: summary.tasks.byStatus.active,
        inbox: summary.decisions.inboxCount,
      },
      { total: tasks.rows.length, active: 1, inbox: 1 },
    );
    assert.deepEqual(summary.decisions.groups.find(({ id }) => id === "proposed")?.decisionIds, ["dec_gui_smoke"]);
    const agenda = parseDaemonGuiReadResult("repo.agenda.read", results.get("repo.agenda.read"));
    assert.deepEqual(
      agenda.inFlight.map(({ taskId }) => taskId),
      ["task-gui-smoke"],
    );
    assert.match(agenda.summary, /在飞线/u);
    assert.deepEqual(tasks.rows[0]?.placement.moduleKeys, ["gui"]);
    assert.equal(tasks.rows[0]?.placement.origin, "native");
    const graph = parseDaemonGuiReadResult("repo.triadic.relationGraph", results.get("repo.triadic.relationGraph"));
    assert.deepEqual(
      graph.edges
        .map(({ sourceRef, targetRef, relationType }) => ({ sourceRef, targetRef, relationType }))
        .sort((left, right) =>
          `${left.relationType}|${left.sourceRef}`.localeCompare(`${right.relationType}|${right.sourceRef}`),
        ),
      [
        { sourceRef: "decision/dec_gui_smoke", targetRef: "task/task-gui-smoke", relationType: "derives" },
        {
          sourceRef: "decision/dec_gui_smoke/C1",
          targetRef: "fact/task-gui-smoke/F-ABCDEFGH",
          relationType: "evidenced-by",
        },
        { sourceRef: "execution/execution-gui-bridge", targetRef: "task/task-gui-smoke", relationType: "executes" },
        { sourceRef: "runtime-session/runtime-gui", targetRef: "task/task-gui", relationType: "executes" },
      ],
      "the execution and the runtime session each carry a distinct executes edge to their task",
    );
    assert.equal(graph.factAnchors.length, 1);
    assert.equal(graph.facts.length, 1);
    assert.equal(graph.facts[0]?.statement, "The GUI renderer received event-backed triadic rows.");
    const decisions = parseDaemonGuiReadResult("repo.decisions.list", results.get("repo.decisions.list"));
    assert.deepEqual(
      decisions.decisions.map(({ decisionId }) => decisionId),
      ["dec_gui_smoke"],
    );
    const controlled = parseDaemonGuiActionResponse("repo.decision.list", await bridge.invoke("listDecisions", scope));
    assert.equal(controlled.ok, true);
    assert.match(String(controlled.evidence), /dec_gui_smoke/u);
    const proposed = parseDaemonGuiActionResponse(
      "repo.decision.propose",
      await bridge.invoke("proposeDecision", {
        ...scope,
        title: "Exercise the GUI proposal bridge",
        question: "Can proposal and judgment settle through the resident daemon?",
        riskTier: "medium",
        urgency: "high",
        vertical: "software/coding",
        preset: "architecture-decision",
        decisionClass: "ordinary",
        appliesTo: { modules: ["gui"], productLines: ["harness"] },
        chosen: [
          {
            id: "CH1",
            text: "Use typed GUI facets",
            rationale: "They preserve the canonical packet",
          },
        ],
        rejected: [
          {
            id: "RJ1",
            text: "Use optimistic history",
            whyNot: "It is not canonical",
          },
        ],
        body: "## 背景\nResident bridge test.\n\n## 权衡\nTyped receipts over local optimism.\n\n## 结论\nUse daemon facets.\n",
        claims: [],
        fulfillments: [],
        relations: [],
      }),
    );
    assert.equal(proposed.ok, true, JSON.stringify(proposed));
    assert.equal(proposed.outcome, "applied");
    assert.equal(proposed.worktreeVisible, true);
    assert.equal(proposed.consentId, null);
    assert.match(String(proposed.path), /^decisions\/decision-dec_/u);
    assert.equal(proposed.commitSha, null);
    assert.equal(typeof proposed.cut, "object");
    assert.match(String(proposed.documentSha256), /^(?:sha256:)?[0-9a-f]{64}$/u);
    const proposedEvidence = JSON.parse(String(proposed.evidence)) as {
      decisionId: string;
    };
    assert.match(proposedEvidence.decisionId, /^dec_[0-9A-F]{26}$/u);
    const accepted = parseDaemonGuiActionResponse(
      "repo.decision.accept",
      await bridge.invoke("acceptDecision", {
        ...scope,
        decisionId: proposedEvidence.decisionId,
        rationale: "Independent resident-daemon acceptance.",
        judgmentOnlyRationale: "No load-bearing claim was declared; explicit human judgment is recorded.",
      }),
    );
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    assert.equal(accepted.outcome, "applied");
    assert.equal(accepted.worktreeVisible, true);
    assert.match(String(accepted.consentId), /^djc_[0-9a-f]{26}$/u);
    const acceptedReceipt = parseDaemonGuiActionResponse(
      "repo.receipt.show",
      await bridge.invoke("showReceipt", { ...scope, opId: accepted.opId }),
    );
    assert.equal(acceptedReceipt.outcome, "applied");
    assert.equal(acceptedReceipt.consentId, accepted.consentId);
    const shown = parseDaemonGuiActionResponse(
      "repo.decision.show",
      await bridge.invoke("showDecision", {
        ...scope,
        decisionId: proposedEvidence.decisionId,
        includeBody: true,
      }),
    );
    assert.equal(shown.ok, true);
    assert.match(String(shown.evidence), new RegExp(String(accepted.consentId), "u"));
    const afterJudgment = parseDaemonGuiReadResult("repo.decisions.list", await bridge.invoke("getDecisions", scope));
    const canonicalDecision = afterJudgment.decisions.find(
      (decision) => decision.decisionId === proposedEvidence.decisionId,
    );
    assert.equal(canonicalDecision?.state, "in_effect");
    assert.equal(canonicalDecision?.judgmentConsents[0]?.consentId, accepted.consentId);
    const document = parseDaemonGuiReadResult("repo.tasks.document.read", results.get("repo.tasks.document.read"));
    assert.equal(document.body, documentBody);
    assert.equal(document.path, "notes.md");
    assert.equal(document.status, "ready");
    const documents = parseDaemonGuiReadResult("repo.tasks.documents.list", results.get("repo.tasks.documents.list"));
    assert.equal(documents.status, "ready");
    assert.ok(
      documents.documents.some((row) => row.path === "notes.md"),
      JSON.stringify(documents.documents),
    );
    const progress = parseDaemonGuiActionResponse(
      "repo.task.progress.append",
      await bridge.invoke("appendTaskProgress", {
        ...scope,
        taskId: "task-gui-smoke",
        executionId,
        text: "Renderer sent typed progress.",
        evidence: [
          {
            type: "test",
            path: "packages/gui/test/service-bridge.test.ts",
            summary: "resident daemon bridge",
          },
        ],
        baseDocumentSha256: null,
      }),
    );
    assert.equal(progress.ok, true, JSON.stringify(progress));
    assert.equal(progress.outcome, "applied");
    assert.equal(progress.commitSha, null);
    assert.equal(typeof progress.cut, "object");
    let settledProgress = progress;
    const publicationDeadline = performance.now() + 10_000;
    while (settledProgress.commitSha === null && performance.now() < publicationDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      settledProgress = parseDaemonGuiActionResponse(
        "repo.receipt.show",
        await bridge.invoke("showReceipt", { ...scope, opId: progress.opId }),
      );
    }
    const commitSha = String(settledProgress.commitSha);
    assert.match(commitSha, /^[0-9a-f]{40}$/u);
    const submitted = parseDaemonGuiActionResponse(
      "repo.task.submit",
      await bridge.invoke("submitTask", {
        ...scope,
        taskId: "task-gui-smoke",
        executionId,
        submission: {
          completionClaim: "GUI task mutation bridge is exercised.",
          deliverables: ["Task action bridge"],
          outputs: ["packages/gui/test/service-bridge.test.ts"],
          verificationNotes: ["resident daemon"],
          knownGaps: ["Electron E2E unverified"],
          residualRisks: ["manual desktop verification pending"],
          commitSha,
        },
      }),
    );
    assert.equal(submitted.ok, true, JSON.stringify(submitted));
    assert.equal(submitted.outcome, "applied");
    const afterSubmit = parseDaemonGuiReadResult("repo.tasks.list", await bridge.invoke("getTasks", scope));
    assert.equal(afterSubmit.rows[0]?.snapshot.task?.status, "in_review");
    assert.equal(afterSubmit.rows[0]?.snapshot.lease, null);
    const evidence = afterSubmit.rows[0]?.executionEvidence.find((item) => item.executionId === executionId),
      output = evidence?.outputs[0];
    assert.equal(evidence?.origin, "native");
    assert.match(output?.evidenceId ?? "", /^evidence_[0-9a-f]{24}$/u);
    assert.deepEqual(
      output && {
        locator: output.locator,
        substrate: output.substrate,
        checkerReceiptRef: output.checkerReceiptRef,
        checkerResult: output.checkerResult,
      },
      {
        locator: "packages/gui/test/service-bridge.test.ts",
        substrate: "repository-path",
        checkerReceiptRef: null,
        checkerResult: "unknown",
      },
    );
  } finally {
    await fixture.stop();
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous.userRoot);
    restoreEnv("HARNESS_DAEMON_ID", previous.daemonId);
    restoreEnv("HARNESS_DAEMON_REPO_ID", previous.repoId);
  }
});

/** 种一个已收敛的 squad run 状态(G12 §2c):与 `ha squad run` 的持久化路径同构 ——
 * 派工流头部 + squad_run_state 记录;worker 派工刻意不落流,断言读面以 null 呈现。 */
function seedSquadRunState(rootDir: string, repoId: string): string {
  const squadRunId = SEEDED_SQUAD_RUN_ID,
    leaderDispatchId = "dispatch_0000000000000000000000a1",
    workerDispatchId = "dispatch_0000000000000000000000b2";
  openDispatchStream(rootDir, {
    dispatchId: leaderDispatchId,
    taskId: "task-gui-smoke",
    executionId: "execution-gui",
    runtimeSessionId: "runtime-squad-leader",
    instanceId: "codex-gui",
    startedAt: "2026-08-13T00:05:00.000Z",
    agentId: "terra",
    agentName: "terra",
  });
  appendRuntimeWorkerRecord(rootDir, leaderDispatchId, {
    kind: "squad_run_state",
    squadRunId,
    revision: 3,
    state: {
      schema: "squad-run/v1",
      squadRunId,
      stateDispatchId: leaderDispatchId,
      squadId: "core-squad",
      taskId: "task-gui-smoke",
      runtimeInstanceId: "codex-gui",
      cwd: rootDir,
      mission: "Resident GUI squad run",
      model: null,
      effort: null,
      leaderAgentId: "terra",
      roster: "terra » terra",
      workers: ["terra"],
      binding: { actor: { principal: { personId: "person-gui" }, executor: null }, source: "local" },
      leaderTurns: [
        {
          turnId: "leader-1",
          trigger: { kind: "initial" },
          dispatchId: leaderDispatchId,
          runtimeSessionId: "runtime-squad-leader",
          decision: { kind: "converged" },
        },
      ],
      leaderProviderSessionId: null,
      currentLeaderRuntimeSessionId: null,
      workerAttempts: [
        {
          attemptId: "worker-1",
          workerId: "terra",
          dispatchId: workerDispatchId,
          runtimeSessionId: "runtime-squad-worker",
          rejection: null,
        },
      ],
      observedWorkerRuntimeSessionIds: [],
      pendingLeaderTriggers: [],
      phase: "converged",
      revision: 3,
      error: null,
    },
  });
  // 首次 daemon 已把「无 squad run」的缓存标成 ready;fixture 直接落流绕过了
  // production writeState 的 upsert,因此在重启前显式标脏,让 resident daemon
  // 按真实 recovery 路径从 squad_run_state 重放。
  const projection = makeTaskProjection({ rootDir, eventStore: makeTaskEventStore({ rootDir, repoId }) });
  projection.markSquadRunProjectionDirty();
  projection.close();
  return squadRunId;
}

test("local GUI bridge fails closed without explicit daemon registration and never autostarts", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-gui-explicit-daemon-")),
    userRoot = path.join(rootDir, "user-daemon");
  const previous = process.env.HARNESS_DAEMON_USER_ROOT;
  process.env.HARNESS_DAEMON_USER_ROOT = userRoot;
  try {
    const result = (await createLocalGuiServiceBridge(rootDir).invoke("getTasks", {
      repoId: "missing-repo",
    })) as Failure;
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "daemon_unavailable");
    assert.match(result.error?.hint ?? "", /workspace is not registered/u);
    assert.equal(existsSync(path.join(userRoot, "registry.json")), false);
  } finally {
    restoreEnv("HARNESS_DAEMON_USER_ROOT", previous);
    rmSync(rootDir, { recursive: true, force: true });
  }
});
