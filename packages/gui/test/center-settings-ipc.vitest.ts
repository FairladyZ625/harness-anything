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
});
