// harness-test-tier: integration
// @vitest-environment happy-dom
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { INITIAL_SETTINGS_V1 } from "@harness-anything/kernel";
import { daemonSettingsRead } from "../../daemon/src/protocol/daemon-settings-read-types.ts";
import { ProvidersView } from "../src/renderer/views/ProvidersView.tsx";
import { settingsQueryKeys } from "../src/renderer/settings-data.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

// Keep the real view, RuntimeCard, settings query, client and mutation. The machine catalog is
// independent of the repository settings read: it can be ready while that read fails.
vi.mock("../src/renderer/components/runtime/useRuntimeWorkspace.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProviderWorkspace: () => ({
    machine: { data: { installations: [] }, isPending: false },
    agents: { data: [] },
    instances: [
      {
        schemaVersion: 2,
        instanceId: "provider-a",
        name: "Provider A",
        kindId: "codex",
        installationId: "install-a",
        providerId: "openai",
        models: ["test-model"],
        defaultModel: "test-model",
        enabled: true,
        permissionMode: "read-only",
        isolationState: "operator-environment",
        configuration: { fast: false, reasoningEffort: null, baseUrlConfigured: false },
        authMode: "subscription",
        authState: "authenticated",
        authReadiness: { status: "ready", code: null, hint: null },
      },
    ],
    authProbeStates: new Map(),
    liveByInstance: new Map(),
    overview: { data: { sessions: [] } },
    busy: false,
  }),
}));
vi.mock("../src/renderer/decision-provider-data.ts", () => ({
  useDecisionProviderCatalog: () => ({ data: [] }),
  useDecisionProviderMutations: () => ({ busy: false }),
}));

const REPO = "project-access";
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let read = settingsRead(1, ["provider-existing"]);
const getSettings = vi.fn();
const updateSettings = vi.fn();

function settingsRead(revision: number, allowedInstances: string[]) {
  return daemonSettingsRead(
    { ...INITIAL_SETTINGS_V1, runtime: { ...INITIAL_SETTINGS_V1.runtime, allowedInstances } },
    revision,
    { occurredAt: "2026-11-05T15:23:00Z", actor: "person:fixture", revision },
  );
}
function toggle() {
  return container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Use in this project"]')!;
}
async function mount() {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <ProvidersView
          repoId={REPO}
          focusedEntityRef="provider/provider-a"
          onSelectEntity={() => {}}
          onBack={() => {}}
        />
      </QueryClientProvider>,
    );
  });
}
async function settled(check: () => void) {
  await act(async () => {
    await vi.waitFor(check);
  });
}

beforeAll(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterAll(() => {
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});

beforeEach(() => {
  setActiveLocale("en-US");
  read = settingsRead(1, ["provider-existing"]);
  getSettings.mockReset().mockImplementation(async () => read);
  updateSettings.mockReset().mockImplementation(async (input) => {
    read = settingsRead(read.revision + 1, input.runtimeAllowedInstances);
    return {
      schema: "command-receipt/v2",
      ok: true,
      command: "settings-update",
      outcome: "applied",
      opId: input.idempotencyKey,
      revision: read.revision,
    };
  });
  Object.defineProperty(window, "harness", { configurable: true, value: { getSettings, updateSettings } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
  Reflect.deleteProperty(window, "harness");
});

it("does not fabricate revision zero while the repository read is pending", async () => {
  getSettings.mockImplementation(() => new Promise(() => {}));
  await mount();
  expect(toggle().disabled).toBe(true);
  await act(async () => toggle().click());
  expect(updateSettings).not.toHaveBeenCalled();
});

it("shows a failed settings read beside project access and prevents a write", async () => {
  getSettings.mockResolvedValue({
    ok: false,
    error: { code: "invalid_result", hint: "Settings runtime field is unknown." },
  });
  await mount();
  await settled(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("invalid_result"));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Settings runtime field is unknown.");
  expect(toggle().disabled).toBe(true);
  await act(async () => toggle().click());
  expect(updateSettings).not.toHaveBeenCalled();
});

it("adds and removes an instance with the revision read from settings, preserving other instances", async () => {
  await mount();
  await settled(() =>
    expect(client.getQueryData(settingsQueryKeys.read(REPO))).toMatchObject({ revision: read.revision }),
  );
  await settled(() => expect(toggle().disabled).toBe(false));
  await act(async () => toggle().click());
  await settled(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
  expect(updateSettings.mock.calls[0]![0]).toMatchObject({
    repoId: REPO,
    expectedVersion: 1,
    runtimeAllowedInstances: ["provider-existing", "provider-a"],
  });
  await settled(() =>
    expect(client.getQueryData(settingsQueryKeys.read(REPO))).toMatchObject({ revision: read.revision }),
  );
  await settled(() => expect(toggle().disabled).toBe(false));
  await act(async () => toggle().click());
  await settled(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
  expect(updateSettings.mock.calls[1]![0]).toMatchObject({
    expectedVersion: 2,
    runtimeAllowedInstances: ["provider-existing"],
  });
});

it("shows a rejected settings write beside project access without changing the switch", async () => {
  updateSettings.mockResolvedValue({
    schema: "command-receipt/v2",
    ok: false,
    command: "settings-update",
    outcome: "op_rejected",
    opId: "conflict",
    code: "revision_conflict",
    rejectionExplanation: "Settings expected revision 1, current revision is 2.",
    error: { code: "revision_conflict" },
  });
  await mount();
  await settled(() =>
    expect(client.getQueryData(settingsQueryKeys.read(REPO))).toMatchObject({ revision: read.revision }),
  );
  await settled(() => expect(toggle().disabled).toBe(false));
  await act(async () => toggle().click());
  await settled(() => expect(container.querySelector('[role="alert"]')?.textContent).toContain("revision_conflict"));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("current revision is 2");
  expect(toggle().getAttribute("aria-checked")).toBe("false");
});
