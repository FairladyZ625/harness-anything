// harness-test-tier: integration
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { successfulAgentRuntimeResult } from "../../daemon/src/agent-runtime-contract.ts";
import { AgentCard, agentDeclarationFrom, agentDraftFrom } from "../src/renderer/components/runtime/AgentCard.tsx";
import { NewRuntimeDialog } from "../src/renderer/components/runtime/NewRuntimeDialog.tsx";
import { TextInput } from "../src/renderer/components/runtime/parts.tsx";
import { RuntimeCard } from "../src/renderer/components/runtime/RuntimeCard.tsx";
import { IdentityInspector } from "../src/renderer/components/runtime/RuntimeInspector.tsx";
import { IdentityRail, ProviderRail } from "../src/renderer/components/runtime/RuntimeRail.tsx";
import { SessionDetailView } from "../src/renderer/components/runtime/SessionsPanel.tsx";
import { SquadCard } from "../src/renderer/components/runtime/SquadCard.tsx";
import { visibleRuntimeInstances } from "../src/renderer/runtime-instance-form.ts";
import { assertPreloadPayload } from "../src/preload/allowlist.ts";
import { agentRuntimeClient } from "../src/renderer/agent-runtime-client.ts";
import { squadRunsClient } from "../src/renderer/squad-run-client.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import { submitRuntimeSpawn } from "../src/renderer/runtime-control.ts";
import { runtimeSelfTestSpawnInput } from "../src/renderer/components/runtime/useRuntimeWorkspace.ts";
import { runtimeAuthPresentation } from "../src/renderer/runtime-auth-presentation.ts";

beforeAll(() => setActiveLocale("en-US"));

const definition = {
  schema: "agent-definition-snapshot/v1",
  configVersion: 1,
  instanceId: "codex-review",
  installationId: "installation-codex",
  kindId: "codex",
  providerId: "openai",
  model: "gpt-5.6-sol",
  reasoningEffort: "high",
  baseUrl: "https://api.example.test/",
  authMode: "api-key",
} as const;
const session = {
  runtimeSessionId: "runtime-session",
  providerSessionId: "provider-session",
  instanceId: definition.instanceId,
  installationId: definition.installationId,
  kindId: "codex",
  definitionSnapshotRef: "artifact:runtime-definition/test",
  definitionSnapshot: definition,
  liveness: "unknown",
  attachCapability: "supported",
  streamCursor: "stream:4",
  associations: [
    {
      taskId: "task-runtime",
      executionId: "execution-runtime",
      holder: { personId: "person-owner", executorId: "runtime-session:runtime-session" },
      lease: { phase: "held", expiresAt: "2026-08-13T01:00:00.000Z" },
    },
  ],
  activity: { lastObservedAt: "2026-08-13T00:00:00.000Z", outcome: null, exitCode: null, resultRef: null },
} as const;
const installation = {
  installationId: "installation-codex",
  kindId: "codex",
  version: "1.0.0",
  observedAt: "2026-08-13T00:00:00.000Z",
  models: ["gpt-5.6-sol", "gpt-5.6-terra"],
  defaultModel: "gpt-5.6-sol",
} as const;
const instance = {
  schemaVersion: 2,
  instanceId: definition.instanceId,
  name: "Codex Review",
  kindId: "codex",
  installationId: definition.installationId,
  providerId: "openai",
  models: [definition.model],
  defaultModel: definition.model,
  enabled: true,
  permissionMode: "bypass",
  codex: {
    reasoningEffort: definition.reasoningEffort,
    baseUrl: definition.baseUrl,
    baseUrlConfigured: true,
    wire_api: null,
    requires_openai_auth: null,
    http_headers: { "x-client": "harness" },
  },
  authMode: definition.authMode,
  authState: "configured",
  authReadiness: { status: "ready", code: null, hint: null },
  isolationState: "enforced",
} as const;
const claudeInstance = {
  ...instance,
  instanceId: "claude-one",
  name: "Claude One",
  kindId: "claude",
  authMode: "subscription",
  isolationState: "operator-environment",
  claude: { baseUrl: null, baseUrlConfigured: false },
} as never;
const agyInstance = {
  ...instance,
  instanceId: "agy-one",
  name: "Agy One",
  kindId: "agy",
  authMode: "subscription",
  permissionMode: null,
  isolationState: "operator-environment",
  agy: { effort: "high" },
} as never;
const agentRows = [
  {
    id: "fable",
    name: "fable",
    runtimeType: "claude",
    role: "commander",
    layer: "user",
    validity: "valid",
    issues: [],
  },
  { id: "luna", name: "luna", runtimeType: "codex", role: "worker", layer: "user", validity: "valid", issues: [] },
  { id: "sol", name: "sol", runtimeType: "codex", role: "worker", layer: "user", validity: "valid", issues: [] },
  { id: "terra", name: "terra", runtimeType: "codex", role: "worker", layer: "user", validity: "valid", issues: [] },
] as const;
const squadRows = [
  {
    id: "core-squad",
    name: "Core Squad",
    leader: "fable",
    workers: ["luna", "sol", "terra"],
    layer: "user",
    validity: "valid",
    issues: [],
  },
] as const;
const agentDetail = {
  id: "fable",
  name: "fable",
  runtimeType: "claude",
  role: "commander",
  instructions: "Lead the squad. Decide before dispatch.",
  model: null,
  skills: [
    { id: "review", path: "/Users/test/.claude/skills/review" },
    { id: "triage", path: "/repo/skills/triage" },
  ],
  prompts: ["daily-plan"],
  preset: null,
} as const;
const availableSkills = [
    { id: "review", path: "/Users/test/.claude/skills/review", source: "user" },
    { id: "triage", path: "/repo/skills/triage", source: "project" },
  ] as const,
  presets = [{ id: "standard-task", title: "Standard task", description: "Default implementation loop" }] as const;
