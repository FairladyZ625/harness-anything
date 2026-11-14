// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement, StrictMode, useEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "../src/renderer/App.tsx";
import { runtimeInstanceClient } from "../src/renderer/runtime-instance-client.ts";
import { terminalClient, terminalQueryKeys, type TerminalSessionList } from "../src/renderer/terminal-client.ts";
import type { TerminalStreamFrame } from "../src/renderer/terminal-model.ts";
import { readTerminalLayout, writeTerminalLayout, layoutSessionIds } from "../src/renderer/terminal-layout.ts";
import { DEFAULT_TASK_FILTERS } from "../src/renderer/model/taskFilters.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";
import type {
  RuntimeInstanceSummary,
  TerminalControlReceipt,
  TerminalSessionRow,
} from "@harness-anything/daemon/protocol";

// Keep the real App, ProvidersView, TerminalRoute, TerminalView and dockview. Only xterm's canvas
// is replaced; focus and text input still cross the real pane actions and terminal client.
vi.mock("../src/renderer/components/terminal/TerminalPane.tsx", () => ({
  TerminalPane: ({
    onInput,
    focused,
    focusRequestId,
  }: {
    onInput: (text: string) => void;
    focused: boolean;
    focusRequestId: string | null;
  }) => {
    const ref = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
      if (focused) ref.current?.focus();
    }, [focused, focusRequestId]);
    return createElement("textarea", {
      ref,
      className: "xterm-helper-textarea",
      onChange: (event) => onInput(event.currentTarget.value),
    });
  },
}));

const repoId = "canonical",
  sessionId = "term_auth_1",
  instanceId = "agy-hogan";
