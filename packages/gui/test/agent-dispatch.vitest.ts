// harness-test-tier: contract
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDispatchSpawnInput, compatibleDispatchInstances, compatibleDispatchModels, dispatchChainFromDocuments, dispatchOutcomeView, type DispatchRequest, type DispatchSubject } from "../src/renderer/dispatch-flow.ts";
import { DispatchDialog } from "../src/renderer/components/DispatchDialog.tsx";
import { AgentCard } from "../src/renderer/components/runtime/AgentCard.tsx";
import { RuntimeRail } from "../src/renderer/components/runtime/RuntimeRail.tsx";
import { runtimeDockRows } from "../src/renderer/runtime-panorama.ts";
import { runtimeCommandClient } from "../src/renderer/runtime-command-client.ts";
import { submitRuntimeSpawn } from "../src/renderer/runtime-control.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

beforeAll(() => setActiveLocale("en-US"));

const codexInstance = { schemaVersion: 2, instanceId: "w4c-verify-codex", name: "Codex Verify", kindId: "codex", installationId: "codex-install", providerId: "openai", models: ["gpt-5.6-terra"], defaultModel: "gpt-5.6-terra", enabled: true, permissionMode: "bypass", codex: { reasoningEffort: "high", baseUrl: null, baseUrlConfigured: false, wire_api: null, requires_openai_auth: null, http_headers: null }, authMode: "subscription", authState: "authenticated", authReadiness: { status: "ready", code: null, hint: null }, isolationState: "enforced" } as const;
const claudeInstance = { ...codexInstance, instanceId: "claude-one", name: "Claude One", kindId: "claude", claude: { baseUrl: null, baseUrlConfigured: false } } as never;
const agyInstance = { ...codexInstance, instanceId: "agy-one", name: "Agy One", kindId: "agy", agy: { effort: "high" } } as never;
const agentSubject: DispatchSubject = { kind: "agent", agent: { agentId: "terra", agentName: "terra", runtimeType: "codex" } };
const anyAgentSubject: DispatchSubject = { kind: "agent", agent: { agentId: "any-worker", agentName: "any-worker", runtimeType: "any" } };
const openCodeAgentSubject: DispatchSubject = { kind: "agent", agent: { agentId: "opencode-worker", agentName: "opencode-worker", runtimeType: "opencode-worker" } };
const squadSubject: DispatchSubject = { kind: "squad", squadId: "core-squad", squadName: "Core Squad", leader: { agentId: "fable", agentName: "fable", runtimeType: "claude" }, workers: [{ agentId: "luna", agentName: "luna", runtimeType: "claude" }, { agentId: "sol", agentName: "sol", runtimeType: "codex" }, { agentId: "terra", agentName: "terra", runtimeType: "codex" }] };
const baseRequest = { runtimeInstanceId: "w4c-verify-codex", mission: "Verify the auth cleanup diff.", cwd: { scope: "repo-root" } as const, taskId: "task-dispatch", idempotencyKey: "gui-dispatch-1" };
const definition = { schema: "agent-definition-snapshot/v1", configVersion: 1, instanceId: "w4c-verify-codex", installationId: "codex-install", kindId: "codex", providerId: "openai", model: "gpt-5.6-terra", reasoningEffort: null, baseUrl: null, authMode: "subscription" } as const;
const sessionBase = { runtimeSessionId: "runtime-dispatch", providerSessionId: null, instanceId: "w4c-verify-codex", installationId: "codex-install", kindId: "codex", definitionSnapshotRef: "artifact:runtime-definition/test", definitionSnapshot: definition, liveness: "exited", attachCapability: "supported", streamCursor: "stream:4", associations: [], activity: { lastObservedAt: "2026-08-20T00:00:00.000Z", outcome: null, exitCode: 0, resultRef: null } } as const;

