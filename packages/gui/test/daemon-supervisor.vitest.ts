// harness-test-tier: contract
import { scopedRpcParams } from "@harness-anything/daemon/protocol";
import { describe, expect, it } from "vitest";
import { addLocalMainControls } from "../src/main/local-main-controls.ts";

describe("Electron main daemon lifecycle boundary", () => {
  it("does not create a GUI-owned supervisor for restart requests", async () => {
    const calls: unknown[] = [],
      bridge = addLocalMainControls({
        bridge: {
          stream: (() => () => undefined) as never,
          invoke: async (method, payload) => {
            calls.push({ method, payload });
            return { ok: false, error: { code: "supervisor_required" } };
          },
        },
        target: async () => {
          throw new Error("restart forwarding must not inspect or control the daemon process");
        },
      });
    await expect(
      bridge.invoke(
        "daemon.gui.control.request",
        scopedRpcParams("daemon.gui.control.request", { kind: "restart", authorityRepoId: "repo-a" }),
      ),
    ).resolves.toMatchObject({ error: { code: "supervisor_required" } });
    expect(calls).toEqual([
      {
        method: "daemon.gui.control.request",
        payload: { payload: { kind: "restart", authorityRepoId: "repo-a" } },
      },
    ]);
  });
});
