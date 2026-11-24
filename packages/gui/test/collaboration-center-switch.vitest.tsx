// harness-test-tier: fast
// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CollaborationView } from "../src/renderer/views/CollaborationView.tsx";
import type { FleetOverviewRead } from "../src/api/renderer-dto.ts";
import type {
  CenterSettingsReply,
  CenterSwitchInput,
  CenterSwitchPreflightResult,
  CenterSwitchReply,
  EdgeLocalState,
  PromoteFromEdgeInput,
  PromoteFromEdgeReply,
} from "../src/api/center-settings-contract.ts";
import { setActiveLocale } from "../src/renderer/i18n/core.ts";

const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  setActiveLocale("zh-CN");
});

afterEach(() => {
  while (mounted.length > 0) {
    const entry = mounted.pop()!;
    act(() => entry.root.unmount());
    entry.host.remove();
  }
  vi.restoreAllMocks();
});

function overviewFixture(overrides: Partial<FleetOverviewRead> = {}): FleetOverviewRead {
  return {
    schema: "daemon.fleet-overview/v1",
    ok: true,
    repoId: "repo-switch",
    mode: "local",
    effectiveMode: "center",
    generatedAt: "2026-11-24T00:00:00.000Z",
    center: {
      nodeId: "center",
      daemonId: "default",
      startedAt: "2026-11-24T00:00:00.000Z",
      version: "0.1.0",
      commitSha: "aa97781",
    },
    centerRevision: 200,
    nodes: [
      {
        nodeId: "center",
        role: "center",
        owner: { kind: "value", text: "daemon" },
        build: { kind: "value", text: "0.1.0 @ aa97781" },
        online: { kind: "value", text: "running" },
        leases: [],
        replica: null,
        replicaReason: "center-local-writer",
        watch: { kind: "value", text: "local canonical writer" },
        lastFailure: { kind: "unavailable", reason: "no-session-failure-observed" },
      },
      {
        nodeId: "edge-node-b",
        role: "edge",
        owner: { kind: "value", text: "person_zeyu" },
        build: { kind: "value", text: "0.1.0 @ aa97781" },
        online: { kind: "value", text: "connected" },
        leases: [],
        replica: {
          repoId: "repo-switch",
          viewId: "edge-node-b",
          centerRevision: 200,
          centerEventAt: "2026-11-24T00:00:00.000Z",
          ackRevision: 200,
          ackedAt: "2026-11-24T00:00:00.000Z",
          lagRevisions: 0,
          lagMs: 0,
          delivery: "delta",
          connected: true,
          syncFailure: null,
        },
        replicaReason: "replica-current",
        watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
        lastFailure: { kind: "unavailable", reason: "no-session-failure-observed" },
      },
      {
        nodeId: "edge-node-c",
        role: "edge",
        owner: { kind: "value", text: "person_zeyu" },
        build: { kind: "value", text: "0.1.0 @ aa97781" },
        online: { kind: "value", text: "connected" },
        leases: [],
        replica: {
          repoId: "repo-switch",
          viewId: "edge-node-c",
          centerRevision: 200,
          centerEventAt: "2026-11-24T00:00:00.000Z",
          ackRevision: 199,
          ackedAt: "2026-11-24T00:00:00.000Z",
          lagRevisions: 1,
          lagMs: 1000,
          delivery: "delta",
          connected: true,
          syncFailure: null,
        },
        replicaReason: "replica-catching-up",
        watch: { kind: "unavailable", reason: "edge-sync-internals-not-exposed" },
        lastFailure: { kind: "unavailable", reason: "no-session-failure-observed" },
      },
    ],
    links: [
      {
        nodeId: "edge-node-b",
        state: "fresh",
        delivery: "delta",
        lagRevisions: 0,
        lagMs: 0,
        ackedAt: "2026-11-24T00:00:00.000Z",
        centerRevision: 200,
      },
      {
        nodeId: "edge-node-c",
        state: "lag",
        delivery: "delta",
        lagRevisions: 1,
        lagMs: 1000,
        ackedAt: "2026-11-24T00:00:00.000Z",
        centerRevision: 200,
      },
    ],
    events: [],
    notes: [],
    warnings: [],
    ...overrides,
  };
}

