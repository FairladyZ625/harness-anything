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
    await createElectronGuiTransport({ request: electronRequest }).request("repo.tasks.list", canonical);
    expect(electronRequest).toHaveBeenCalledWith("repo.tasks.list", canonical);

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
    await createElectronGuiTransport({ request: electronRequest }).request("repo.settings.update", write);
    expect(electronRequest).toHaveBeenLastCalledWith("repo.settings.update", write);
    await createBrowserGuiTransport("secret").request("repo.settings.update", write);
    expect(fetch).toHaveBeenLastCalledWith(
      "/rpc",
      expect.objectContaining({ body: JSON.stringify({ method: "repo.settings.update", params: write }) }),
    );
  });

  it("enables canonical writes and makes native browser gaps explicit", () => {
    expect(createBrowserGuiTransport("secret").capabilities()).toMatchObject({
      stream: { status: "available" },
      terminal: { status: "available" },
      nativeFiles: { status: "unavailable" },
      writes: { status: "available" },
    });
  });

  it("delivers a terminal IPC failure through the error callback with its original code", () => {
    const onValue = vi.fn(),
      onError = vi.fn(),
      unsubscribe = vi.fn();
    const transport = createElectronGuiTransport({
      subscribe(_method, _params, receive) {
        receive({ schema: "daemon-stream-failure/v1", code: "invalid_result", hint: "Invalid upstream frame." });
        return unsubscribe;
      },
    });
    const stop = transport.subscribe(
      "repo.agentRuntime.attach",
      { repo: { repoId: "canonical" }, payload: { runtimeSessionId: "runtime" } },
      onValue,
      onError,
    );
    expect(onError).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ code: "invalid_result", message: "Invalid upstream frame." }),
    );
    expect(onValue).not.toHaveBeenCalled();
    stop();
    expect(unsubscribe).toHaveBeenCalledOnce();
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
