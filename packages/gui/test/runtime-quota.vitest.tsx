// harness-test-tier: contract
// @vitest-environment happy-dom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RuntimeInstanceSummary, RuntimeSubscriptionQuotaV1 } from "@harness-anything/daemon/protocol";
import { RuntimeCard } from "../src/renderer/components/runtime/RuntimeCard.tsx";
import { RuntimeQuotaCard, RuntimeQuotaRailBadge } from "../src/renderer/components/runtime/RuntimeQuotaPanel.tsx";
import { ProviderRail } from "../src/renderer/components/runtime/RuntimeRail.tsx";
import { runtimeInstanceClient } from "../src/renderer/runtime-instance-client.ts";
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
      scope: "primary",
      remainingFraction: 0,
      usedPercent: 100,
      resetsAt: "2099-11-21T15:00:00.000Z",
    },
    {
      id: "seven_day",
      label: "7d",
      kind: "weekly",
      scope: "primary",
      remainingFraction: 0.64,
      usedPercent: 36,
      resetsAt: "2099-11-28T00:00:00.000Z",
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
  delete (window as unknown as { harness?: unknown }).harness;
  setActiveLocale("en-US");
});

describe("subscription quota rendering and IPC validation", () => {
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

  it("renders tightest quota badge with accessible reset time in ProviderRail and supports zh-CN labels", async () => {
    setActiveLocale("zh-CN");
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root!.render(
        createElement(ProviderRail, {
          instances: [baseInstance, { ...baseInstance, instanceId: "api-only", name: "API", quota: undefined }],
          selectedId: "claude-max",
          nodeId: "node-a",
          liveByInstance: new Map(),
          onSelect: vi.fn(),
          onNew: vi.fn(),
        }),
      ),
    );

    const quotaBadges = container.querySelectorAll('[data-testid="rail-runtime-quota"]');
    expect(quotaBadges.length).toBe(1);
    expect(quotaBadges[0]?.textContent).toContain("5h 0%");
    expect(quotaBadges[0]?.getAttribute("aria-label")).toContain("重置");
    expect(quotaBadges[0]?.getAttribute("title")).toContain("重置");
    expect(container.querySelector('[data-testid="rail-runtime-quota-reset"]')).not.toBeNull();
  });

  it("validates quota payloads across runtimeInstanceClient list, show, and probe boundaries", async () => {
    const legacyInstance = { ...baseInstance, instanceId: "legacy-no-quota", quota: undefined };
    const request = vi.fn();
    (window as unknown as { harness: { request: typeof request } }).harness = { request };

    // Legacy (omitted quota) and valid quota are accepted on list/show/probe.
    request.mockResolvedValueOnce({
      schema: "command-receipt/v2",
      ok: true,
      nodeId: "node-a",
      instances: [legacyInstance, baseInstance],
      installations: [],
    });
    const catalog = await runtimeInstanceClient.list();
    expect(catalog.instances.length).toBe(2);
    expect(catalog.instances[1]?.quota?.plan).toBe("max");

    request.mockResolvedValueOnce({ schema: "command-receipt/v2", ok: true, instance: baseInstance });
    const probed = await runtimeInstanceClient.probe("claude-max");
    expect(probed.quota?.windows.length).toBe(2);

    // Malformed quota payloads (broken windows, array-coerced kind, out-of-range fraction) are rejected.
    request.mockResolvedValueOnce({
      schema: "command-receipt/v2",
      ok: true,
      nodeId: "node-a",
      instances: [{ ...baseInstance, quota: { ...sampleQuota, windows: "not-an-array" } }],
      installations: [],
    });
    await expect(runtimeInstanceClient.list()).rejects.toThrow(/invalid subscription quota/iu);

    request.mockResolvedValueOnce({
      schema: "command-receipt/v2",
      ok: true,
      instance: {
        ...baseInstance,
        quota: { ...sampleQuota, windows: [{ ...sampleQuota.windows[0]!, kind: ["session"] }] },
      },
    });
    await expect(runtimeInstanceClient.probe("claude-max")).rejects.toThrow(/invalid subscription quota/iu);

    request.mockResolvedValueOnce({
      schema: "command-receipt/v2",
      ok: true,
      instance: {
        ...baseInstance,
        quota: { ...sampleQuota, windows: [{ ...sampleQuota.windows[0]!, remainingFraction: 2 }] },
      },
    });
    await expect(runtimeInstanceClient.show("claude-max")).rejects.toThrow(/invalid subscription quota/iu);
  });

  it("uses shared domain applicability so expired windows or inapplicable AGY Argon buckets do not mark a Gemini instance Exhausted", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const agyQuota: RuntimeSubscriptionQuotaV1 = {
      schemaVersion: 1,
      observedAt: "2026-11-21T10:00:00.000Z",
      source: "agy-cli",
      plan: "Pro",
      windows: [
        {
          id: "gemini-weekly",
          label: "Gemini",
          kind: "weekly",
          scope: "primary",
          remainingFraction: 0.83,
          usedPercent: 17,
          resetsAt: "2026-11-28T00:00:00.000Z",
        },
        {
          id: "argon-weekly",
          label: "Argon",
          kind: "weekly",
          scope: "primary",
          remainingFraction: 0,
          usedPercent: 100,
          resetsAt: "2026-11-28T00:00:00.000Z",
        },
      ],
    };
    await act(async () =>
      root!.render(
        createElement("div", null, [
          createElement(RuntimeQuotaCard, {
            key: "card",
            quota: agyQuota,
            models: ["gemini-4-hydrogen-low"],
            now: "2026-11-21T12:00:00.000Z",
          }),
          createElement(RuntimeQuotaRailBadge, {
            key: "badge",
            quota: agyQuota,
            models: ["gemini-4-hydrogen-low"],
            now: "2026-11-21T12:00:00.000Z",
          }),
        ]),
      ),
    );
    expect(container.querySelector('[data-testid="runtime-card-quota"]')?.textContent).not.toContain("Exhausted");
    expect(container.querySelector('[data-testid="rail-runtime-quota"]')?.textContent).toContain("Gemini 83%");

    // Expired reset time (past `now`) also clears the Exhausted badge.
    const expiredQuota: RuntimeSubscriptionQuotaV1 = {
      ...sampleQuota,
      windows: [{ ...sampleQuota.windows[0]!, resetsAt: "2026-11-21T09:00:00.000Z" }],
    };
    await act(async () =>
      root!.render(
        createElement(RuntimeQuotaCard, {
          quota: expiredQuota,
          models: ["claude-opus-5-5"],
          now: "2026-11-21T12:00:00.000Z",
        }),
      ),
    );
    expect(container.querySelector('[data-testid="runtime-card-quota"]')?.textContent).not.toContain("Exhausted");
  });

  it("QUOTA-20: projects providerHealth status and recovery time using max of still-future clocks and treats expired quotaExhaustedUntil as ready", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const commonProps = {
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
      onUpdate: vi.fn().mockResolvedValue({ ok: true }),
      onDelete: vi.fn(),
      onSelfTest: vi.fn().mockResolvedValue(null),
    };

    // 1. Transport cooldown (earlier: 13:11:22) + quota exhaustion (later: 15:44:55) at 12:00 ->
    //    MUST show cooldown and the LATER 15:44:55 recovery timestamp (matching scheduler eligibility).
    await act(async () =>
      root!.render(
        createElement(RuntimeCard, {
          ...commonProps,
          now: "2026-11-21T12:00:00.000Z",
          providerHealth: {
            nodeId: "local-node",
            failureStreak: 1,
            cooldownUntil: "2026-11-21T13:11:22.000Z",
            frozen: false,
            frozenUntil: null,
            reason: "HTTP 503",
            quotaExhaustedUntil: "2026-11-21T15:44:55.000Z",
          },
        }),
      ),
    );
    const healthCardBoth = container.querySelector('[data-testid="runtime-card-health"]');
    expect(healthCardBoth).not.toBeNull();
    expect(healthCardBoth?.textContent).toContain("cooldown");
    expect(healthCardBoth?.textContent).toContain("HTTP 503");
    // Ensure the displayed recovery time reflects 15:44:55 UTC (not earlier 13:11:22 UTC), timezone-independently.
    expect(healthCardBoth?.textContent).toContain("44:55");
    expect(healthCardBoth?.textContent).not.toContain("11:22");

    // 2. Expired quotaExhaustedUntil (past `now`) -> MUST show ready (not cooldown), reason "-", recover at "-".
    await act(async () =>
      root!.render(
        createElement(RuntimeCard, {
          ...commonProps,
          now: "2026-11-21T12:00:00.000Z",
          providerHealth: {
            nodeId: "local-node",
            failureStreak: 0,
            cooldownUntil: null,
            frozen: false,
            frozenUntil: null,
            reason: null,
            quotaExhaustedUntil: "2026-11-21T09:00:00.000Z",
          },
        }),
      ),
    );
    const healthCardExpired = container.querySelector('[data-testid="runtime-card-health"]');
    expect(healthCardExpired).not.toBeNull();
    expect(healthCardExpired?.textContent).toContain("ready");
    expect(healthCardExpired?.textContent).not.toContain("cooldown");
    expect(healthCardExpired?.textContent).not.toContain("quota_exhausted");
  });
});
