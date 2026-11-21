// harness-test-tier: contract
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RuntimeInstanceSummary, RuntimeSubscriptionQuotaV1 } from "@harness-anything/daemon/protocol";
import { RuntimeCard } from "../src/renderer/components/runtime/RuntimeCard.tsx";
import { ProviderRail } from "../src/renderer/components/runtime/RuntimeRail.tsx";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const sampleQuota: RuntimeSubscriptionQuotaV1 = {
  schemaVersion: 1,
  observedAt: "2026-11-21T10:00:00.000Z",
  source: "claude-oauth",
  plan: "max",
  windows: [
    {
      id: "five_hour",
      label: "5h",
      kind: "session",
      remainingFraction: 0,
      usedPercent: 100,
      resetsAt: "2026-11-21T15:00:00.000Z",
    },
    {
      id: "seven_day",
      label: "7d",
      kind: "weekly",
      remainingFraction: 0.64,
      usedPercent: 36,
      resetsAt: "2026-11-28T00:00:00.000Z",
    },
  ],
  credits: { remaining: 75, limit: 100, unlimited: false },
};

const baseInstance: RuntimeInstanceSummary = {
  schemaVersion: 2,
  instanceId: "claude-max",
  name: "Claude Max",
  kindId: "claude",
  installationId: "claude-install",
  providerId: "anthropic",
  models: ["claude-opus-5-5"],
  availableModels: ["claude-opus-5-5"],
  quota: sampleQuota,
  defaultModel: "claude-opus-5-5",
  enabled: true,
  tier: 1,
  credentialSource: "instance",
  permissionMode: "bypass",
  isolationState: "enforced",
  configuration: {},
  authMode: "subscription",
  authState: "authenticated",
  authReadiness: { status: "ready", code: null, hint: null, basis: "provider" },
};

let root: Root | undefined;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("en-US");
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  document.body.innerHTML = "";
  setActiveLocale("en-US");
});

describe("subscription quota rendering in RuntimeCard and ProviderRail", () => {
  it("renders remaining percentage bars, reset times, credits, and accessible progressbar attributes", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        createElement(RuntimeCard, {
          instance: baseInstance,
          installations: [],
          agents: [],
          liveSessions: 0,
          busy: false,
          onSelectAgent: vi.fn(),
          onSelectRuntime: vi.fn(),
          onAuth: vi.fn(),
          onValidate: vi.fn(),
          onSetEnabled: vi.fn(),
          projectAllowed: true,
          projectSettingsBusy: false,
          onSetProjectAllowed: vi.fn(),
          onUpdate: vi.fn().mockResolvedValue({ ok: true }),
          onDelete: vi.fn(),
          onSelfTest: vi.fn().mockResolvedValue(null),
        }),
      ),
    );

    const card = container.querySelector('[data-testid="runtime-card-quota"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("Subscription quota");
    expect(card?.textContent).toContain("Exhausted");
    expect(card?.textContent).toContain("max");
    expect(card?.textContent).toContain("0%");
    expect(card?.textContent).toContain("64%");
    expect(card?.textContent).toContain("75 / 100");

    const bars = container.querySelectorAll('[data-testid="runtime-card-quota"] [role="progressbar"]');
    expect(bars.length).toBe(2);
    expect(bars[0]?.getAttribute("aria-valuenow")).toBe("0");
    expect(bars[1]?.getAttribute("aria-valuenow")).toBe("64");
  });

  it("renders the tightest quota badge in ProviderRail and supports zh-CN labels", async () => {
    setActiveLocale("zh-CN");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        createElement(ProviderRail, {
          instances: [baseInstance, { ...baseInstance, instanceId: "api-only", name: "API", quota: undefined }],
          selectedId: "claude-max",
          liveByInstance: new Map(),
          onSelect: vi.fn(),
          onNew: vi.fn(),
        }),
      ),
    );

    const quotaBadges = container.querySelectorAll('[data-testid="rail-runtime-quota"]');
    expect(quotaBadges.length).toBe(1);
    expect(quotaBadges[0]?.textContent).toContain("5h 0%");
  });
});