const squadDetail = {
  id: "core-squad",
  name: "Core Squad",
  leader: "fable",
  workers: ["luna", "sol", "terra"],
  leaderTurnBudget: 8,
  roster: "fable » luna, sol, terra",
} as const;
const noop = () => undefined;
const runtimeCard = (row: typeof instance | typeof claudeInstance) =>
  renderToStaticMarkup(
    createElement(RuntimeCard, {
      instance: row,
      installations: [installation],
      agents: agentRows as never,
      liveSessions: 0,
      busy: false,
      onSelectAgent: noop,
      onAuth: noop,
      onValidate: noop,
      onSetEnabled: noop,
      onUpdate: noop,
      onDelete: noop,
      onSelfTest: async () => null,
    }),
  );
const detailView = (overrides: Partial<Parameters<typeof SessionDetailView>[0]> = {}) =>
  renderToStaticMarkup(
    createElement(SessionDetailView, {
      session,
      row: null,
      squadNames: new Map(),
      decisionRefs: [],
      result: null,
      transcript: createElement("p", null, "No dispatch record."),
      busy: false,
      onCancel: noop,
      onOpenTask: noop,
      onNavigateEntity: noop,
      ...overrides,
    } as never),
  );

afterEach(() => vi.unstubAllGlobals());
describe("agent runtime renderer", () => {
  it("submits spawn once, polls only the receipt, and waits for the canonical session", async () => {
    const spawn = vi.fn(async () => ({
        schema: "command-receipt/v2",
        ok: true,
        command: "runtime-spawn",
        outcome: "pending",
        opId: "runtime-op",
        runtimeSessionId: "runtime-new",
        dispatchId: "dispatch-new",
        revision: 5,
        evidence: "event-object:runtime-op",
        visibility: "center",
        proof: { committedRevision: 5, appliedCut: 4, durable: true, canonicalVisible: false, worktreeVisible: null },
        nextAction: "poll",
      })),
      showReceipt = vi.fn(async () => ({
        schema: "command-receipt/v2",
        ok: true,
        command: "receipt-show",
        outcome: "applied",
        opId: "runtime-op",
        revision: 5,
        evidence: "event-object:runtime-op",
        visibility: "center",
        proof: { committedRevision: 5, appliedCut: 5, durable: true, canonicalVisible: true, worktreeVisible: null },
        nextAction: null,
      })),
      overview = vi.fn(async () => ({
        ok: true,
        status: "ready",
        installations: [],
        instances: [],
        sessions: [{ ...session, runtimeSessionId: "runtime-new" }],
        watermark: 5,
        sourceRevision: 5,
      })),
      onPending = vi.fn();
    const result = await submitRuntimeSpawn(
      {
        runtimeInstanceId: "codex-review",
        cwd: { scope: "repo-root" },
        prompt: "Inspect",
        taskId: null,
        idempotencyKey: "once",
      },
      { spawn, showReceipt, overview, onPending },
      async () => undefined,
    );
    expect(result.state).toBe("applied");
    expect(result.opId).toBe("runtime-op");
    expect(onPending).toHaveBeenCalledWith(expect.objectContaining({ state: "pending", opId: "runtime-op" }));
    expect(spawn).toHaveBeenCalledOnce();
    expect(showReceipt).toHaveBeenCalledOnce();
    expect(overview).toHaveBeenCalledOnce();
  });
  it("authors connectivity self-test through the existing read-only runtime spawn input", () => {
    expect(runtimeSelfTestSpawnInput("codex-review", "gpt-5.6-sol", "self-test-once")).toEqual({
      runtimeInstanceId: "codex-review",
      model: "gpt-5.6-sol",
      permissionMode: "read-only",
      cwd: { scope: "repo-root" },
      prompt: "Reply with exactly: runtime connectivity ok",
      taskId: null,
      idempotencyKey: "self-test-once",
    });
    const succeeded = {
      ok: true,
      status: "ready",
      session: { ...session, activity: { ...session.activity, outcome: "succeeded" } },
      result: { ref: "artifact:runtime-result/test", text: "runtime connectivity ok" },
      watermark: 2,
      sourceRevision: 2,
    } as const;
    expect([
      successfulAgentRuntimeResult(succeeded),
      successfulAgentRuntimeResult({
        ...succeeded,
        session: { ...succeeded.session, activity: { ...succeeded.session.activity, outcome: "failed" } },
      }),
    ]).toEqual(["runtime connectivity ok", null]);
  });
  it("renders one instance-backed carrier card without recombinable installation or credential inputs", () => {
    const markup = runtimeCard(instance);
    expect(markup).toContain("Codex Review");
    expect(markup).toContain("gpt-5.6-sol");
    expect(markup).toContain("installation-codex");
    const selfTest = markup.match(/<section data-testid="runtime-card-self-test"[\s\S]*?<\/section>/u)?.[0] ?? "";
    expect({
      title: selfTest.includes("Connectivity self-test"),
      selectedModel: selfTest.includes('<option value="gpt-5.6-sol" selected="">gpt-5.6-sol</option>'),
      action: selfTest.includes(">Ping runtime</button>"),
    }).toEqual({ title: true, selectedModel: true, action: true });
    expect(markup).not.toMatch(/Runtime kind|Runtime profile|type="password"|name="(?:credential|token|apiKey)"/u);
  });
  it("renders liveness, holder/lease, activity, and frozen provenance from contract DTOs", () => {
    const markup = detailView();
    expect(markup).toContain("unknown");
    expect(markup).toContain("person-owner");
    expect(markup).toContain("held · 2026-08-13T01:00:00.000Z");
    expect(markup).toContain("codex-review");
    expect(markup).toContain("gpt-5.6-sol");
    expect(markup).toContain("last activity");
    expect(markup).toContain("2026-08-13T00:00:00.000Z");
    expect(markup).not.toContain("secret");
  });
  it("renders live, stale, unknown, and exited as distinct session states", () => {
    for (const state of ["live", "stale", "unknown", "exited"] as const)
      expect(detailView({ session: { ...session, liveness: state } })).toContain(`>${state}<`);
  });
  it("shows the session result text once the daemon projects one, and says so when it has not", () => {
    expect(detailView({ result: "Provider final report text." })).toContain("Provider final report text.");
    expect(detailView()).toContain("This session has no result text yet.");
  });
  it("shows the cancel control only while a session is live", () => {
    expect(detailView({ session: { ...session, liveness: "live" } })).toContain('data-testid="agent-runtime-cancel"');
    expect(detailView({ session: { ...session, liveness: "exited" } })).not.toContain(
      'data-testid="agent-runtime-cancel"',
    );
  });
  it("contains no renderer repo read, private WebSocket, or polling path", async () => {
    const { readFile } = await import("node:fs/promises"),
      source = `${await readFile(new URL("../src/renderer/agent-runtime-client.ts", import.meta.url), "utf8")}\n${await readFile(new URL("../src/renderer/components/runtime/SessionsPanel.tsx", import.meta.url), "utf8")}`;
    expect(source).not.toMatch(/WebSocket|setInterval|setTimeout|RepoCell|\.harness\//u);
  });
  it("surfaces an authentication failure on the carrier card instead of hiding it", () => {
    const notReady = {
      ...instance,
      authReadiness: {
        status: "not-ready",
        code: "runtime_credential_unavailable",
        hint: "The configured runtime API credential is unavailable.",
      },
    } as const;
    const markup = runtimeCard(notReady);
    expect(markup).toContain("runtime_credential_unavailable");
    expect(markup).toContain("The configured runtime API credential is unavailable.");
    expect(markup).toContain("API key");
    expect(markup).toContain("The key lives in the OS keychain");
    expect(markup).not.toMatch(
      /type="password"|name="(?:apiKey|credentialRef|token|secret)"|executablePath|\/opt\/runtime-test/u,
    );
  });
  it("renders ready, not-checked, and unauthenticated as distinct auth states", () => {
    const unchecked = {
      ...claudeInstance,
      authState: "unknown",
      authReadiness: {
        status: "not-ready",
        code: "runtime_auth_not_checked",
        hint: "Authentication has not been verified in this daemon generation.",
      },
    } as never;
    const unauthenticated = {
      ...claudeInstance,
      authState: "unauthenticated",
      authReadiness: {
        status: "not-ready",
        code: "runtime_subscription_required",
        hint: "Provider subscription authentication is unavailable in the operator environment.",
      },
    } as never;
    expect(runtimeCard(instance)).toContain('data-auth-status="succeeded"');
    const uncheckedMarkup = runtimeCard(unchecked);
    expect(uncheckedMarkup).toContain('data-auth-status="not-started"');
    expect(uncheckedMarkup).toContain("Authentication not checked");
    const unavailableMarkup = runtimeCard(unauthenticated);
    expect(unavailableMarkup).toContain('data-auth-status="succeeded"');
    expect(unavailableMarkup).toContain("runtime_subscription_required");
  });
  it("models not-started, probing, success, and retryable failure without pending fallback", () => {
    const unchecked = {
      ...claudeInstance,
      authState: "unknown",
      authReadiness: {
        status: "not-ready",
        code: "runtime_auth_not_checked",
        hint: "Authentication has not been verified in this daemon generation.",
      },
    } as never;
    const renderProbe = (authProbeState: Parameters<typeof runtimeAuthPresentation>[1]) =>
      renderToStaticMarkup(
        createElement(RuntimeCard, {
          instance: unchecked,
          installations: [installation],
          authProbeState,
          agents: [],
          liveSessions: 0,
          busy: false,
          onSelectAgent: noop,
          onAuth: noop,
          onValidate: noop,
          onSetEnabled: noop,
          onUpdate: noop,
          onDelete: noop,
          onSelfTest: async () => null,
        }),
      );
    const notStarted = renderProbe({ state: "not-started" }),
      probing = renderProbe({ state: "probing" }),
      succeeded = renderProbe({ state: "succeeded" }),
      failed = renderProbe({ state: "failed", error: "connect ECONNREFUSED" });
    expect(notStarted).toContain('data-auth-status="not-started"');
    expect(notStarted).toContain("Authentication not checked");
    expect(probing).toContain('data-auth-status="probing"');
    expect(probing).toContain("Checking authentication…");
    expect(probing).not.toContain("Authentication not checked");
    expect(succeeded).toContain('data-auth-status="succeeded"');
    expect(succeeded).toContain("runtime_auth_not_checked");
    expect(failed).toContain('data-auth-status="failed"');
    expect(failed).toContain("retry available: connect ECONNREFUSED");
    expect(
      ["not-started", "probing", "succeeded", "failed"].map(
        (state) =>
          runtimeAuthPresentation(unchecked, state === "failed" ? { state, error: "failed" } : ({ state } as never))
            .state,
      ),
    ).toEqual(["not-started", "probing", "succeeded", "failed"]);
  });
  it("offers the provider's own login actions on a subscription instance and none on an api-key instance", () => {
    const subscription = runtimeCard(claudeInstance);
    for (const action of ["Sign in", "Sign out"]) expect(subscription).toContain(action);
    expect(subscription).not.toContain("Re-auth");
    expect(subscription).not.toMatch(/type="password"/u);
    for (const action of ["Sign in", "Sign out"]) expect(runtimeCard(instance)).not.toContain(action);
  });
  it("offers AGY's terminal login path only after a probe reports unauthenticated", () => {
    const authenticated = renderToStaticMarkup(
      createElement(RuntimeCard, {
        instance: { ...agyInstance, authState: "authenticated" },
        installations: [installation],
        agents: [],
        liveSessions: 0,
        busy: false,
        onSelectAgent: noop,
        onAuth: noop,
        onValidate: noop,
        onSetEnabled: noop,
        onUpdate: noop,
        onDelete: noop,
        onSelfTest: async () => null,
      }),
    );
    const unauthenticated = renderToStaticMarkup(
      createElement(RuntimeCard, {
        instance: {
          ...agyInstance,
          authState: "unauthenticated",
          authReadiness: {
            status: "not-ready",
            code: "runtime_subscription_required",
            hint: "Provider subscription authentication is unavailable in the operator environment.",
          },
        },
        installations: [installation],
        agents: [],
        liveSessions: 0,
        busy: false,
        onSelectAgent: noop,
        onAuth: noop,
        onValidate: noop,
        onSetEnabled: noop,
        onUpdate: noop,
        onDelete: noop,
        onSelfTest: async () => null,
      }),
    );
    expect(authenticated).not.toMatch(/<button[^>]*>Sign in<\/button>/u);
    expect(unauthenticated).toMatch(/<button[^>]*>Sign in<\/button>/u);
  });
  it("keeps kind-specific runtime fields separated on the carrier card", () => {
    const codexMarkup = runtimeCard(instance),
      claudeMarkup = runtimeCard(claudeInstance);
    expect(codexMarkup).toContain("codex.reasoningEffort");
    expect(codexMarkup).toContain("codex.http_headers");
    expect(codexMarkup).toContain("x-client=harness");
    expect(codexMarkup).not.toContain("claude.baseUrl");
    expect(claudeMarkup).toContain("claude.baseUrl");
    expect(claudeMarkup).not.toContain("codex.reasoningEffort");
  });
  it("renders the carrier rail and the identity rail as the split runtime entries", () => {
    // W6 IA 拆分:原四段聚合 rail 拆成页级 rail——承运者归 Provider 入口,身份与
    // 组织(Squad 是 Agent 页内的面)归 Agent 入口,会话归会话入口。
    const providerRail = renderToStaticMarkup(
      createElement(ProviderRail, {
        instances: [instance, claudeInstance] as never,
        selectedId: null,
        liveByInstance: new Map(),
        onSelect: noop,
        onNew: noop,
      }),
    );
    for (const text of ["Runtimes", "Codex Review", "Claude One"]) expect(providerRail).toContain(text);
    expect(providerRail).not.toContain("Agents");
    expect(providerRail).not.toContain("Squads");
    expect(providerRail).not.toContain("Sessions");
    const identityRail = renderToStaticMarkup(
      createElement(IdentityRail, {
        agents: agentRows as never,
        squads: squadRows as never,
        selection: null,
        onSelect: noop,
        onNew: noop,
      }),
    );
    for (const text of ["Agents", "Squads", "fable", "luna", "sol", "terra", "Core Squad", "Design thesis"])
      expect(identityRail).toContain(text);
    expect(identityRail).not.toContain("Runtimes");
    expect(identityRail).not.toContain("Orchestration");
    const inspector = renderToStaticMarkup(
      createElement(IdentityInspector, {
        selection: { type: "squad", id: "core-squad" },
        agents: agentRows as never,
        squads: squadRows as never,
        rows: [],
        onSelect: noop,
        onOpenSession: noop,
      }),
    );
    for (const text of ["fable", "luna", "sol", "terra", "commander", "worker"]) expect(inspector).toContain(text);
  });
  it("renders the agent and squad declarations behind showAgent/showSquad", () => {
    const agent = renderToStaticMarkup(
      createElement(AgentCard, {
        detail: agentDetail,
        row: agentRows[0] as never,
        squads: squadRows as never,
        instances: [claudeInstance] as never,
        availableSkills,
        presets,
        busy: false,
        onSave: noop,
        onDispatch: noop,
        onSelectSquad: noop,
        onSelectRuntime: noop,
      }),
    );
    for (const text of [
      "Lead the squad. Decide before dispatch.",
      "commander",
      "claude",
      "review",
      "triage",
      "daily-plan",
      "Core Squad",
    ])
      expect(agent).toContain(text);
    expect(agent).toContain("Role is fully decoupled from model and provider");
    const squad = renderToStaticMarkup(
      createElement(SquadCard, {
        detail: squadDetail,
        row: squadRows[0] as never,
        agents: agentRows as never,
        busy: false,
        onSave: noop,
        onSelectAgent: noop,
      }),
    );
    for (const text of [
      "fable » luna, sol, terra",
      "Core Squad",
      "Commander",
      "Worker #1",
      "4 members",
      "Leader turn budget",
      "One launch starts the Commander session",
    ])
      expect(squad).toContain(text);
    expect(squad).toContain('data-testid="squad-leader-turn-budget"');
    expect(squad).toContain('value="8"');
    // 启动入口已搬到 SquadCockpit(一次只派 Commander);声明卡不再带派发动作。
    expect(squad).not.toContain("Launch Commander");
  });
  it("round-trips skill paths and exposes searchable Skill and Preset selectors", () => {
    const withSkills = renderToStaticMarkup(
      createElement(AgentCard, {
        detail: agentDetail,
        row: agentRows[0] as never,
        squads: squadRows as never,
        instances: [],
        availableSkills,
        presets,
        busy: false,
        onSave: noop,
        onDispatch: noop,
        onSelectSquad: noop,
        onSelectRuntime: noop,
      }),
    );
    expect(agentDeclarationFrom(agentDetail.id, agentDraftFrom(agentDetail))).toMatchObject({
      skills: agentDetail.skills,
    });
    expect(withSkills).toContain('data-testid="agent-skill-search"');
    expect(withSkills).toContain('data-testid="agent-preset"');
    expect(withSkills).not.toContain("saving here would drop the mounts");
  });
  it("keeps the Agent/Squad payload path open at the preload boundary", () => {
    expect(assertPreloadPayload("showAgent", { repoId: "repo-a", agentId: "fable" })).toBe(true);
    expect(assertPreloadPayload("showSquad", { repoId: "repo-a", squadId: "core-squad" })).toBe(true);
    expect(assertPreloadPayload("listAgents", { repoId: "repo-a" })).toBe(true);
    expect(assertPreloadPayload("listAgentSkills", { repoId: "repo-a" })).toBe(true);
    expect(assertPreloadPayload("listSquads", { repoId: "repo-a" })).toBe(true);
    expect(() => assertPreloadPayload("listAgents", { repoId: "repo-a", agentId: "fable" })).toThrow(/not allowed/u);
  });
  it("takes the API key only as a masked one-shot input, and only where the plane has an API mode", () => {
    const field = renderToStaticMarkup(
      createElement(TextInput, { label: "API key", type: "password", value: "", onChange: noop }),
    );
    expect(field).toMatch(/type="password"/u);
    expect(field).toContain('autoComplete="off"');
    expect(field).toContain('value=""');
    expect(field).not.toMatch(/name="/u);
    const dialog = (initialKind: "claude" | "codex" | "agy") =>
      renderToStaticMarkup(
        createElement(NewRuntimeDialog, {
          installations: [installation],
          busy: false,
          initialKind,
          onCancel: noop,
          onCreate: noop,
        }),
      );
    for (const kind of ["claude", "codex", "agy"] as const) expect(dialog(kind)).not.toMatch(/type="password"/u);
    expect(dialog("claude")).toContain("API override");
    expect(dialog("codex")).toContain("Codex-family models only.");
    expect(dialog("agy")).toContain("AGY supports only its own login flow");
    expect(dialog("agy")).not.toContain("API override");
  });
  it("renders detected models as selected checkboxes and keeps custom text behind an override", () => {
    const markup = renderToStaticMarkup(
      createElement(NewRuntimeDialog, {
        installations: [installation],
        busy: false,
        initialKind: "codex",
        onCancel: noop,
        onCreate: noop,
      }),
    );
    const models = markup.match(/<div data-testid="new-runtime-models"[\s\S]*?<\/div>/u)?.[0] ?? "";
    expect({
      sol: models.includes("gpt-5.6-sol"),
      terra: models.includes("gpt-5.6-terra"),
      checked: models.match(/type="checkbox" checked=""/gu)?.length ?? 0,
      defaultHint: markup.includes("Auto (default gpt-5.6-sol)"),
      customHidden: !markup.includes('data-testid="new-runtime-model-custom"'),
    }).toEqual({ sol: true, terra: true, checked: 2, defaultHint: true, customHidden: true });
  });
  it("offers bottom and right terminal dock positions", async () => {
    const { readFile } = await import("node:fs/promises"),
      source = await readFile(new URL("../src/renderer/components/TerminalDock.tsx", import.meta.url), "utf8");
    expect(source).toContain('data-testid="terminal-dock-bottom"');
    expect(source).toContain('data-testid="terminal-dock-right"');
    expect(source).toContain("data-dock-position={dockPosition}");
  });
  it("hides disabled instances by default while retaining them in all mode", () => {
    const enabled = { ...instance, instanceId: "enabled-instance", enabled: true } as const;
    const disabled = { ...instance, instanceId: "disabled-instance", enabled: false } as const;
    expect(visibleRuntimeInstances([enabled, disabled], false).map((row) => row.instanceId)).toEqual([
      "enabled-instance",
    ]);
    expect(visibleRuntimeInstances([enabled, disabled], true).map((row) => row.instanceId)).toEqual([
      "enabled-instance",
      "disabled-instance",
    ]);
  });
  it("edits only the permission and isolation fields supported by each runtime kind", () => {
    const codex = runtimeCard(instance),
      claude = runtimeCard(claudeInstance);
    const agy = renderToStaticMarkup(
      createElement(RuntimeCard, {
        instance: agyInstance,
        installations: [installation],
        agents: [],
        liveSessions: 0,
        busy: false,
        onSelectAgent: noop,
        onAuth: noop,
        onValidate: noop,
        onSetEnabled: noop,
        onUpdate: noop,
        onDelete: noop,
        onSelfTest: async () => null,
      }),
    );
    expect(codex).toContain('data-testid="runtime-instance-permission-mode"');
    expect(codex).not.toContain('data-testid="runtime-instance-isolation"');
    expect(claude).toContain('data-testid="runtime-instance-permission-mode"');
    expect(claude).toContain('data-testid="runtime-instance-isolation"');
    expect(agy).not.toContain('data-testid="runtime-instance-permissions"');
  });
  it("rejects a malformed session-groups bridge result instead of rendering it", async () => {
    const getAgentRuntimeSessionGroups = vi.fn(async () => ({ ok: true, groups: "not-an-array" })),
      stub = {
        getAgentRuntimeOverview: vi.fn(),
        getAgentRuntimeSessionGroups,
        getAgentRuntimeSession: vi.fn(),
        getAgentRuntimeEvents: vi.fn(),
      };
    vi.stubGlobal("window", { harness: stub });
    await expect(agentRuntimeClient.sessionGroups("repo-a", { groupBy: "task" })).rejects.toThrow(/invalid result/u);
    expect(getAgentRuntimeSessionGroups).toHaveBeenCalledWith({ repoId: "repo-a", groupBy: "task" });
  });
  it("sends the grouping, range and query to the daemon in one session-groups read", async () => {
    const getAgentRuntimeSessionGroups = vi.fn(async () => ({
        ok: true,
        status: "ready",
        groups: [],
        totals: { groups: 0, sessions: 0 },
        truncated: false,
        watermark: 1,
        sourceRevision: 1,
      })),
      stub = {
        getAgentRuntimeOverview: vi.fn(),
        getAgentRuntimeSessionGroups,
        getAgentRuntimeSession: vi.fn(),
        getAgentRuntimeEvents: vi.fn(),
      };
    vi.stubGlobal("window", { harness: stub });
    const result = await agentRuntimeClient.sessionGroups("repo-a", {
      groupBy: "task",
      since: "2026-08-26T00:00:00.000Z",
      query: "terra",
    });
    expect(result.totals).toEqual({ groups: 0, sessions: 0 });
    expect(getAgentRuntimeSessionGroups).toHaveBeenCalledWith({
      repoId: "repo-a",
      groupBy: "task",
      since: "2026-08-26T00:00:00.000Z",
      query: "terra",
    });
  });
  it("reads squad runs through the list bridge with exact payloads", async () => {
    const run = {
      squadRunId: "squad_" + "a".repeat(18),
      squadId: "squad-x",
      taskId: "task-x",
      mission: "m",
      phase: "converged",
      leaderTurnCount: 1,
      workerAttemptCount: 1,
      runningCount: 0,
      latestActivityAt: "2026-08-26T00:00:00.000Z",
    } as const;
    const listSquadRuns = vi.fn(async () => ({
      ok: true,
      status: "ready",
      runs: [run],
      totals: { runs: 1 },
      truncated: false,
      watermark: 1,
      sourceRevision: 1,
    }));
    vi.stubGlobal("window", { harness: { listSquadRuns, readSquadRun: vi.fn() } });
    const listed = await squadRunsClient.list("repo-a", { since: "2026-08-26T00:00:00.000Z", query: "ontology" });
    expect(listed.runs).toHaveLength(1);
    expect(listSquadRuns).toHaveBeenCalledWith({
      repoId: "repo-a",
      since: "2026-08-26T00:00:00.000Z",
      query: "ontology",
    });
    vi.stubGlobal("window", {
      harness: { listSquadRuns: vi.fn(async () => ({ ok: true, runs: "no" })), readSquadRun: vi.fn() },
    });
    await expect(squadRunsClient.list("repo-a")).rejects.toThrow(/invalid result/u);
  });

  it("reads one squad run's orchestration flow through the read bridge and fails closed", async () => {
    const squadRunId = "squad_" + "a".repeat(18);
    const detail = {
      ok: true as const,
      status: "ready" as const,
      run: {
        squadRunId,
        squadId: "squad-x",
        taskId: "task-x",
        mission: "m",
        phase: "workers_running" as const,
        error: null,
        currentLeaderRuntimeSessionId: "runtime-leader",
        leaderTurns: [
          {
            turnId: "leader-1",
            trigger: { kind: "initial" },
            dispatchId: "dispatch-a",
            runtimeSessionId: "runtime-leader",
            decision: { kind: "plan", dispatchCount: 2 },
            status: "running",
            startedAt: "2026-08-26T00:00:00.000Z",
            endedAt: null,
          },
        ],
        workerAttempts: [
          {
            attemptId: "worker-1",
            workerId: "terra",
            dispatchId: "dispatch-b",
            runtimeSessionId: "runtime-worker",
            rejection: null,
            status: null,
            startedAt: null,
            endedAt: null,
          },
        ],
      },
      watermark: 1,
      sourceRevision: 1,
    };
    const readSquadRun = vi.fn(async () => detail);
    vi.stubGlobal("window", { harness: { listSquadRuns: vi.fn(), readSquadRun } });
    const read = await squadRunsClient.read("repo-a", squadRunId);
    expect(read.run.leaderTurns[0]?.decision).toEqual({ kind: "plan", dispatchCount: 2 });
    expect(readSquadRun).toHaveBeenCalledWith({ repoId: "repo-a", squadRunId });
    vi.stubGlobal("window", { harness: { listSquadRuns: vi.fn(), readSquadRun: vi.fn(async () => ({ ok: true })) } });
    await expect(squadRunsClient.read("repo-a", squadRunId)).rejects.toThrow(/invalid result/u);
  });
});