const at = "2026-11-14T00:00:00Z";
let root: Root | undefined, client: QueryClient | undefined;
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  client?.clear();
  root = undefined;
  document.body.innerHTML = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  delete (window as unknown as Record<string, unknown>).harness;
  vi.restoreAllMocks();
});
async function settled(check: () => void) {
  await vi.waitFor(async () => {
    await act(async () => {});
    check();
  });
}
async function click(id: string) {
  await settled(() => expect(document.querySelector(`[data-testid="${id}"]`)).not.toBeNull());
  await act(async () => document.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`)!.click());
}
function row(id: string): TerminalSessionRow {
  return {
    sessionId: id,
    repoId,
    name: id === sessionId ? "agy-hogan · Sign in" : "Old terminal",
    cwd: ".",
    shellProfile: "runtime-auth",
    requestedBackend: "direct-pty",
    backend: "direct-pty",
    status: "running",
    createdAt: at,
    lastActivityAt: at,
    exitCode: null,
    outputSeq: 0,
    durability: "daemon-process",
    warning: null,
    attachable: true,
  };
}
async function mount(
  outcome: "applied" | "op_rejected" = "applied",
  existingAuthPane = false,
  kindId = "agy",
  warm = false,
) {
  let instance: RuntimeInstanceSummary = {
    schemaVersion: 2,
    instanceId,
    name: "AGY Hogan",
    kindId,
    installationId: "agy-install",
    providerId: "google",
    models: [],
    defaultModel: "",
    enabled: false,
    tier: 1,
    credentialSource: "instance",
    permissionMode: null,
    isolationState: "enforced",
    configuration: {},
    authMode: "subscription",
    authState: "unauthenticated",
    authReadiness: { status: "not-ready", code: "runtime_subscription_required", hint: "Sign in" },
  };
  const list = vi.spyOn(runtimeInstanceClient, "list").mockImplementation(async () => ({
    instances: [instance],
    installations: [],
    subscriptionIsolationKinds: ["agy"],
  }));
  const auth = vi.spyOn(runtimeInstanceClient, "auth").mockResolvedValue({
    schema: "terminal-control-receipt/v1",
    ok: outcome === "applied",
    outcome,
    sessionId,
    operationId: "op-auth",
    error: outcome === "applied" ? null : { code: "fixture_rejection", hint: "Rejected sign in" },
  } as TerminalControlReceipt);
  const probe = vi.spyOn(runtimeInstanceClient, "probe").mockImplementation(async () => {
    instance = {
      ...instance,
      authState: "authenticated",
      authReadiness: { status: "ready", code: null, hint: null },
      availableModels: ["fresh-account-model"],
    };
    return instance;
  });
  const rows = [row("old"), row(sessionId)];
  vi.spyOn(terminalClient, "list").mockImplementation(
    async (): Promise<TerminalSessionList> => ({
      schema: "terminal-session-list/v1",
      ok: true,
      repoId,
      daemonGeneration: 1,
      sessions: rows,
    }),
  );
  const listeners = new Map<string, (frame: TerminalStreamFrame) => void>();
  const attach = vi.spyOn(terminalClient, "attach").mockImplementation((_repo, id, _seq, callback) => {
    listeners.set(id, callback);
    return () => listeners.delete(id);
  });
  const spawn = vi.spyOn(terminalClient, "spawn");
  const input = vi.spyOn(terminalClient, "input").mockResolvedValue(1);
  vi.spyOn(terminalClient, "detach").mockResolvedValue({ state: "detached" } as never);
  vi.spyOn(terminalClient, "resize").mockResolvedValue({} as never);
  const bridge = {
    getSystemStatus: async () => ({
      schema: "gui-system-status/v1",
      ok: true,
      observedAt: at,
      daemon: {
        daemonId: "fixture",
        pid: 1,
        startedAt: at,
        protocolVersion: { major: 1, minor: 0 },
        uptimeMs: 1,
        endpoint: "sock",
        build: { version: "fixture", commitSha: null },
        activeControl: null,
      },
      repos: [
        {
          repoId,
          displayName: "Fixture",
          canonicalRoot: "/tmp/auth-fixture",
          authoredBranch: "main",
          registrationState: "enabled",
          mode: "local",
          connectionId: "local",
          cellState: "attached",
          generation: 1,
          queueDepth: 0,
          lockState: "not_applicable",
          recoveryMs: null,
          lastError: null,
          unavailableReason: null,
        },
      ],
    }),
    getTasks: async () => ({
      ok: true,
      status: "ready",
      rows: [],
      invalidRows: [],
      watermark: 1,
      sourceRevision: 1,
      warnings: [],
    }),
    getWorkspaceSummary: async () => ({
      schema: "daemon.workspace-summary/v1",
      ok: true,
      status: "ready",
      tasks: { lastChangedAt: null, total: 0, byStatus: {} },
      decisions: { total: 0, inboxCount: 0, byState: {}, groups: [] },
      watermark: 1,
      sourceRevision: 1,
      warnings: [],
    }),
    getCatalogSnapshot: async () => ({
      schema: "gui-catalog-snapshot/v2",
      ok: true,
      status: "ready",
      repoId,
      observedAt: at,
      catalogDigest: "fixture-digest---------------------",
      defaults: { verticalId: "software/coding", presetId: "standard-task", profileId: "baseline", locale: "en-US" },
      presets: [],
      templates: [],
      scaffolds: { task: [], repository: [] },
      bundledAgents: [],
    }),
    listAgents: async () => ({ ok: true, agents: [] }),
    getAgentRuntimeOverview: async () => ({
      schema: "agent-runtime-overview/v1",
      sessions: [],
      instances: [],
      installations: [],
    }),
    listDecisionProviders: async () => ({ ok: true, providers: [] }),
    getSettings: async () => ({
      schema: "settings-read/v1",
      revision: 1,
      settings: { runtime: { allowedInstances: [] } },
      values: {},
    }),
  };
  Object.defineProperty(window, "harness", {
    configurable: true,
    value: new Proxy(bridge, {
      get: (target, key) => target[key as keyof typeof bridge] ?? (async () => ({ ok: true })),
    }),
  });
  window.localStorage.setItem(
    `harness-view-history:${repoId}`,
    JSON.stringify({
      schema: "gui-view-history/v1",
      history: {
        entries: [
          {
            view: "providers",
            selectedId: null,
            previewId: null,
            focusedEntityRef: `provider/${instanceId}`,
            taskFilters: DEFAULT_TASK_FILTERS,
            drill: null,
          },
        ],
        index: 0,
      },
    }),
  );
  writeTerminalLayout(window.localStorage, repoId, {
    activeGroupId: "old-group",
    groups: [
      {
        groupId: "old-group",
        seeds: [
          ...(existingAuthPane ? [{ panelId: "auth-pane", sessionId }] : []),
          { panelId: "old-pane", sessionId: "old" },
        ],
        grid: null,
      },
    ],
  });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  if (warm)
    client.setQueryData(terminalQueryKeys.sessions(repoId), {
      schema: "terminal-session-list/v1",
      ok: true,
      repoId,
      daemonGeneration: 1,
      sessions: rows,
    });
  root = createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () =>
    root!.render(
      createElement(StrictMode, null, createElement(QueryClientProvider, { client: client! }, createElement(App))),
    ),
  );
  return { auth, probe, list, attach, spawn, input, rows, listeners };
}
async function back() {
  await act(async () => window.dispatchEvent(new KeyboardEvent("keydown", { key: "`", ctrlKey: true })));
}

describe("provider authentication terminal bridge (dec_DA1602487428A58E8B446ECE38/CH1)", () => {
  it.each([
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ])(
    "attaches and focuses the returned session over a stored layout, then probes a successful exit (existing pane: %s, warm cache: %s)",
    async (existing, warm) => {
      const { auth, probe, list, attach, spawn, input, rows, listeners } = await mount(
        "applied",
        existing,
        "agy",
        warm,
      );
      await click("runtime-account-login");
      await settled(() => expect(attach).toHaveBeenCalledWith(repoId, sessionId, 0, expect.any(Function)));
      expect(auth).toHaveBeenCalledWith(repoId, instanceId, "login");
      await settled(() =>
        expect(document.querySelector(`[data-session-id="${sessionId}"][data-focused="true"] textarea`)).toBe(
          document.activeElement,
        ),
      );
      expect(spawn).not.toHaveBeenCalled();
      const layout = readTerminalLayout(window.localStorage, repoId);
      expect(layoutSessionIds(layout).filter((id) => id === sessionId)).toHaveLength(1);
      expect(layout.groups).toHaveLength(existing ? 1 : 2);
      await act(async () => {
        const textarea = document.activeElement as HTMLTextAreaElement;
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(
          textarea,
          "fixture-oauth-code",
        );
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
      await settled(() => expect(input).toHaveBeenCalledWith(repoId, sessionId, 1, "fixture-oauth-code"));
      rows[1] = { ...rows[1], status: "exited", attachable: false, exitCode: 0 };
      await act(async () =>
        listeners.get(sessionId)!({
          schema: "terminal-attach-event/v1",
          sessionId,
          seq: 1,
          kind: "exit",
          utf8: "",
          droppedThrough: null,
          occurredAt: at,
        }),
      );
      await settled(() => expect(probe).toHaveBeenCalledWith(instanceId, repoId));
      await back();
      await settled(() => expect(document.querySelector('[data-testid="runtime-account-refresh"]')).not.toBeNull());
      await settled(() => expect(list.mock.results.length).toBeGreaterThan(1));
      await settled(() => expect(document.querySelector("[data-auth-status]")?.textContent).toContain("authenticated"));
      await click("runtime-provider-edit");
      expect(document.querySelector('[data-testid="runtime-provider-models"]')?.textContent).toContain(
        "fresh-account-model",
      );
    },
  );
  it("does not navigate on a rejected terminal receipt", async () => {
    const { auth, attach, probe } = await mount("op_rejected");
    await click("runtime-account-login");
    await settled(() => expect(auth).toHaveBeenCalledTimes(1));
    expect(document.querySelector('[data-testid="terminal-view"]')).toBeNull();
    expect(document.body.textContent).toContain("Rejected sign in");
    expect(attach).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
  });
  it("ignores an unsuccessful exit and probes when returning to the original Provider detail", async () => {
    const { probe, attach, rows, listeners } = await mount();
    await click("runtime-account-login");
    await settled(() => expect(attach).toHaveBeenCalledWith(repoId, sessionId, 0, expect.any(Function)));
    rows[1] = { ...rows[1], status: "exited", attachable: false, exitCode: 1 };
    await act(async () =>
      listeners.get(sessionId)!({
        schema: "terminal-attach-event/v1",
        sessionId,
        seq: 1,
        kind: "exit",
        utf8: "",
        droppedThrough: null,
        occurredAt: at,
      }),
    );
    expect(probe).not.toHaveBeenCalled();
    await back();
    await settled(() => expect(probe).toHaveBeenCalledWith(instanceId, repoId));
    expect(document.querySelector('[data-testid="terminal-view"]')).toBeNull();
  });
  it("attaches an already exited login and still refreshes the account", async () => {
    const { probe, attach, rows } = await mount();
    rows[1] = { ...rows[1], status: "exited", attachable: false, exitCode: 0 };
    await click("runtime-account-login");
    await settled(() => expect(attach).toHaveBeenCalledWith(repoId, sessionId, 0, expect.any(Function)));
    await settled(() => expect(probe).toHaveBeenCalledWith(instanceId, repoId));
  });
  it("leaves the Provider visible when an applied receipt has no session", async () => {
    const { auth, attach } = await mount();
    auth.mockResolvedValue({
      schema: "terminal-control-receipt/v1",
      outcome: "applied",
      sessionId: null,
    } as TerminalControlReceipt);
    await click("runtime-account-login");
    await settled(() => expect(auth).toHaveBeenCalledTimes(1));
    expect(attach).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="terminal-view"]')).toBeNull();
  });
  it("opens the logout terminal too", async () => {
    const { auth, attach } = await mount("applied", false, "codex");
    await settled(() =>
      expect(
        [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Sign out"),
      ).toBeDefined(),
    );
    await act(async () =>
      [...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Sign out")!.click(),
    );
    await settled(() => expect(attach).toHaveBeenCalledWith(repoId, sessionId, 0, expect.any(Function)));
    expect(auth).toHaveBeenCalledWith(repoId, instanceId, "logout");
  });
  it("surfaces a post-login probe failure", async () => {
    const { probe, attach, rows, listeners } = await mount();
    probe.mockRejectedValue(new Error("fixture account probe failed"));
    await click("runtime-account-login");
    await settled(() => expect(attach).toHaveBeenCalledWith(repoId, sessionId, 0, expect.any(Function)));
    rows[1] = { ...rows[1], status: "exited", attachable: false, exitCode: 0 };
    await act(async () =>
      listeners.get(sessionId)!({
        schema: "terminal-attach-event/v1",
        sessionId,
        seq: 1,
        kind: "exit",
        utf8: "",
        droppedThrough: null,
        occurredAt: at,
      }),
    );
    await settled(() =>
      expect(document.querySelector('[role="alert"]')?.textContent).toContain("fixture account probe failed"),
    );
  });
});