describe("agent dispatch flow", () => {
  it("dispatches to the selected agent, not to whichever agent happens to be first", () => {
    const input = buildDispatchSpawnInput({ ...baseRequest, subject: agentSubject }, [codexInstance, claudeInstance]);
    expect(input.agentId).toBe("terra");
    expect("targetAgentId" in input).toBe(false);
    expect(input).toMatchObject({ runtimeInstanceId: "w4c-verify-codex", prompt: "Verify the auth cleanup diff.", taskId: "task-dispatch", cwd: { scope: "repo-root" }, idempotencyKey: "gui-dispatch-1" });
  });
  it("leaves automatic instance selection to the daemon", () => {
    const input = buildDispatchSpawnInput({ ...baseRequest, subject: agentSubject, runtimeInstanceId: undefined }, [codexInstance, claudeInstance]);
    expect({ agentId: input.agentId, hasRuntimeInstanceId: "runtimeInstanceId" in input }).toEqual({ agentId: "terra", hasRuntimeInstanceId: false });
  });
  it("routes squad dispatch through the leader to the chosen worker", () => {
    const input = buildDispatchSpawnInput({ ...baseRequest, subject: squadSubject, workerId: "sol" }, [codexInstance, claudeInstance]);
    expect(input.agentId).toBe("fable");
    expect(input.targetAgentId).toBe("sol");
    const other = buildDispatchSpawnInput({ ...baseRequest, subject: squadSubject, workerId: "terra" }, [codexInstance, claudeInstance]);
    expect(other.targetAgentId).toBe("terra");
  });
  it("keeps task binding nullable and passes model and effort only when chosen", () => {
    const unbound = buildDispatchSpawnInput({ ...baseRequest, subject: agentSubject, taskId: null }, [codexInstance, claudeInstance]);
    expect(unbound.taskId).toBeNull();
    const tuned = buildDispatchSpawnInput({ ...baseRequest, subject: agentSubject, model: "gpt-5.6-terra", effort: "xhigh", cwd: { scope: "repo-relative", path: "packages/gui" } }, [codexInstance, claudeInstance]);
    expect(tuned).toMatchObject({ model: "gpt-5.6-terra", effort: "xhigh", cwd: { scope: "repo-relative", path: "packages/gui" } });
  });
  it("offers only enabled instances of the executor's runtime type", () => {
    expect(compatibleDispatchInstances("codex", [codexInstance, claudeInstance]).map((instance) => instance.instanceId)).toEqual(["w4c-verify-codex"]);
    expect(compatibleDispatchInstances("claude", [codexInstance, claudeInstance]).map((instance) => instance.instanceId)).toEqual(["claude-one"]);
    expect(compatibleDispatchInstances("agy", [codexInstance, claudeInstance])).toEqual([]);
  });
  it("offers the model union of every compatible automatic-routing candidate", () => {
    const second = { ...codexInstance, instanceId: "codex-second", models: ["gpt-5.6-luna"], defaultModel: "gpt-5.6-luna" } as const;
    expect(compatibleDispatchModels([codexInstance, second])).toEqual(["gpt-5.6-luna", "gpt-5.6-terra"]);
  });
  it("lets an any Agent filter and dispatch through every supported enabled runtime kind", () => { for (const instance of [codexInstance, claudeInstance, agyInstance]) { expect(compatibleDispatchInstances("any", [instance]).map((row) => row.instanceId)).toEqual([instance.instanceId]); expect(buildDispatchSpawnInput({ ...baseRequest, subject: anyAgentSubject, runtimeInstanceId: instance.instanceId }, [instance])).toMatchObject({ agentId: "any-worker", runtimeInstanceId: instance.instanceId }); } expect(compatibleDispatchInstances("any", [{ ...codexInstance, enabled: false }])).toEqual([]); });
  it("keeps unknown open runtime identifiers fail-closed", () => { expect(compatibleDispatchInstances("opencode-worker", [codexInstance, claudeInstance, agyInstance])).toEqual([]); expect(() => buildDispatchSpawnInput({ ...baseRequest, subject: openCodeAgentSubject }, [codexInstance])).toThrow("dispatch_runtime_type_mismatch"); });
  it("rejects a runtime instance whose kindId does not match the selected executor runtime_type", () => {
    expect(() => buildDispatchSpawnInput({ ...baseRequest, subject: agentSubject }, [claudeInstance])).toThrow("dispatch_runtime_type_mismatch");
  });
  it("consumes the daemon's four terminal outcomes one-to-one instead of re-deriving them", () => {
    expect(dispatchOutcomeView(null)).toBe("unknown");
    expect(dispatchOutcomeView("succeeded")).toBe("succeeded");
    expect(dispatchOutcomeView("failed")).toBe("failed");
    expect(dispatchOutcomeView("unknown")).toBe("unknown");
    expect(dispatchOutcomeView("cancelled")).toBe("cancelled");
  });
  it("chains missions, dispatch records, reports, and the ledger by dispatch id", () => {
    const documents = [
      { path: "tasks/task-dispatch-verify/artifacts/missions/dispatch_aaa.md", blobSha256: "a".repeat(64), size: 10, mediaType: "text/markdown" },
      { path: "tasks/task-dispatch-verify/artifacts/dispatches/dispatch_aaa.json", blobSha256: "b".repeat(64), size: 10, mediaType: "text/plain" },
      { path: "tasks/task-dispatch-verify/artifacts/reports/dispatch_aaa.md", blobSha256: "c".repeat(64), size: 10, mediaType: "text/markdown" },
      { path: "tasks/task-dispatch-verify/artifacts/missions/dispatch_bbb.md", blobSha256: "d".repeat(64), size: 10, mediaType: "text/markdown" },
      { path: "notes.md", blobSha256: "e".repeat(64), size: 10, mediaType: "text/markdown" }
    ];
    const ledger = [{ dispatchId: "dispatch_bbb", taskId: "task-dispatch", executionId: "execution-1", runtimeSessionId: "runtime-1", instanceId: "w4c-verify-codex", providerSessionId: null, eventStreamRef: null, startedAt: "2026-08-20T00:00:00.000Z", endedAt: null, outcome: null, status: "running" }];
    const chain = dispatchChainFromDocuments(documents, ledger);
    expect(chain.map((row) => row.dispatchId)).toEqual(["dispatch_bbb", "dispatch_aaa"]);
    const settled = chain.find((row) => row.dispatchId === "dispatch_aaa")!;
    expect(settled.mission?.path.endsWith("artifacts/missions/dispatch_aaa.md")).toBe(true);
    expect(settled.dispatchRecord?.path.endsWith("artifacts/dispatches/dispatch_aaa.json")).toBe(true);
    expect(settled.report?.path.endsWith("artifacts/reports/dispatch_aaa.md")).toBe(true);
    const running = chain.find((row) => row.dispatchId === "dispatch_bbb")!;
    expect(running.report).toBeNull();
    expect(running.ledger?.status).toBe("running");
  });
  it("renders the prototype dispatch modal: who, task, mission, runtime, and what it produces", () => {
    const markup = renderToStaticMarkup(createElement(DispatchDialog, { subject: agentSubject, instances: [codexInstance, claudeInstance], tasks: [{ taskId: "task-dispatch", title: "Dispatch task", heldLease: true }], prompts: ["prompt://review"], busy: false, notice: null, onCancel: () => undefined, onSubmit: () => undefined }));
    for (const text of ["Dispatch — Agent × Runtime × Task → Session", "Who", "Which task", "What to say", "Where it runs", "terra", "codex", "task-dispatch", "artifacts/missions/&lt;dispatchId&gt;.md", "artifacts/dispatches/&lt;dispatchId&gt;.json", "artifacts/reports/&lt;dispatchId&gt;.md", "Dispatch"]) expect(markup).toContain(text);
    expect(markup).toContain("disabled");
  });
  it("opens on the mission step and offers the agent's predefined prompts when entered from one", () => {
    const markup = renderToStaticMarkup(createElement(DispatchDialog, { subject: agentSubject, instances: [codexInstance], tasks: [{ taskId: "task-dispatch", title: "Dispatch task", heldLease: false }], prompts: ["prompt://review"], initialMission: "prompt://review", busy: false, notice: null, onCancel: () => undefined, onSubmit: () => undefined }));
    expect(markup).toContain("prompt://review");
    expect(markup).toContain('data-testid="dispatch-mission"');
  });
  it("renders the squad dialog with leader-to-worker routing and a worker selector", () => {
    const markup = renderToStaticMarkup(createElement(DispatchDialog, { subject: squadSubject, instances: [codexInstance, claudeInstance], tasks: [{ taskId: "task-dispatch", title: "Dispatch task", heldLease: false }], prompts: [], busy: false, notice: null, onCancel: () => undefined, onSubmit: () => undefined }));
    for (const text of ["Core Squad", "dispatch-worker", "luna", "sol", "terra", "lease free"]) expect(markup).toContain(text);
  });
  it("submits the authored request through the dialog contract", () => {
    const submitted: DispatchRequest[] = [];
    const markup = renderToStaticMarkup(createElement(DispatchDialog, { subject: agentSubject, instances: [codexInstance], tasks: [{ taskId: "task-dispatch", title: "Dispatch task", heldLease: true }], prompts: [], busy: false, notice: null, onCancel: () => undefined, onSubmit: (request) => { submitted.push(request); } }));
    expect(markup).toContain('data-testid="dispatch-submit"');
    expect(submitted).toEqual([]);
  });
  it("exposes the dispatch entry on a valid agent card but not on a blocked declaration", () => {
    const card = (validity: "valid" | "blocked") => renderToStaticMarkup(createElement(AgentCard, { detail: { id: "terra", name: "terra", runtimeType: "codex", role: "worker", instructions: "Work the mission.", model: null, skills: [], prompts: [], preset: null }, row: { id: "terra", name: "terra", runtimeType: "codex", role: "worker", layer: "user", validity, issues: [] }, squads: [], instances: [codexInstance], busy: false, onSave: () => undefined, onDispatch: () => undefined, onSelectSquad: () => undefined, onSelectRuntime: () => undefined }));
    expect(card("valid")).toContain('data-testid="dispatch-entry-terra"');
    expect(card("blocked")).not.toContain('data-testid="dispatch-entry-terra"');
    expect(card("blocked")).toContain("declaration is blocked");
  });
  it("renders the five terminal dispatch states as distinct session rows in the rail", () => {
    const base = { dispatchId: "d", taskId: "task-dispatch", executionId: "e", runtimeSessionId: "r", instanceId: "w4c-verify-codex", agentId: "terra", agentName: "terra", providerSessionId: null, eventStreamRef: null, startedAt: "2026-08-20T02:00:00.000Z", endedAt: null, outcome: null, status: "running", taskTitle: "Dispatch task", squad: null } as const;
    const rows = runtimeDockRows((["running", "succeeded", "failed", "unknown", "cancelled"] as const).map((status, index) => ({ ...base, dispatchId: `d-${index}`, runtimeSessionId: `runtime-${index}`, status, outcome: status === "running" ? null : status })), []);
    const markup = renderToStaticMarkup(createElement(RuntimeRail, { instances: [], agents: [], squads: [], orchestration: [], sessions: rows, selection: null, open: { runtimes: true, agents: true, squads: true, orchestration: true, sessions: true }, liveByInstance: new Map(), onToggle: () => undefined, onSelect: () => undefined, onNew: () => undefined } as never));
    for (const status of ["running", "succeeded", "failed", "unknown", "cancelled"]) expect(markup).toContain(`>${status}<`);
    for (let index = 0; index < 5; index += 1) expect(markup).toContain(`data-testid="runtime-outcome-runtime-${index}"`);
  });
  it("cancels through the daemon GUI channel method with the exact session id", async () => {
    const cancelAgentRuntime = vi.fn(async () => ({ schema: "command-receipt/v2", ok: true, command: "runtime-cancel", outcome: "applied", opId: "runtime-cancel-1" }));
    vi.stubGlobal("window", { harness: { cancelAgentRuntime } });
    await runtimeCommandClient.cancel("repo-a", "runtime-dispatch");
    expect(cancelAgentRuntime).toHaveBeenCalledWith({ repoId: "repo-a", runtimeSessionId: "runtime-dispatch" });
  });
  it("settles a dispatch with its dispatch id alongside the runtime session", async () => {
    const spawn = vi.fn(async () => ({ schema: "command-receipt/v2", ok: true, command: "runtime-spawn", outcome: "applied", opId: "runtime-op-2", runtimeSessionId: "runtime-2", dispatchId: "dispatch-2", revision: 7, evidence: "event-object:runtime-op-2", visibility: "center", proof: { committedRevision: 7, appliedCut: 7, durable: true, canonicalVisible: true, worktreeVisible: null }, nextAction: null })), showReceipt = vi.fn(), overview = vi.fn(async () => ({ ok: true, status: "ready", installations: [], instances: [], sessions: [{ ...sessionBase, runtimeSessionId: "runtime-2" }], watermark: 7, sourceRevision: 7 }));
    const settlement = await submitRuntimeSpawn(buildDispatchSpawnInput({ ...baseRequest, subject: agentSubject }, [codexInstance, claudeInstance]), { spawn, showReceipt, overview });
    expect(settlement.state).toBe("applied");
    expect(settlement.runtimeSessionId).toBe("runtime-2");
    expect(settlement.dispatchId).toBe("dispatch-2");
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ agentId: "terra", taskId: "task-dispatch" }));
  });
});
