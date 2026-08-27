// harness-test-tier: contract
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SquadEntityDetail } from "../src/renderer/agent-entity-client.ts";
import {
  SquadCockpit,
  squadCockpitModel,
  type SquadCockpitRow,
} from "../src/renderer/components/runtime/SquadCockpit.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));

const squad: SquadEntityDetail = {
  id: "core-squad",
  name: "Core Squad",
  leader: "fable",
  workers: ["luna", "sol"],
  leaderTurnBudget: 8,
  roster: "# Core Squad",
  prompts: [],
};

function row(overrides: Partial<SquadCockpitRow> & { readonly runtimeSessionId: string }): SquadCockpitRow {
  return {
    agentId: null,
    agentName: null,
    delegatedByAgentId: null,
    squadId: "core-squad",
    squadName: null,
    parentRuntimeSessionId: null,
    instanceId: "codex-one",
    taskId: "task-a",
    taskTitle: "Task A",
    startedAt: "2026-08-28T00:00:00.000Z",
    endedAt: null,
    status: "running",
    liveness: null,
    dispatchId: null,
    delegation: null,
    ...overrides,
  };
}

describe("squad cockpit model", () => {
  it("binds each worker run to the Commander session that dispatched it via the parent edge", () => {
    const model = squadCockpitModel(squad, [
      row({ runtimeSessionId: "runtime-leader-1", agentId: "fable", agentName: "fable" }),
      row({
        runtimeSessionId: "runtime-worker-1",
        agentId: "luna",
        agentName: "luna",
        delegatedByAgentId: "fable",
        parentRuntimeSessionId: "runtime-leader-1",
      }),
      row({
        runtimeSessionId: "runtime-worker-2",
        agentId: "sol",
        agentName: "sol",
        delegatedByAgentId: "fable",
        parentRuntimeSessionId: "runtime-leader-1",
        status: "succeeded",
        endedAt: "2026-08-28T00:05:00.000Z",
      }),
      row({
        runtimeSessionId: "runtime-leader-2",
        agentId: "fable",
        agentName: "fable",
        startedAt: "2026-08-28T00:30:00.000Z",
      }),
    ]);
    // 两次 Commander 运行各自成 lane;下级按 parentRuntimeSessionId 归属,不按时间邻近猜。
    expect(model.commanderRuns.map((run) => run.row.runtimeSessionId)).toEqual([
      "runtime-leader-2",
      "runtime-leader-1",
    ]);
    expect(model.commanderRuns[1]?.children.map((child) => child.runtimeSessionId)).toEqual([
      "runtime-worker-1",
      "runtime-worker-2",
    ]);
    expect(model.commanderRuns[0]?.children).toEqual([]);
    expect(model.unboundWorkers).toEqual([]);
  });

  it("keeps worker runs without a parent edge visible as squad members, not dropped", () => {
    const model = squadCockpitModel(squad, [
      row({
        runtimeSessionId: "runtime-legacy-1",
        agentId: "terra",
        agentName: "terra",
        delegatedByAgentId: "fable",
      }),
    ]);
    expect(model.commanderRuns).toEqual([]);
    expect(model.unboundWorkers.map((worker) => worker.runtimeSessionId)).toEqual(["runtime-legacy-1"]);
  });

  it("ignores rows from another squad", () => {
    const model = squadCockpitModel(squad, [
      row({ runtimeSessionId: "runtime-other", agentId: "fable", squadId: "other-squad" }),
    ]);
    expect(model.commanderRuns).toEqual([]);
    expect(model.unboundWorkers).toEqual([]);
  });
});

describe("squad cockpit page", () => {
  const cockpit = (rows: readonly SquadCockpitRow[]) =>
    renderToStaticMarkup(
      createElement(SquadCockpit, {
        squad,
        rows,
        busy: false,
        onLaunch: () => undefined,
        onOpenSession: () => undefined,
      }),
    );

  it("renders the commander-only state: one launch action, an empty worker region, no fake streams", () => {
    const markup = cockpit([]);
    expect(markup).toContain("squad-cockpit");
    expect(markup).toContain("Launch Commander…");
    expect(markup).toContain("No Commander run yet");
    expect(markup).not.toContain("squad-lane-");
  });

  it("renders commander and worker streams on one page with their organization readable", () => {
    const markup = cockpit([
      row({ runtimeSessionId: "runtime-leader-1", agentId: "fable", agentName: "fable" }),
      row({
        runtimeSessionId: "runtime-worker-1",
        agentId: "luna",
        agentName: "luna",
        delegatedByAgentId: "fable",
        parentRuntimeSessionId: "runtime-leader-1",
      }),
      row({
        runtimeSessionId: "runtime-worker-2",
        agentId: "sol",
        agentName: "sol",
        delegatedByAgentId: "fable",
        parentRuntimeSessionId: "runtime-leader-1",
        status: "failed",
        endedAt: "2026-08-28T00:05:00.000Z",
      }),
    ]);
    // 三条流同屏:Commander lane 与两条 worker lane 都在 DOM 里,组织关系可读。
    expect(markup).toContain('data-testid="squad-lane-runtime-leader-1"');
    expect(markup).toContain('data-testid="squad-lane-runtime-worker-1"');
    expect(markup).toContain('data-testid="squad-lane-runtime-worker-2"');
    expect(markup).toContain("fable → luna");
    expect(markup).toContain("fable → sol");
    expect(markup).toContain("Commander");
  });

  it("keeps ended worker runs on the page in their terminal state instead of hiding them", () => {
    const markup = cockpit([
      row({ runtimeSessionId: "runtime-leader-1", agentId: "fable", agentName: "fable" }),
      row({
        runtimeSessionId: "runtime-worker-done",
        agentId: "sol",
        agentName: "sol",
        delegatedByAgentId: "fable",
        parentRuntimeSessionId: "runtime-leader-1",
        status: "succeeded",
        endedAt: "2026-08-28T00:05:00.000Z",
      }),
    ]);
    expect(markup).toContain('data-testid="squad-lane-runtime-worker-done"');
    expect(markup).toContain("succeeded");
  });

  it("shows unattributed worker runs under their own region rather than misbinding them", () => {
    const markup = cockpit([
      row({
        runtimeSessionId: "runtime-legacy",
        agentId: "terra",
        agentName: "terra",
        delegatedByAgentId: "fable",
      }),
    ]);
    expect(markup).toContain("Worker runs without a parent-session edge");
    expect(markup).toContain('data-testid="squad-lane-runtime-legacy"');
    expect(markup).toContain("fable → terra");
  });
});
