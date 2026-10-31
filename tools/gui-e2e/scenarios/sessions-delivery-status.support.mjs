import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { canonicalEventWritePlan } from "../../../packages/kernel/src/index.ts";
import { makeTaskEventStore, makeTaskProjection } from "../../../packages/storage/src/index.ts";
import { requestDaemonJsonRpcAt } from "../../../packages/daemon/src/client/local-json-rpc-client.ts";

/**
 * 会话页交付真相(task_10e4cd6f09ee0317ae06c641fd):文档类任务的 runtime 结算停在
 * stopped,但 execution 已提交 artifacts-only 交付(commitSha=null + 冻结 artifacts)
 * ——读面必须显示已交付。本夹具种出生产同形的数据:
 *
 *   task-e2e-docs-delivery  runtime outcome=stopped(exec 0)+ execution「exe-e2e-docs-delivery」
 *                           经真实 RPC task-start → doc-submit(1 个 artifact)→ task-submit
 *                           (空公共 manifest ⇒ commitSha=null + artifacts)——修后必须「已成功」。
 *   task-e2e-docs-stalled   runtime outcome=stopped(exec 0)+ execution 只 claim 不提交
 *                           ——必须保持「已停手·未交付」(负例)。
 *
 * 与 sessions-grouping 同一条夹具路:任务实体在 daemon 停机前经 repo.task.create 落投影;
 * runtime 事件在停机窗口直接 append(生产 runtime-spawner 同形);任务生命周期
 * (start/doc-submit/submit)在场景 run() 里走真实聚合写口——顺序与生产相反
 * (生产先提交后退出),读面按 executionId 连接,与事件顺序无关。
 */
export const DELIVERY_TASK = "task-e2e-docs-delivery",
  STALLED_TASK = "task-e2e-docs-stalled",
  DELIVERY_EXECUTION = "exe-e2e-docs-delivery",
  STALLED_EXECUTION = "exe-e2e-docs-stalled",
  identity = (key) => createHash("sha256").update(`gui-e2e-delivery\0${key}`).digest("hex"),
  deliveryRound = {
    dispatchId: `dispatch_${identity("delivery").slice(0, 24)}`,
    runtimeSessionId: `runtime_${identity("delivery").slice(24, 48)}`,
  },
  stalledRound = {
    dispatchId: `dispatch_${identity("stalled").slice(0, 24)}`,
    runtimeSessionId: `runtime_${identity("stalled").slice(24, 48)}`,
  };

/** 夹具任务实体:daemon 停机前经 repo.task.create 落进投影,返回 taskId → packagePath。 */
export async function seedGuiE2eDeliveryTasks(endpoint, repoId) {
  const packagePaths = {};
  for (const [taskId, title] of [
    [DELIVERY_TASK, "桌面应用签名发布方案"],
    [STALLED_TASK, "方案对照:未提交的停手轮"],
  ]) {
    const created = await requestDaemonJsonRpcAt(
      endpoint,
      "repo.task.create",
      { repo: { repoId }, payload: { taskId, title } },
      5_000,
    );
    assert.equal(created.ok, true, `task fixture ${taskId} create failed: ${JSON.stringify(created)}`);
    packagePaths[taskId] = String(created.packagePath);
  }
  return packagePaths;
}

