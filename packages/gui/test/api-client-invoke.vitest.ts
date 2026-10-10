// harness-test-tier: fast
// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { localErrorHint } from "../src/renderer/result-validation.ts";
import { invoke } from "../src/renderer/api-client-invoke.ts";
import { resetGuiTransportForTest } from "../src/renderer/gui-transport.ts";

afterEach(() => {
  resetGuiTransportForTest();
  window.sessionStorage.clear();
  window.history.replaceState(null, "", "/");
  vi.unstubAllGlobals();
});

/** Drive `invoke` through the real browser transport and return the JSON body it posted. */
async function browserInvoke(
  ...args: readonly unknown[]
): Promise<{ readonly method: string; readonly params: unknown }> {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  window.sessionStorage.setItem("harness.browser.access-token", "secret");
  await (invoke as (...invokeArgs: readonly unknown[]) => Promise<unknown>)(...args);
  const body = JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as RequestInit).body));
  return body as { readonly method: string; readonly params: unknown };
}

// The daemon validates params against the protocol shapes (validateDaemonRpcCall): a method whose
// shape declares `payload` gets "params.payload must be an object" when the key is absent, so the
// renderer must include the envelope exactly when the declaration has it — never omit it when the
// payload fields happen to be empty, and never flatten a payload-only method's fields.
describe("renderer invoke assembles wire params per protocol declaration", () => {
  it("sends an explicit empty payload object for a payload-declaring repo read (repo.decisions.list)", async () => {
    const body = await browserInvoke("repo.decisions.list", { repoId: "canonical" }, "getDecisions");
    expect(body).toEqual({
      method: "repo.decisions.list",
      params: { repo: { repoId: "canonical" }, payload: {} },
    });
  });

  it("keeps caller payload fields inside the envelope", async () => {
    const body = await browserInvoke("repo.tasks.list", { repoId: "canonical", limit: 25 }, "getTasks");
    expect(body.params).toEqual({ repo: { repoId: "canonical" }, payload: { limit: 25 } });
  });

  it("wraps a payload-only (non-repo) method's fields in the payload envelope", async () => {
    const body = await browserInvoke(
      "daemon.gui.control.receipt",
      { operationId: "daemon-control-op" },
      "getDaemonControlReceipt",
    );
    expect(body.params).toEqual({ payload: { operationId: "daemon-control-op" } });
  });

  it("keeps repo-only and empty-input methods free of a payload key", async () => {
    const settings = await browserInvoke("repo.settings.read", { repoId: "canonical" }, "getSettings");
    expect(settings.params).toEqual({ repo: { repoId: "canonical" } });
    const system = await browserInvoke("daemon.gui.system.read", {}, "getSystemStatus");
    expect(system.params).toEqual({});
  });
});

describe("renderer rejection explanation", () => {
  it("preserves the actual edge credential rejection instead of reporting malformed data", () => {
    expect(
      localErrorHint(
        {
          schema: "command-receipt/v2",
          ok: false,
          code: "credential_unknown",
          rejectionExplanation: "Credential is not bound to a person.",
          error: { code: "credential_unknown" },
        },
        "Workspace summary bridge returned an invalid result.",
      ),
    ).toBe("credential_unknown: Credential is not bound to a person.");
  });
  it("retains hint support and ignores errors on successful responses", () => {
    expect(localErrorHint({ ok: false, error: { hint: "Reconnect" } }, "Invalid result")).toBe("Reconnect");
    expect(
      localErrorHint({ ok: true, rejectionExplanation: "Denied", error: { hint: "Denied" } }, "Invalid result"),
    ).toBe("Invalid result");
    // A bare rejection code still names itself; the generic fallback is reserved for
    // values with nothing to extract at all.
    expect(
      localErrorHint({ ok: false, rejectionExplanation: "  ", error: { code: "unknown" } }, "Invalid result"),
    ).toBe("unknown");
  });
});
