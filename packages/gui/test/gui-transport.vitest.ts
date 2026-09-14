// harness-test-tier: fast
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserGuiTransport, createElectronGuiTransport } from "../src/renderer/gui-transport.ts";

afterEach(() => vi.unstubAllGlobals());

describe("GUI transport adapters", () => {
  it("drives Electron and browser adapters with the same canonical request", async () => {
    const canonical = { repo: { repoId: "canonical" }, payload: { limit: 1 } } as const;
    const electronRequest = vi.fn(async () => ({ ok: true }));
    await createElectronGuiTransport({ request: electronRequest }).request("repo.tasks.list", canonical, "getTasks");
    expect(electronRequest).toHaveBeenCalledWith("getTasks", { repoId: "canonical", limit: 1 });

    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await createBrowserGuiTransport("secret").request("repo.tasks.list", canonical);
    expect(fetch).toHaveBeenCalledWith(
      "/rpc",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer secret", "Content-Type": "application/json" },
        body: JSON.stringify({ method: "repo.tasks.list", params: canonical }),
      }),
    );
  });

  it("makes unsupported browser capabilities explicit", () => {
    expect(createBrowserGuiTransport("secret").capabilities()).toMatchObject({
      terminal: { status: "unavailable" },
      nativeFiles: { status: "unavailable" },
      writes: { status: "unavailable" },
    });
  });
});
