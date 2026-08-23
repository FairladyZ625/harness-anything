// harness-test-tier: integration
import { beforeAll, describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RuntimeInspector } from "../src/renderer/components/runtime/RuntimeInspector.tsx";
import { RuntimeRail } from "../src/renderer/components/runtime/RuntimeRail.tsx";
import { SessionDetailView } from "../src/renderer/components/runtime/SessionsPanel.tsx";
import { sessionSiblingRows, sessionTaskTarget, type RuntimeDockRow } from "../src/renderer/runtime-panorama.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));

const noop = () => undefined;
const definition = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "w4c-verify-codex", installationId: "codex-install", kindId: "codex", providerId: "openai", model: "gpt-5.6-terra", reasoningEffort: null, baseUrl: null, authMode: "subscription" } as const;
const sessionDto = { runtimeSessionId: "runtime-bound", providerSessionId: "provider-1", instanceId: "w4c-verify-codex", installationId: "codex-install", kindId: "codex", definitionSnapshotRef: "artifact:runtime-definition/test", definitionSnapshot: definition, liveness: "live", attachCapability: "supported", streamCursor: "stream:4", associations: [{ taskId: "task-assoc", executionId: "execution-1", holder: { personId: "person-owner", executorId: null }, lease: { phase: "held", expiresAt: "2026-08-23T01:00:00.000Z" } }], activity: { lastObservedAt: "2026-08-23T00:00:00.000Z", outcome: null, exitCode: null, resultRef: null } } as const;
const boundRow: RuntimeDockRow = { runtimeSessionId: "runtime-bound", agentId: "terra", agentName: "terra", squadId: "core-squad", squadName: "Core Squad", instanceId: "w4c-verify-codex", taskId: "task-bound", taskTitle: "Bound task title", startedAt: "2026-08-23T02:00:00.000Z", status: "running", liveness: "live", dispatchId: "dispatch-bound", delegation: null };
const siblingRow: RuntimeDockRow = { ...boundRow, runtimeSessionId: "runtime-sibling", agentId: "terra", agentName: "terra", dispatchId: "dispatch-sibling", status: "succeeded" };
const squadMateRow: RuntimeDockRow = { ...boundRow, runtimeSessionId: "runtime-squad-mate", agentId: "sol", agentName: "sol", dispatchId: "dispatch-mate", status: "succeeded" };
const strangerRow: RuntimeDockRow = { ...boundRow, runtimeSessionId: "runtime-stranger", agentId: "luna", agentName: "luna", squadId: "edge-squad", squadName: "Edge Squad", dispatchId: "dispatch-stranger", status: "failed" };
const frame = { cursor: "stream:7", runtimeSessionId: "runtime-bound", type: "activity", activity: "crunching the diff", occurredAt: "2026-08-23T00:01:00.000Z" } as const;

const detailView = (overrides: Partial<Parameters<typeof SessionDetailView>[0]> = {}) => renderToStaticMarkup(createElement(SessionDetailView, { session: sessionDto, row: boundRow, result: null, frames: [], attach: "attached", busy: false, onCancel: noop, onOpenTask: noop, ...overrides } as never));
const railView = (rows: readonly RuntimeDockRow[], selection: Parameters<typeof RuntimeRail>[0]["selection"]) => renderToStaticMarkup(createElement(RuntimeRail, { instances: [], agents: [], squads: [], sessions: rows, selection, open: { runtimes: true, agents: true, squads: true, sessions: true }, liveByInstance: new Map(), onToggle: noop, onSelect: noop, onNew: noop } as never));

describe("sessions as a first-class view", () => {
  it("lists sessions as a rail segment whose rows select a session exactly like every other segment", () => {
    const markup = railView([boundRow, strangerRow], { type: "session", id: "runtime-bound" });
    expect(markup).toMatch(/data-testid="rail-session-runtime-bound"[^>]*aria-current="true"/u);
    expect(markup).toMatch(/data-testid="rail-session-runtime-stranger"[^>]*aria-current="false"/u);
    expect(markup).toContain('data-testid="runtime-outcome-runtime-bound"');
    // The sessions rows sit inside the rail itself, not in any bottom drawer.
    expect(markup).not.toContain("sessions-dock");
  });

  it("shows whose session it is, which task holds it, and what is happening while it runs", () => {
    const markup = detailView({ result: "Provider final report.", frames: [frame] });
    expect(markup).toContain(">terra</b>");
    expect(markup).toContain('data-testid="session-owner-squad"');
    expect(markup).toContain("Core Squad");
    expect(markup).toContain("Provider final report.");
    expect(markup).toContain("crunching the diff");
    expect(markup).toContain(">live</span>");
  });

  it("jumps from a session to exactly the task it is bound to, and offers no jump when unbound", () => {
    expect(sessionTaskTarget(boundRow, sessionDto.associations)).toEqual({ taskId: "task-bound", taskTitle: "Bound task title" });
    expect(sessionTaskTarget(null, sessionDto.associations)).toEqual({ taskId: "task-assoc", taskTitle: null });
    expect(sessionTaskTarget(null, [])).toBeNull();
    const bound = detailView();
    expect(bound).toMatch(/data-testid="session-open-task"[^>]*data-task="task-bound"/u);
    expect(bound).toContain("Bound task title");
    const unbound = detailView({ row: { ...boundRow, taskId: null, taskTitle: null, dispatchId: null }, session: { ...sessionDto, associations: [] } });
    expect(unbound).not.toContain('data-testid="session-open-task"');
    expect(unbound).toContain("This session is not bound to a task.");
  });

  it("keeps the rail's session rows the only task-composition surface (W5:编排段撤销)", () => {
    // W5:每个 dispatch 的 runtime session 不再有独立「编排」视图;session 行本身
    // (含绑定 task 标题)是运行侧唯一入口,反向腿落在 rail 内。
    const markup = railView([boundRow], null);
    expect(markup).toContain('data-testid="rail-session-runtime-bound"');
    expect(markup).toContain("Bound task title");
    expect(markup).not.toContain("Orchestration");
  });

  it("mirrors the selected session in the inspector with the same task jump", () => {
    const markup = renderToStaticMarkup(createElement(RuntimeInspector, { selection: { type: "session", id: "runtime-bound" }, instances: [], agents: [], squads: [], rows: [boundRow, siblingRow, squadMateRow, strangerRow], onSelect: noop, onSelectSession: noop, onOpenTask: noop }));
    expect(markup).toMatch(/data-testid="inspector-open-task"[^>]*data-task="task-bound"/u);
    expect(markup).toContain('aria-label="Session inspector"');
    expect(sessionSiblingRows([boundRow, siblingRow, squadMateRow, strangerRow], "runtime-bound").map((row) => row.runtimeSessionId)).toEqual(["runtime-sibling", "runtime-squad-mate"]);
    expect(sessionSiblingRows([boundRow, strangerRow], "runtime-stranger").map((row) => row.runtimeSessionId)).toEqual([]);
  });
});