/** 停机窗口里 append 两个 stopped 轮次(生产 runtime-spawner 同形的事件序列)。 */
export async function seedGuiE2eDeliverySessions(rootDir, repoId, writerFence) {
  const store = makeTaskEventStore({ rootDir, repoId, writerFence: () => writerFence }),
    projection = makeTaskProjection({ rootDir, eventStore: store }),
    actor = { principal: { personId: "person-gui" }, executor: null };
  const append = (type, payload, blobs = []) => {
    const revision = (store.readHead()?.revision ?? 0) + 1,
      opId = `gui-e2e-delivery-${type}-${revision}`,
      event = {
        schema: "agent-runtime-event/v1",
        eventId: `event-${createHash("sha256").update(opId).digest("hex")}`,
        workspaceRevision: revision,
        opId,
        type,
        actor,
        source: "local",
        occurredAt: new Date().toISOString(),
        payload,
      };
    store.append({ event, plan: canonicalEventWritePlan(event, "agent-runtime/v1", opId), blobs });
    projection.apply(event);
  };
  try {
    for (const [task, execution, round, startedAt] of [
      [DELIVERY_TASK, DELIVERY_EXECUTION, deliveryRound, "2026-10-17T00:14:00.000Z"],
      [STALLED_TASK, STALLED_EXECUTION, stalledRound, "2026-10-17T00:15:00.000Z"],
    ]) {
      const { dispatchId, runtimeSessionId } = round,
        instanceId = `instance-e2e-${task}`,
        installationId = `installation-e2e-${task}`;
      append("runtime_dispatch_requested", {
        dispatchId,
        runtimeSessionId,
        taskId: task,
        executionId: execution,
        agentId: "glm",
        agentName: "GLM-5.3",
        startedAt,
        instanceId,
        installationId,
        kindId: "codex",
        dispatchKey: `gui-e2e-${task}`,
        definitionSnapshotRef: `provider:definition/${task}`,
        definitionSnapshot: {
          schema: "agent-definition-snapshot/v1",
          configVersion: 1,
          instanceId,
          installationId,
          kindId: "codex",
          providerId: "openai",
          model: "gpt-e2e",
          reasoningEffort: null,
          baseUrl: null,
          authMode: "subscription",
        },
      });
      append("runtime_session_started", {
        runtimeSessionId,
        instanceId,
        installationId,
        kindId: "codex",
        definitionSnapshotRef: `provider:definition/${task}`,
        launchGeneration: 1,
        attachable: false,
      });
      append("runtime_session_task_bound", {
        runtimeSessionId,
        taskId: task,
        executionId: execution,
        providerSessionId: `provider-${task}`,
        transcriptRef: `file:transcript/${task}.log`,
      });
      append("runtime_session_exited", { runtimeSessionId });
      const body = `gui-e2e delivery fixture ${task} stopped after a normal exit\n`,
        sha256 = createHash("sha256").update(body).digest("hex"),
        result = { sha256, size: Buffer.byteLength(body), mediaType: "text/plain; charset=utf-8" };
      append(
        "runtime_session_outcome_observed",
        {
          runtimeSessionId,
          outcome: "stopped",
          exitCode: 0,
          resultRef: `artifact:runtime-result/sha256/${sha256}`,
          result,
        },
        [{ ...result, body }],
      );
    }
  } finally {
    projection.close();
    await store.drain();
  }
}

