// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProvidersView } from "../src/renderer/views/ProvidersView.tsx";
import { mockRpcBridge } from "./mock-rpc-bridge.ts";

const workspace = {
  machine: {
    data: { nodeId: "node-a", installations: [], subscriptionIsolationKinds: [] },
    isPending: false,
  },
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
  feedback: null,
  error: null,
  settlement: null,
  clearFeedback: vi.fn(),
  createInstance: vi.fn(),
  updateInstance: vi.fn(),
  setInstanceEnabled: vi.fn(),
  clearInstanceFreeze: vi.fn(),
  deleteInstance: vi.fn(),
  validateInstance: vi.fn(),
  authInstance: vi.fn(),
  selfTest: vi.fn(),
};

vi.mock("../src/renderer/components/runtime/useRuntimeWorkspace.ts", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useProviderWorkspace: () => workspace,
}));
vi.mock("../src/renderer/components/runtime/DecisionProviderPanel.tsx", () => ({
  DecisionProviderDetail: () => null,
  DecisionProviderDialog: () => null,
  ProviderTypeDialog: () => null,
}));
vi.mock("../src/renderer/decision-provider-data.ts", () => ({
  useDecisionProviderCatalog: () => ({ data: [] }),
  useDecisionProviderMutations: () => ({ busy: false }),
}));

describe("ProvidersView node-local controls", () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;

  beforeAll(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  });

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
  });

  it("renders only the node-local enabled switch and never exposes shared project access", async () => {
    const request = vi.fn(async () => {
      throw new Error("Unexpected repository settings request");
    });
    Object.defineProperty(window, "harness", {
      configurable: true,
      value: mockRpcBridge({ request }, {}),
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProvidersView
            repoId="repo-a"
            focusedEntityRef="provider/provider-a"
            onSelectEntity={() => undefined}
            onBack={() => undefined}
          />
        </QueryClientProvider>,
      );
    });

    expect(container.querySelector('[data-testid="runtime-card-project-access"]')).toBeNull();
    expect(container.querySelector('[data-testid="runtime-project-order"]')).toBeNull();
    const enabledSwitch = container.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Enabled"]');
    expect(enabledSwitch).not.toBeNull();
    await act(async () => enabledSwitch!.click());
    expect(workspace.setInstanceEnabled).toHaveBeenCalledWith("provider-a", false);
    expect(request).not.toHaveBeenCalled();
  });
});
