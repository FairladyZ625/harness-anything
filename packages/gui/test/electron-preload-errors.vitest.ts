// harness-test-tier: fast
import { beforeAll, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  exposed: undefined as Record<string, unknown> | undefined,
  invoke: vi.fn(),
}));

vi.mock("electron", () => ({
  contextBridge: {
    exposeInMainWorld: (_name: string, api: Record<string, unknown>) => {
      electron.exposed = api;
    },
  },
  ipcRenderer: {
    invoke: electron.invoke,
  },
}));

describe("Electron preload IPC errors", () => {
  beforeAll(async () => {
    await import("../src/preload/electron-preload.ts");
  });

  it("exposes the main-process error without Electron's internal invoke prefix", async () => {
    electron.invoke.mockRejectedValueOnce(
      new Error("Error invoking remote method 'harness:auth:configure': Error: bootstrap_failed: fetch failed"),
    );
    const auth = electron.exposed?.auth as { configure(input: unknown): Promise<unknown> };

    const invocation = auth.configure({ mode: "managed" });
    await expect(invocation).rejects.toThrow("bootstrap_failed: fetch failed");
    await expect(invocation).rejects.not.toThrow("Error invoking remote method");
  });
});