/** 场景侧:走真实聚合写口把已交付任务的生命周期补完,返回读回的 submission 形状。 */
export async function driveDeliveryTaskLifecycle(fixture) {
  const run = (action) =>
    requestDaemonJsonRpcAt(
      fixture.endpoint,
      "repo.task.run",
      { repo: { repoId: fixture.repoId }, payload: { action } },
      1_000,
      20_000,
    );
  // task-start 的 plan 就绪门拒收脚手架:两份 plan 都写真内容并先经 doc-submit 入投影。
  for (const [taskId, goal] of [
    [DELIVERY_TASK, "交付一份签名发布方案文档,作为任务包 artifact 提交。"],
    [STALLED_TASK, "对照组:只领取不提交,会话页必须保持未交付。"],
  ]) {
    writeFileSync(
      path.join(fixture.rootDir, "harness", fixture.packagePaths[taskId], "task_plan.md"),
      [
        `# ${taskId === DELIVERY_TASK ? "桌面应用签名发布方案" : "方案对照:未提交的停手轮"}`,
        "",
        "## Brief",
        "",
        "GUI e2e 夹具任务:验证会话页对 artifacts-only 提交的交付判定。",
        "",
        "## Goal",
        "",
        goal,
        "",
        "## Context",
        "",
        "夹具任务,由 sessions-delivery-status 场景驱动,无上游依赖。",
        "",
        "## Required Reading",
        "",
        "- tools/gui-e2e/scenarios/sessions-delivery-status.support.mjs",
        "",
        "## Entry Conditions",
        "",
        "隔离 daemon 已启动,仓已 attached。",
        "",
        "## Dependencies",
        "",
        "无。",
        "",
        "## Execution Surface",
        "",
        "隔离夹具仓 gui-e2e;只写任务包文档,不改生产代码。",
        "",
        "## Constraints",
        "",
        "不触碰用户 default daemon;数据只存在于抛弃型夹具。",
        "",
        "## Checkpoint",
        "",
        "无裁决点。",
        "",
        "## Implementation Plan",
        "",
        "1. doc-submit 交付物。2. task-submit 冻结 artifacts-only 提交。",
        "",
        "## Deliverable Contract",
        "",
        "任务包 artifacts 下一份方案文档,center-accepted。",
        "",
        "## Evidence Protocol",
        "",
        "场景内断言会话页状态词并落元素截图。",
        "",
        "## Verification",
        "",
        "场景断言通过即验证。",
        "",
      ].join("\n"),
    );
  }
  const planSync = await run({ kind: "doc-submit", taskId: DELIVERY_TASK });
  assert.equal(planSync.ok, true, `doc-submit(plan, delivery) failed: ${JSON.stringify(planSync)}`);
  const stalledPlanSync = await run({ kind: "doc-submit", taskId: STALLED_TASK });
  assert.equal(stalledPlanSync.ok, true, `doc-submit(plan, stalled) failed: ${JSON.stringify(stalledPlanSync)}`);
  const start = await run({ kind: "task-start", taskId: DELIVERY_TASK, executionId: DELIVERY_EXECUTION });
  assert.equal(start.ok, true, `task-start failed: ${JSON.stringify(start)}`);
  await run({ kind: "task-start", taskId: STALLED_TASK, executionId: STALLED_EXECUTION });
  // 交付物:任务包 artifacts/ 下一份方案文档,经 doc-submit 成为 center-accepted 版本。
  const artifactRel = `${fixture.packagePaths[DELIVERY_TASK]}/artifacts/desktop-signing-plan.md`,
    artifactAbs = path.join(fixture.rootDir, "harness", artifactRel);
  mkdirSync(path.dirname(artifactAbs), { recursive: true });
  writeFileSync(artifactAbs, "# 桌面应用签名发布方案\n\n交付物落在任务包 artifacts,公共 manifest 为空。\n");
  const synced = await run({ kind: "doc-submit", taskId: DELIVERY_TASK });
  assert.equal(synced.ok, true, `doc-submit failed: ${JSON.stringify(synced)}`);
  // closeout 就绪 + 空交付 commit(空 manifest ⇒ submission.commitSha=null,只剩冻结 artifacts)。
  writeFileSync(
    path.join(fixture.rootDir, "harness", fixture.packagePaths[DELIVERY_TASK], "closeout.md"),
    "# Closeout\n\n## Summary\n\nDelivered the signing plan as a task-package artifact.\n\n## Verification\n\nDoc sync accepted the artifact revision.\n\n## Residual Risk\n\nNone for the fixture.\n\n## Same Mechanism Elsewhere\n\nSessions read path and CLI dispatch reads share one delivery criterion.\n",
  );
  execFileSync("git", [
    "-C",
    fixture.rootDir,
    "-c",
    "user.name=GUI E2E Fixture",
    "-c",
    "user.email=gui-e2e-fixture@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "test: docs delivery fixture",
  ]);
  const commitSha = execFileSync("git", ["-C", fixture.rootDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
  const submitted = await run({ kind: "task-submit", taskId: DELIVERY_TASK, commitSha });
  assert.equal(submitted.ok, true, `task-submit failed: ${JSON.stringify(submitted)}`);
  const read = await requestDaemonJsonRpcAt(
    fixture.endpoint,
    "repo.tasks.list",
    { repo: { repoId: fixture.repoId }, payload: {} },
    1_000,
    5_000,
  );
  const execution = read.rows
    ?.find((row) => row.taskId === DELIVERY_TASK)
    ?.snapshot?.executions?.find((candidate) => candidate.executionId === DELIVERY_EXECUTION);
  assert.ok(execution?.submission, `delivery execution must carry a submission: ${JSON.stringify(execution)}`);
  return execution.submission;
}