function passingPreflight(): CenterSwitchPreflightResult {
  return {
    ok: true,
    blockingCodes: [],
    checks: [
      { check: "trigger_source", passed: true, code: "ok", detail: "operator admitted" },
      { check: "node_identity", passed: true, code: "ok", detail: "center -> edge-node-b" },
      { check: "tls_reachable", passed: true, code: "ok", detail: "https://edge-b.local:7545 reachable" },
      { check: "replica_healthy", passed: true, code: "ok", detail: "lag=0 rev" },
      { check: "auth_reachable", passed: true, code: "ok", detail: "https://auth.local reachable" },
      { check: "symmetric_readiness", passed: true, code: "ok", detail: "symmetric identity ready" },
    ],
  };
}

function blockingPreflight(): CenterSwitchPreflightResult {
  return {
    ok: false,
    blockingCodes: ["target_tls_unreachable", "source_symmetric_identity_missing"],
    checks: [
      { check: "trigger_source", passed: true, code: "ok", detail: "operator admitted" },
      { check: "node_identity", passed: true, code: "ok", detail: "center -> edge-node-b" },
      {
        check: "tls_reachable",
        passed: false,
        code: "target_tls_unreachable",
        detail: "TLS probe timed out for https://edge-b.local:7545",
      },
      { check: "replica_healthy", passed: true, code: "ok", detail: "lag=0 rev" },
      { check: "auth_reachable", passed: true, code: "ok", detail: "https://auth.local reachable" },
      {
        check: "symmetric_readiness",
        passed: false,
        code: "source_symmetric_identity_missing",
        detail: "Missing center-node-identity/repo-switch.json",
      },
    ],
  };
}

function renderCollab(props: {
  readonly mode?: "local" | "remote-center" | "remote-edge";
  readonly overview?: FleetOverviewRead | null;
  readonly overviewError?: string | null;
  readonly canManageFleetNodes?: boolean;
  readonly onCenterSwitch?: (input: CenterSwitchInput) => Promise<CenterSwitchReply>;
  readonly onPromoteFromEdge?: (input: PromoteFromEdgeInput) => Promise<PromoteFromEdgeReply>;
  readonly onReadEdgeLocalState?: (repoId: string) => Promise<CenterSettingsReply<EdgeLocalState>>;
  readonly onCenterChanged?: () => void;
}) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  act(() => {
    root.render(
      <CollaborationView
        repoId="repo-switch"
        mode={props.mode ?? "local"}
        overview={props.overview === undefined ? overviewFixture() : props.overview}
        overviewError={props.overviewError ?? null}
        canManageFleetNodes={props.canManageFleetNodes ?? true}
        onOpenTask={() => {}}
        onNavigateEntity={() => {}}
        onCenterSwitch={props.onCenterSwitch}
        onPromoteFromEdge={props.onPromoteFromEdge}
        onReadEdgeLocalState={props.onReadEdgeLocalState}
        onCenterChanged={props.onCenterChanged}
        now="2026-11-24T00:01:00.000Z"
      />,
    );
  });
  return {
    host,
    click: async (selector: string) => {
      const target = host.querySelector<HTMLElement>(selector);
      expect(target, `missing click target ${selector}`).not.toBeNull();
      await act(async () => {
        target!.click();
        await Promise.resolve();
      });
    },
    flush: async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
  };
}

