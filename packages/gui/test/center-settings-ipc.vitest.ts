// harness-test-tier: fast
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { writeDaemonRegistryRepo } from "@harness-anything/kernel/daemon-registry";
import { removeTempRepository } from "../../../tools/fixtures/remove-temp-repository.ts";
import { registerCenterSettingsIpc } from "../src/main/center-settings-ipc.ts";
import { createCenterSwitchPort } from "../src/main/center-switch-port.ts";
import { centerSettingsPreloadApi } from "../src/preload/center-settings-preload.ts";

describe("center settings IPC", () => {
  function fixture() {
    let handler: ((event: IpcMainInvokeEvent, input?: unknown) => Promise<unknown>) | undefined;
    const calls: Record<string, unknown>[] = [];
    registerCenterSettingsIpc(
      {
        handle: (_channel, listener) => {
          handler = listener;
        },
      },
      { isTrustedWebContentsId: (id) => id === 7, rendererUrl: { packagedRendererUrl: "file:///renderer/index.html" } },
      {
        daemonRequest: async (params) => {
          calls.push(params);
          return {
            ok: true,
            command: "rbac-listener",
            certificateMode: "internal-ca",
            listener: {
              address: "10.0.0.2",
              hostname: "center.example.test",
              port: 8443,
              certificateFile: "/tmp/center.pem",
              certificateKeyFile: "/tmp/center.key",
            },
            version: "v1",
          };
        },
        fleetRequest: async (method, params) => {
          calls.push({ method, ...params });
          return { ok: true, externalUrl: "https://center.example.test:7545", warning: null };
        },
        centerSwitch: async (input) => {
          calls.push({ port: "centerSwitch", ...input });
          return { ok: true, dryRun: input.abortRollback ? false : input.dryRun, phase: "idle" };
        },
        promoteFromEdge: async (input) => {
          calls.push({ port: "promoteFromEdge", ...input });
          return { ok: true, repoId: input.repoId, newEpoch: 7 };
        },
        edgeLocalState: async (repoId) => {
          calls.push({ port: "edgeLocalState", repoId });
          return {
            ok: true,
            mode: "remote-edge",
            repoId,
            nodeId: "edge-mac-01",
            configuredCenter: { host: "10.0.0.5", port: 7545, extraSecret: "must-not-leak" } as unknown as {
              host: string;
              port: number;
            },
            localRevision: 42,
            localSequence: 42,
            writerEpoch: 3,
            syncFailureCode: "replica_unavailable",
            canPromote: true,
            credential: "top-secret-machine-credential",
            token: "bearer-secret",
          } as unknown as Record<string, unknown> as never;
        },
        dialog: { selectFile: async () => "/tmp/selected.pem" },
      },
    );
    const sender = Object.assign(new EventEmitter(), { id: 7 });
    const event = { sender, senderFrame: { url: "file:///renderer/index.html" } } as IpcMainInvokeEvent;
    return {
      calls,
      event,
      get handler() {
        return handler!;
      },
    };
  }

  it("forwards closed listener settings and never returns the private-key path", async () => {
    const f = fixture();
    const reply = (await f.handler(f.event, { operation: "listener" })) as Record<string, unknown>;
    expect(f.calls).toEqual([{ operation: "listener" }]);
    expect(reply.listener).not.toHaveProperty("certificateKeyFile");
    await expect(
      f.handler(f.event, {
        operation: "listener-set",
        expectedVersion: "v1",
        certificateMode: "internal-ca",
        hostname: "center.example.test",
        port: 8443,
        certificateFile: "/tmp/center.pem",
        certificateKeyFile: "/tmp/center.key",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(f.calls.at(-1)).toMatchObject({ operation: "listener-set", certificateKeyFile: "/tmp/center.key" });
  });

  it("rejects unknown fields and certificate files in self-signed mode", async () => {
    const f = fixture();
    await expect(
      f.handler(f.event, {
        operation: "listener-set",
        expectedVersion: "v1",
        certificateMode: "self-signed",
        extra: true,
      }),
    ).rejects.toThrow(/does not take extra/u);
    await expect(
      f.handler(f.event, {
        operation: "listener-set",
        expectedVersion: "v1",
        certificateMode: "self-signed",
        certificateKeyFile: "/tmp/key",
      }),
    ).rejects.toThrow(/manages its own/u);
  });

  it("reads and saves only the center external URL through the fleet configuration endpoint", async () => {
    const f = fixture();
    await expect(f.handler(f.event, { operation: "external-address" })).resolves.toMatchObject({
      externalUrl: "https://center.example.test:7545",
    });
    await expect(
      f.handler(f.event, { operation: "external-address-set", externalUrl: "https://center.example.test:7545" }),
    ).resolves.toMatchObject({ ok: true });
    expect(f.calls.at(-1)).toEqual({
      method: "daemon.fleet.center.external-address.set",
      payload: { externalUrl: "https://center.example.test:7545" },
    });
  });

  it("forwards the fleet status read through the fleet status endpoint", async () => {
    const f = fixture();
    await expect(f.handler(f.event, { operation: "fleet-status" })).resolves.toMatchObject({ ok: true });
    expect(f.calls.at(-1)).toEqual({ method: "daemon.fleet.center.read", payload: {} });
    await expect(f.handler(f.event, { operation: "fleet-status", extra: 1 })).rejects.toThrow(/takes no fields/u);
  });

  it("starts the center through the fleet start endpoint without any certificate field", async () => {
    const f = fixture();
    await expect(
      f.handler(f.event, {
        operation: "center-start",
        port: 7545,
        repoId: "canonical",
        quotaBytes: 1024,
        bind: "0.0.0.0",
        externalUrl: "https://center.example.test:7545",
      }),
    ).resolves.toMatchObject({ ok: true });
    const forwarded = f.calls.at(-1) as { method: string; payload: Record<string, unknown> };
    expect(forwarded.method).toBe("daemon.fleet.center.start");
    // The certificate pair never crosses this IPC: the daemon resolves the login listener pair.
    expect(forwarded.payload).toEqual({
      port: 7545,
      repoId: "canonical",
      quotaBytes: 1024,
      bind: "0.0.0.0",
      externalUrl: "https://center.example.test:7545",
    });
    await expect(f.handler(f.event, { operation: "center-start", keyPath: "/tmp/key" })).rejects.toThrow(
      /does not take keyPath/u,
    );
    await expect(
      f.handler(f.event, { operation: "center-start", port: 0, repoId: "canonical", quotaBytes: 1, bind: "0.0.0.0" }),
    ).rejects.toThrow(/between 1 and 65535/u);
    await expect(
      f.handler(f.event, {
        operation: "center-start",
        port: 7545,
        repoId: "Canonical",
        quotaBytes: 1,
        bind: "0.0.0.0",
      }),
    ).rejects.toThrow(/authority repository/u);
    await expect(
      f.handler(f.event, { operation: "center-start", port: 7545, repoId: "canonical", quotaBytes: 1, bind: "eth0" }),
    ).rejects.toThrow(/interfaces or loopback/u);
  });

  it("validates center-switch allowlist for dryRun preflight, live switch, and audited rollback", async () => {
    const f = fixture();
    await expect(
      f.handler(f.event, {
        operation: "center-switch",
        repoId: "canonical",
        targetNodeId: "edge-node-b",
        dryRun: true,
      }),
    ).resolves.toMatchObject({ ok: true, dryRun: true });
    expect(f.calls.at(-1)).toEqual({
      port: "centerSwitch",
      repoId: "canonical",
      targetNodeId: "edge-node-b",
      dryRun: true,
    });

    await expect(
      f.handler(f.event, {
        operation: "center-switch",
        repoId: "canonical",
        abortRollback: true,
        switchoverId: "sw_12345",
        reason: "Confirmed target never activated",
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(f.calls.at(-1)).toEqual({
      port: "centerSwitch",
      repoId: "canonical",
      abortRollback: true,
      switchoverId: "sw_12345",
      reason: "Confirmed target never activated",
    });

    // Reject unknown host path or credential smuggling fields.
    await expect(
      f.handler(f.event, {
        operation: "center-switch",
        repoId: "canonical",
        targetNodeId: "edge-node-b",
        dryRun: true,
        root: "/etc",
      }),
    ).rejects.toThrow(/does not take root/u);
    await expect(
      f.handler(f.event, {
        operation: "center-switch",
        repoId: "canonical",
        targetNodeId: "edge-node-b",
        dryRun: "yes",
      }),
    ).rejects.toThrow(/boolean dryRun/u);
    await expect(
      f.handler(f.event, {
        operation: "center-switch",
        repoId: "canonical",
        abortRollback: true,
        switchoverId: "sw_12345",
        reason: "   ",
      }),
    ).rejects.toThrow(/non-empty reason/u);
  });

  it("hard-enforces double confirmation on promote-from-edge at the main IPC boundary", async () => {
    const f = fixture();
    await expect(
      f.handler(f.event, {
        operation: "promote-from-edge",
        repoId: "canonical",
        forceNewEpoch: true,
        confirmPossibleTailLoss: true,
      }),
    ).resolves.toMatchObject({ ok: true, repoId: "canonical", newEpoch: 7 });
    expect(f.calls.at(-1)).toEqual({
      port: "promoteFromEdge",
      repoId: "canonical",
      forceNewEpoch: true,
      confirmPossibleTailLoss: true,
    });

    // Negative controls: omitting or setting false on either boolean MUST be rejected before reaching the port.
    const callsBefore = f.calls.length;
    await expect(
      f.handler(f.event, {
        operation: "promote-from-edge",
        repoId: "canonical",
        forceNewEpoch: true,
        confirmPossibleTailLoss: false,
      }),
    ).rejects.toThrow(/forceNewEpoch=true and confirmPossibleTailLoss=true/u);
    await expect(
      f.handler(f.event, {
        operation: "promote-from-edge",
        repoId: "canonical",
        forceNewEpoch: false,
        confirmPossibleTailLoss: true,
      }),
    ).rejects.toThrow(/forceNewEpoch=true and confirmPossibleTailLoss=true/u);
    await expect(
      f.handler(f.event, {
        operation: "promote-from-edge",
        repoId: "canonical",
      }),
    ).rejects.toThrow(/forceNewEpoch=true and confirmPossibleTailLoss=true/u);
    await expect(
      f.handler(f.event, {
        operation: "promote-from-edge",
        repoId: "canonical",
        forceNewEpoch: true,
        confirmPossibleTailLoss: true,
        credential: "smuggled",
      }),
    ).rejects.toThrow(/does not take credential/u);
    expect(f.calls.length).toBe(callsBefore);
  });

  it("sanitizes edge-local-state replies so credentials and extra fields never cross IPC", async () => {
    const f = fixture();
    const preload = centerSettingsPreloadApi((_channel, req) => f.handler(f.event, req));
    const reply = await preload.edgeLocalState!({ repoId: "canonical" });
    expect(reply).toEqual({
      ok: true,
      mode: "remote-edge",
      repoId: "canonical",
      nodeId: "edge-mac-01",
      configuredCenter: { host: "10.0.0.5", port: 7545 },
      localRevision: 42,
      localSequence: 42,
      writerEpoch: 3,
      syncFailureCode: "replica_unavailable",
      canPromote: true,
    });
    expect(JSON.stringify(reply)).not.toContain("top-secret-machine-credential");
    expect(JSON.stringify(reply)).not.toContain("bearer-secret");
    expect(JSON.stringify(reply)).not.toContain("must-not-leak");
  });

  it("reads local edge state purely from disk when the configured center is offline and omits credentials", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "ha-gui-edge-local-"));
    try {
      const userRoot = path.join(root, "user-root");
      const repoRoot = path.join(root, "repo");
      mkdirSync(path.join(repoRoot, "harness"), { recursive: true });
      writeFileSync(path.join(repoRoot, "harness", "harness.yaml"), "schema: harness-config/v1\n", "utf8");
      writeDaemonRegistryRepo({
        canonicalRoot: repoRoot,
        repoId: "offline-repo",
        authoredBranch: "main",
        mode: "remote-edge",
        userRoot,
        createConvenienceLinks: false,
      });
      const edgeDir = path.join(userRoot, "fleet", "edge", "offline-repo");
      mkdirSync(edgeDir, { recursive: true });
      const viewRoot = path.join(userRoot, "fleet", "views");
      writeFileSync(
        path.join(edgeDir, "fleet-edge.json"),
        JSON.stringify(
          {
            schema: "fleet-edge-config/v1",
            repoId: "offline-repo",
            host: "127.0.0.1",
            port: 1,
            caPath: path.join(edgeDir, "fleet-center-ca.pem"),
            nodeId: "edge-offline-01",
            credential: "machine-secret-do-not-expose",
            writerEpoch: 5,
            viewRoot,
            quotaBytes: 64 * 1024 * 1024,
          },
          null,
          2,
        ),
        "utf8",
      );
      const port = createCenterSwitchPort({ userRoot: () => userRoot, readOnly: () => false });
      const state = await port.edgeLocalState("offline-repo");
      expect(state).toEqual({
        ok: true,
        mode: "remote-edge",
        repoId: "offline-repo",
        nodeId: "edge-offline-01",
        configuredCenter: { host: "127.0.0.1", port: 1 },
        localRevision: null,
        localSequence: null,
        writerEpoch: 5,
        syncFailureCode: "replica_unavailable",
        canPromote: false,
      });
      expect(JSON.stringify(state)).not.toContain("machine-secret-do-not-expose");
    } finally {
      removeTempRepository(root);
    }
  });
});
