// harness-test-tier: contract
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildDispatchSpawnInput, compatibleDispatchInstances, dispatchChainFromDocuments, dispatchOutcomeView, type DispatchRequest, type DispatchSubject } from "../src/renderer/dispatch-flow.ts";
import { DispatchDialog } from "../src/renderer/components/DispatchDialog.tsx";
import { EntityLayersRows } from "../src/renderer/components/EntityLayersPanel.tsx";
import { AgentRuntimeProjection } from "../src/renderer/views/agent-runtime-view.tsx";
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
  it("lets an any Agent filter and dispatch through every supported enabled runtime kind", () => { for (const instance of [codexInstance, claudeInstance, agyInstance]) { expect(compatibleDispatchInstances("any", [instance]).map((row) => row.instanceId)).toEqual([instance.instanceId]); expect(buildDispatchSpawnInput({ ...baseRequest, subject: anyAgentSubject, runtimeInstanceId: instance.instanceId }, [instance])).toMatchObject({ agentId: "any-worker", runtimeInstanceId: instance.instanceId }); } expect(compatibleDispatchInstances("any", [{ ...codexInstance, enabled: false }])).toEqual([]); });
  it("keeps unknown open runtime identifiers fail-closed", () => { expect(compatibleDispatchInstances("opencode-worker", [codexInstance, claudeInstance, agyInstance])).toEqual([]); expect(() => buildDispatchSpawnInput({ ...baseRequest, subject: openCodeAgentSubject }, [codexInstance])).toThrow("dispatch_runtime_type_mismatch"); });
  it("rejects a runtime instance whose kindId does not match the selected executor runtime_type", () => {
    expect(() => buildDispatchSpawnInput({ ...baseRequest, subject: agentSubject }, [claudeInstance])).toThrow("dispatch_runtime_type_mismatch");
  });
  it("consumes the daemon's four terminal outcomes one-to-one instead of re-deriving them", () => {
    expect(dispatchOutcomeView(null)).toBe("running");
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
    for (const text of ["Dispatch — Agent × Runtime × Task → Session", "terra", "codex", "task-dispatch", "prompt://review", "artifacts/missions/&lt;dispatchId&gt;.md", "artifacts/dispatches/&lt;dispatchId&gt;.json", "artifacts/reports/&lt;dispatchId&gt;.md", "Dispatch"]) expect(markup).toContain(text);
    expect(markup).toContain("disabled");
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
  it("exposes the dispatch entry on agent and squad rows but not on blocked declarations", () => {
    const markup = renderToStaticMarkup(createElement(EntityLayersRows, { agents: [{ id: "terra", name: "terra", runtimeType: "codex", role: "worker", layer: "user", validity: "valid", issues: [] }, { id: "broken", name: "broken", runtimeType: "codex", role: "worker", layer: "user", validity: "blocked", issues: [] }], squads: [{ id: "core-squad", name: "Core Squad", leader: "fable", workers: ["luna"], layer: "user", validity: "valid", issues: [] }], onDispatchAgent: () => undefined, onDispatchSquad: () => undefined }));
    expect(markup).toContain('data-testid="dispatch-entry-terra"');
    expect(markup).toContain('data-testid="squad-dispatch-entry-core-squad"');
    expect(markup).not.toContain('data-testid="dispatch-entry-broken"');
  });
  it("renders the four terminal outcome states as distinct session badges", () => {
    const sessions = (["succeeded", "failed", "unknown", "cancelled", null] as const).map((outcome, index) => ({ ...sessionBase, runtimeSessionId: `runtime-${index}`, liveness: outcome === null ? "live" : "exited", activity: { ...sessionBase.activity, outcome } }));
    const markup = renderToStaticMarkup(createElement(AgentRuntimeProjection, { overview: { ok: true, status: "ready", installations: [], instances: [], sessions, watermark: 4, sourceRevision: 4 }, selectedId: "runtime-0", detail: sessions[0]!, resultText: "Provider final report text.", frames: [], attachStatus: "attached", onSelect: () => undefined, onClose: () => undefined }));
    for (const text of ["succeeded", "failed", "unknown", "cancelled", "running", "Provider final report text."]) expect(markup).toContain(text);
  });
  it("shows the cancel control only while a session is live", () => {
    const live = { ...sessionBase, liveness: "live" } as never;
    const withLive = renderToStaticMarkup(createElement(AgentRuntimeProjection, { overview: { ok: true, status: "ready", installations: [], instances: [], sessions: [live], watermark: 4, sourceRevision: 4 }, selectedId: "runtime-dispatch", detail: live, frames: [], attachStatus: "attached", onCancel: () => undefined, onSelect: () => undefined, onClose: () => undefined }));
    expect(withLive).toContain('data-testid="agent-runtime-cancel"');
    const exited = renderToStaticMarkup(createElement(AgentRuntimeProjection, { overview: { ok: true, status: "ready", installations: [], instances: [], sessions: [sessionBase], watermark: 4, sourceRevision: 4 }, selectedId: "runtime-dispatch", detail: sessionBase, frames: [], attachStatus: "attached", onCancel: () => undefined, onSelect: () => undefined, onClose: () => undefined }));
    expect(exited).not.toContain('data-testid="agent-runtime-cancel"');
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