describe("Slice 3 GUI: 候选预检、一键设为中心与离线破窗", () => {
  it("仅在 local 模式、管理员权限且选中 edge 节点时显示「设为中心」入口", async () => {
    const onCenterSwitch = vi.fn(async () => ({ ok: true as const, dryRun: true, preflight: passingPreflight() }));

    // Case 1: local + admin + edge -> visible
    const okView = renderCollab({ mode: "local", canManageFleetNodes: true, onCenterSwitch });
    await okView.click('[data-testid="collaboration-node-edge-node-b"]');
    expect(okView.host.querySelector('[data-testid="collaboration-node-set-center"]')).not.toBeNull();
    // Selecting center node hides button
    await okView.click('[data-testid="collaboration-node-center"]');
    expect(okView.host.querySelector('[data-testid="collaboration-node-set-center"]')).toBeNull();

    // Case 2: non-admin -> hidden
    const nonAdmin = renderCollab({ mode: "local", canManageFleetNodes: false, onCenterSwitch });
    await nonAdmin.click('[data-testid="collaboration-node-edge-node-b"]');
    expect(nonAdmin.host.querySelector('[data-testid="collaboration-node-set-center"]')).toBeNull();

    // Case 3: remote-edge -> hidden
    const edgeView = renderCollab({ mode: "remote-edge", canManageFleetNodes: true, onCenterSwitch });
    await edgeView.click('[data-testid="collaboration-node-edge-node-b"]');
    expect(edgeView.host.querySelector('[data-testid="collaboration-node-set-center"]')).toBeNull();
  });

  it("阴性对照：任一预检未通过时禁用确认按钮、以人话展示阻断原因且支持重新检测", async () => {
    const onCenterSwitch = vi
      .fn<(input: CenterSwitchInput) => Promise<CenterSwitchReply>>()
      .mockResolvedValueOnce({
        ok: false,
        code: "target_tls_unreachable",
        phase: "idle",
        preflight: blockingPreflight(),
      })
      .mockResolvedValueOnce({
        ok: true,
        dryRun: true,
        phase: "idle",
        preflight: passingPreflight(),
        state: { switchoverId: "sw_passed_01", oldEpoch: 3, targetEpoch: 4, phase: "idle" },
      });

    const view = renderCollab({ mode: "local", canManageFleetNodes: true, onCenterSwitch });
    await view.click('[data-testid="collaboration-node-edge-node-b"]');
    await view.click('[data-testid="collaboration-node-set-center"]');
    await view.flush();

    expect(onCenterSwitch).toHaveBeenCalledWith({
      repoId: "repo-switch",
      targetNodeId: "edge-node-b",
      dryRun: true,
    });

    const confirmBtn = view.host.querySelector<HTMLButtonElement>('[data-testid="collaboration-switch-confirm"]')!;
    expect(confirmBtn.disabled).toBe(true);

    const tlsRow = view.host.querySelector<HTMLElement>('[data-testid="collaboration-switch-check-tls_reachable"]')!;
    expect(tlsRow.getAttribute("data-passed")).toBe("false");
    expect(tlsRow.getAttribute("data-reason")).toBe("target_tls_unreachable");
    expect(tlsRow.textContent).toContain("网络与 TLS 可达");
    expect(tlsRow.textContent).toContain("未通过");
    // Raw machine code stays in data-reason/title, never leaked into visible prose.
    expect(tlsRow.textContent).not.toContain("target_tls_unreachable");

    // Re-check succeeds and enables confirm button.
    await view.click('[data-testid="collaboration-switch-recheck"]');
    await view.flush();
    expect(onCenterSwitch).toHaveBeenCalledTimes(2);
    expect(view.host.querySelector<HTMLButtonElement>('[data-testid="collaboration-switch-confirm"]')!.disabled).toBe(
      false,
    );
  });

  it("预检全部通过后确认切主，展示进度并完成后回调刷新视图", async () => {
    const onCenterChanged = vi.fn();
    const onCenterSwitch = vi
      .fn<(input: CenterSwitchInput) => Promise<CenterSwitchReply>>()
      .mockResolvedValueOnce({
        ok: true,
        dryRun: true,
        phase: "idle",
        preflight: passingPreflight(),
        state: { switchoverId: "sw_live_01", oldEpoch: 4, targetEpoch: 5, phase: "idle" },
      })
      .mockResolvedValueOnce({
        ok: true,
        dryRun: false,
        phase: "demoted_edge",
        preflight: passingPreflight(),
        state: { switchoverId: "sw_live_01", oldEpoch: 4, targetEpoch: 5, phase: "demoted_edge" },
        activation: { switchoverId: "sw_live_01", newEpoch: 5, finalRevision: 200 },
        demotion: { sourceNodeId: "center", targetNodeId: "edge-node-b", newEpoch: 5, mode: "remote-edge" },
      });

    const view = renderCollab({
      mode: "local",
      canManageFleetNodes: true,
      onCenterSwitch,
      onCenterChanged,
    });
    await view.click('[data-testid="collaboration-node-edge-node-b"]');
    await view.click('[data-testid="collaboration-node-set-center"]');
    await view.flush();

    expect(view.host.querySelector('[data-testid="collaboration-switch-confirm-notice"]')).not.toBeNull();
    await view.click('[data-testid="collaboration-switch-confirm"]');
    await view.flush();

    expect(onCenterSwitch).toHaveBeenNthCalledWith(2, {
      repoId: "repo-switch",
      targetNodeId: "edge-node-b",
      dryRun: false,
      switchoverId: "sw_live_01",
    });
    expect(view.host.querySelector('[data-testid="collaboration-switch-succeeded"]')?.textContent).toContain("#5");
    expect(onCenterChanged).toHaveBeenCalledTimes(1);
  });

  it("fenced_ceded 失败时展示审计回滚面板并可触发 abortRollback", async () => {
    const onCenterChanged = vi.fn();
    const onCenterSwitch = vi
      .fn<(input: CenterSwitchInput) => Promise<CenterSwitchReply>>()
      .mockResolvedValueOnce({
        ok: true,
        dryRun: true,
        phase: "idle",
        preflight: passingPreflight(),
        state: { switchoverId: "sw_fence_01", oldEpoch: 4, targetEpoch: 5, phase: "idle" },
      })
      .mockResolvedValueOnce({
        ok: false,
        code: "target_activation_failed",
        phase: "fenced_ceded",
        fencedCeded: true,
        state: { switchoverId: "sw_fence_01", oldEpoch: 4, targetEpoch: 5 },
        error: { code: "target_activation_failed", hint: "target crashed before activation" },
      })
      .mockResolvedValueOnce({
        ok: true,
        phase: "aborted_rolled_back",
        rollback: { switchoverId: "sw_fence_01", oldEpoch: 4, cededEpoch: 5, rollbackEpoch: 6 },
      });

    const view = renderCollab({ mode: "local", canManageFleetNodes: true, onCenterSwitch, onCenterChanged });
    await view.click('[data-testid="collaboration-node-edge-node-b"]');
    await view.click('[data-testid="collaboration-node-set-center"]');
    await view.flush();
    await view.click('[data-testid="collaboration-switch-confirm"]');
    await view.flush();

    expect(view.host.querySelector('[data-testid="collaboration-switch-rollback-panel"]')).not.toBeNull();
    const rollbackBtn = view.host.querySelector<HTMLButtonElement>(
      '[data-testid="collaboration-switch-rollback-confirm"]',
    )!;
    expect(rollbackBtn.disabled).toBe(true);

    const reasonInput = view.host.querySelector<HTMLInputElement>(
      '[data-testid="collaboration-switch-rollback-reason"]',
    )!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(reasonInput, "Verified target did not activate");
      reasonInput.dispatchEvent(new Event("input", { bubbles: true }));
      reasonInput.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await view.click('[data-testid="collaboration-switch-rollback-confirm"]');
    await view.flush();

    expect(onCenterSwitch).toHaveBeenNthCalledWith(3, {
      repoId: "repo-switch",
      abortRollback: true,
      switchoverId: "sw_fence_01",
      reason: "Verified target did not activate",
    });
    expect(view.host.querySelector('[data-testid="collaboration-switch-rolled-back"]')?.textContent).toContain("#6");
    expect(onCenterChanged).toHaveBeenCalledTimes(1);
  });

  it("切换选中节点时丢弃旧节点的异步预检回调（防 stale async 串台）", async () => {
    let resolveNodeB!: (reply: CenterSwitchReply) => void;
    const nodeBPromise = new Promise<CenterSwitchReply>((resolve) => {
      resolveNodeB = resolve;
    });
    const onCenterSwitch = vi.fn<(input: CenterSwitchInput) => Promise<CenterSwitchReply>>(() => nodeBPromise);

    const view = renderCollab({ mode: "local", canManageFleetNodes: true, onCenterSwitch });
    await view.click('[data-testid="collaboration-node-edge-node-b"]');
    await view.click('[data-testid="collaboration-node-set-center"]');
    expect(view.host.querySelector('[data-testid="collaboration-switch-preflighting"]')).not.toBeNull();

    // Switch to node C before node B's preflight resolves.
    await view.click('[data-testid="collaboration-node-edge-node-c"]');
    expect(view.host.querySelector('[data-testid="collaboration-switch-panel"]')).toBeNull();

    // Now resolve stale node B promise — node C must NOT show node B's preflight result.
    await act(async () => {
      resolveNodeB({ ok: true, dryRun: true, phase: "idle", preflight: passingPreflight() });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.host.querySelector('[data-testid="collaboration-switch-panel"]')).toBeNull();
  });

  it("remote-edge 中心失联（overview=null 且 replica_unavailable）时展示本地状态面板并强制双勾选破窗提升", async () => {
    const onReadEdgeLocalState = vi.fn(async (repoId: string) => ({
      ok: true as const,
      mode: "remote-edge",
      repoId,
      nodeId: "edge-mac-offline",
      configuredCenter: { host: "10.0.1.9", port: 7545 },
      localRevision: 188,
      localSequence: 188,
      writerEpoch: 4,
      syncFailureCode: "replica_unavailable",
      canPromote: true,
    }));
    const onPromoteFromEdge = vi.fn(async (_input: PromoteFromEdgeInput) => ({
      ok: true as const,
      repoId: "repo-switch",
      oldEpoch: 4,
      newEpoch: 5,
      finalRevision: 188,
      nextAction: "Start the new center and repoint edges explicitly.",
    }));
    const onCenterChanged = vi.fn();

    const view = renderCollab({
      mode: "remote-edge",
      overview: null,
      overviewError: "replica_unavailable",
      onReadEdgeLocalState,
      onPromoteFromEdge,
      onCenterChanged,
    });
    await view.flush();

    expect(onReadEdgeLocalState).toHaveBeenCalledWith("repo-switch");
    const panel = view.host.querySelector('[data-testid="collaboration-offline-break-glass"]')!;
    expect(panel).not.toBeNull();
    expect(panel.querySelector('[data-testid="collaboration-edge-local-node"]')?.textContent).toBe("edge-mac-offline");
    expect(panel.querySelector('[data-testid="collaboration-edge-local-center"]')?.textContent).toBe("10.0.1.9:7545");
    expect(panel.querySelector('[data-testid="collaboration-edge-local-watermark"]')?.textContent).toContain("188");
    expect(panel.textContent).not.toContain("credential");

    // Expand break-glass confirmation form.
    await view.click('[data-testid="collaboration-break-glass-toggle"]');
    const submitBtn = () =>
      view.host.querySelector<HTMLButtonElement>('[data-testid="collaboration-break-glass-submit"]')!;
    const cb1 = () =>
      view.host.querySelector<HTMLInputElement>('[data-testid="collaboration-break-glass-confirm-tail-loss"]')!;
    const cb2 = () =>
      view.host.querySelector<HTMLInputElement>('[data-testid="collaboration-break-glass-confirm-new-epoch"]')!;

    // Negative controls: 0 checked -> disabled; only 1 checked -> still disabled; no auto promotion!
    expect(submitBtn().disabled).toBe(true);
    expect(onPromoteFromEdge).not.toHaveBeenCalled();

    await view.click('[data-testid="collaboration-break-glass-confirm-tail-loss"]');
    expect(cb1().checked).toBe(true);
    expect(cb2().checked).toBe(false);
    expect(submitBtn().disabled).toBe(true);

    // Check second box -> enabled.
    await view.click('[data-testid="collaboration-break-glass-confirm-new-epoch"]');
    expect(cb2().checked).toBe(true);
    expect(submitBtn().disabled).toBe(false);

    // Submit break-glass promotion.
    await view.click('[data-testid="collaboration-break-glass-submit"]');
    await view.flush();

    expect(onPromoteFromEdge).toHaveBeenCalledWith({
      repoId: "repo-switch",
      forceNewEpoch: true,
      confirmPossibleTailLoss: true,
    });
    expect(view.host.querySelector('[data-testid="collaboration-break-glass-succeeded"]')?.textContent).toContain("#5");
    expect(onCenterChanged).toHaveBeenCalledTimes(1);
  });

  it("纯授权拒绝（authorization_denied）不误触发离线破窗面板", async () => {
    const onReadEdgeLocalState = vi.fn();
    const view = renderCollab({
      mode: "remote-edge",
      overview: null,
      overviewError: "authorization_denied",
      onReadEdgeLocalState,
    });
    await view.flush();
    expect(view.host.querySelector('[data-testid="collaboration-offline-break-glass"]')).toBeNull();
    expect(onReadEdgeLocalState).not.toHaveBeenCalled();
  });
});
