// harness-test-tier: contract
import { describe, expect, it, vi, beforeEach } from "vitest";
import { jsonRpcMethodContracts } from "../../daemon/src/protocol/daemon-protocol.contract.ts";

const requests: { method: string; params: Record<string, unknown>; timeoutMs: number | undefined }[] = [];
let reply: (method: string, params: Record<string, unknown>) => Record<string, unknown>;
vi.mock("../../daemon/src/client/local-json-rpc-client.ts", () => ({
  requestDaemonJsonRpcAt: async (_socketPath: string, method: string, params: Record<string, unknown>, timeoutMs?: number) => { requests.push({ method, params, timeoutMs }); return reply(method, params); }
}));

const { addLocalMainControls } = await import("../src/main/local-main-controls.ts");
const registered = new Set(jsonRpcMethodContracts.map((entry) => entry.method));
const instanceRow = { schemaVersion: 2, instanceId: "codex-sidecar", name: "Codex sidecar", kindId: "codex", enabled: true, authMode: "api-key", authReadiness: { status: "ready", code: "runtime_auth_not_checked", hint: null } };
const controls = () => addLocalMainControls({ bridge: { stream: (() => () => undefined) as never, invoke: async () => ({ ok: true }) }, target: async () => ({ repoId: "repo-a", socketPath: "/tmp/socket", userRoot: "/tmp/root", daemonId: "daemon-a" }) });

beforeEach(() => {
  requests.length = 0;
  reply = (method) => method === "daemon.runtimeInstance.list"
    ? { schema: "command-receipt/v2", ok: true, instances: [instanceRow], installations: [] }
    : { schema: "command-receipt/v2", ok: true, instance: { ...instanceRow, authReadiness: { status: "not-ready", code: "runtime_credential_unavailable", hint: "The configured runtime API credential is unavailable." } } };
});

// A GUI main-process call that names a JSON-RPC method the daemon never registered fails
// with a bare "Method not found" that surfaces only as a broken panel. This suite pins the
// method names the runtime-instance surface emits against the daemon's own contract list.
describe("local main controls runtime-instance RPC", () => {
  it("only ever names JSON-RPC methods the daemon protocol registers", async () => {
    const bridge = controls();
    await bridge.invoke("listRuntimeInstances", null);
    await bridge.invoke("showRuntimeInstance", { instanceId: "codex-sidecar" });
    await bridge.invoke("validateRuntimeInstanceAuth", { instanceId: "codex-sidecar" });
    await bridge.invoke("updateRuntimeInstance", { instanceId: "codex-sidecar", enabled: false });
    await bridge.invoke("deleteRuntimeInstance", { instanceId: "codex-sidecar" });
    expect(requests.length).toBeGreaterThan(0);
    const unregistered = [...new Set(requests.map((entry) => entry.method))].filter((method) => !registered.has(method));
    expect(unregistered).toEqual([]);
  });
  it("probes each listed instance through show(probe) and merges the fresh readiness", async () => {
    const listed = await controls().invoke("listRuntimeInstances", null) as { instances: { authReadiness: { code: string } }[] };
    expect(requests.map((entry) => entry.method)).toEqual(["daemon.runtimeInstance.list", "daemon.runtimeInstance.show"]);
    expect(requests[1]!.params).toEqual({ payload: { instanceId: "codex-sidecar", probe: true } });
    expect(listed.instances[0]!.authReadiness.code).toBe("runtime_credential_unavailable");
  });
  it("verifies one instance's authentication through the same probe", async () => {
    await controls().invoke("validateRuntimeInstanceAuth", { instanceId: "codex-sidecar" });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe("daemon.runtimeInstance.show");
    expect(requests[0]!.params).toEqual({ payload: { instanceId: "codex-sidecar", probe: true } });
  });
  it("gives a probe the long timeout and a plain show the short one", async () => {
    const bridge = controls();
    await bridge.invoke("validateRuntimeInstanceAuth", { instanceId: "codex-sidecar" });
    await bridge.invoke("showRuntimeInstance", { instanceId: "codex-sidecar" });
    expect(requests[0]!.timeoutMs).toBe(12_000);
    expect(requests[1]!.timeoutMs).toBe(2_000);
  });
  it("returns a failed list receipt without probing anything", async () => {
    reply = () => ({ schema: "command-receipt/v2", ok: false, error: { code: "runtime_instances_unreadable" } });
    const listed = await controls().invoke("listRuntimeInstances", null) as { ok: boolean };
    expect(listed.ok).toBe(false);
    expect(requests.map((entry) => entry.method)).toEqual(["daemon.runtimeInstance.list"]);
  });
});
