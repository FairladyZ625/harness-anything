import assert from "node:assert/strict";
import { appendRuntimeWorkerRecord, openDispatchStream } from "../../../packages/daemon/src/dispatch-stream.ts";
import { guiE2eDispatchId, guiE2eRuntimeSessionId } from "./sessions-grouping.mjs";
import { nav } from "./helpers.mjs";

const dispatchId = guiE2eDispatchId("lanes-live"),
  runtimeSessionId = guiE2eRuntimeSessionId("lanes-live"),
  taskId = "task-e2e-lanes",
  taskTitle = "并行 Agent 泳道时间线",
  activityObservedAt = () => new Date(Date.now() - 15 * 60_000).toISOString();

export default {
  id: "live-floor-activity",
  feature: "live-floor",
  lane: "isolated",
  description:
    "A live-floor dispatch with stale provider activity shows its idle minutes in the red status tag, and its row carries the bound task's title instead of the unattributed placeholder.",
  async run({ page, fixture, shot }) {
    const observedAt = activityObservedAt();
    openDispatchStream(fixture.rootDir, {
      dispatchId,
      taskId,
      executionId: "exe-lanes-live",
      runtimeSessionId,
      instanceId: "instance-e2e-lanes",
      kindId: "codex",
      startedAt: observedAt,
    });
    appendRuntimeWorkerRecord(fixture.rootDir, dispatchId, {
      kind: "provider_event",
      occurredAt: observedAt,
      event: { type: "item.updated", item: { type: "command_execution", status: "in_progress" } },
    });

    await nav(page, /^(?:现场|Live floor)$/u, "live-floor-page");
    const row = page.getByTestId("live-floor-session-row").filter({ hasText: taskTitle });
    await row.waitFor();
    // 绑定任务的会话行必须显示任务标题;「未归属」和原始 id 都说明标题丢了来源(CEO 现场截图)。
    const title = (await row.locator("button, span").first().innerText()).trim();
    assert.equal(title, taskTitle, `the bound row must be labelled with its task title, got ${title}`);
    assert.doesNotMatch(title, /未归属|Unattributed|^task_/u, `the row must not fall back to ${title}`);
    const tag = row.locator('[data-status-tone="bad"]');
    await tag.waitFor();
    const label = (await tag.innerText()).trim(),
      minutes = Number(/(?:静默|Silent for)\s*(\d+)/u.exec(label)?.[1]);
    assert.ok(minutes >= 10, `the activity age must cross the silence threshold: ${label}`);
    await tag.scrollIntoViewIfNeeded();
    await shot("live-floor-silent-activity");
  },
};
