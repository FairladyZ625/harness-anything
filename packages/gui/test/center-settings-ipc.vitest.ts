// harness-test-tier: fast
import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { registerCenterSettingsIpc } from "../src/main/center-settings-ipc.ts";

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
});
