// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createElectronGuiTransport, guiTransport, resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";
import { createBrowserGuiTransport } from "../src/browser/browser-gui-transport.ts";

afterEach(() => {
  resetGuiTransportForTest();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

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

    const write = {
      repo: { repoId: "canonical" },
      payload: { locale: "zh-CN", idempotencyKey: "shared-write-fixture" },
    } as const;
    await createElectronGuiTransport({ request: electronRequest }).request(
      "repo.settings.update",
      write,
      "updateSettings",
    );
    expect(electronRequest).toHaveBeenLastCalledWith("updateSettings", {
      repoId: "canonical",
      locale: "zh-CN",
      idempotencyKey: "shared-write-fixture",
    });
    await createBrowserGuiTransport("secret").request("repo.settings.update", write);
    expect(fetch).toHaveBeenLastCalledWith(
      "/rpc",
      expect.objectContaining({ body: JSON.stringify({ method: "repo.settings.update", params: write }) }),
    );
  });

  it("enables canonical writes and makes native browser gaps explicit", () => {
    expect(createBrowserGuiTransport("secret").capabilities()).toMatchObject({
      terminal: { status: "unavailable" },
      nativeFiles: { status: "unavailable" },
      writes: { status: "available" },
    });
  });

  it("retains browser credentials across a same-tab reload after clearing the fragment", async () => {
    window.history.replaceState(null, "", "/#access_token=reload-secret");
    guiTransport();
    expect(window.location.hash).toBe("");

    resetGuiTransportForTest();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await guiTransport().request("system.status.read", {});
    expect(fetch).toHaveBeenCalledWith(
      "/rpc",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer reload-secret" }) }),
    );
  });

  it("preserves broker error codes from non-success HTTP responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: false, error: { code: "daemon_unavailable", hint: "socket absent" } }), {
            status: 502,
          }),
      ),
    );
    await expect(createBrowserGuiTransport("secret").request("system.status.read", {})).rejects.toMatchObject({
      code: "daemon_unavailable",
      message: "socket absent",
    });
  });
});
