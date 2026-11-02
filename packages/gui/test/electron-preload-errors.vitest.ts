// harness-test-tier: fast
// @vitest-environment happy-dom
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

it("preserves a structured domain failure and signals collaboration without turning it into success", async () => {
  const notified = vi.fn();
  window.addEventListener("harness-collaboration-required", notified);
  electron.invoke.mockResolvedValueOnce({
    ipcFailure: { code: "identity_plugin_required", message: "Collaboration requires a provider" },
  });
  const auth = electron.exposed?.auth as { configure(input: unknown): Promise<unknown> };
  await expect(auth.configure({ mode: "external" })).rejects.toMatchObject({ code: "identity_plugin_required" });
  expect(notified).toHaveBeenCalledTimes(1);
  window.removeEventListener("harness-collaboration-required", notified);
});
