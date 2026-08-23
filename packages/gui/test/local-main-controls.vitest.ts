// harness-test-tier: contract
import { beforeEach, describe, expect, it, vi } from "vitest";
import { addLocalMainControls } from "../src/main/local-main-controls.ts";

const rawRequests: string[] = [], invokes: Array<{ readonly method: string; readonly payload: unknown }> = [];
vi.mock("../../daemon/src/client/local-json-rpc-client.ts", () => ({
  requestDaemonJsonRpcAt: async (_socketPath: string, method: string) => { rawRequests.push(method); return { ok: true }; }
}));

const target = async () => ({ repoId: "repo-a", socketPath: "/tmp/socket", userRoot: "/tmp/root", daemonId: "daemon-a" });
const controls = (credentialPort?: Parameters<typeof addLocalMainControls>[0]["credentialPort"]) => addLocalMainControls({
  bridge: { stream: (() => () => undefined) as never, invoke: async (method, payload) => { invokes.push({ method, payload }); return { schema: "command-receipt/v2", ok: true, command: "runtime-instance-create", outcome: "applied", opId: "created" }; } },
  target, clientBuildCommit: null, ...(credentialPort ? { credentialPort } : {})
});

beforeEach(() => { rawRequests.length = 0; invokes.length = 0; });

describe("local main controls runtime-instance boundary", () => {
  it("forwards every non-create runtime call through the registry-derived bridge", async () => {
    const bridge = controls(), calls = [
      ["listRuntimeInstances", { all: true }], ["showRuntimeInstance", { instanceId: "codex-sidecar", probe: true }],
      ["updateRuntimeInstance", { instanceId: "codex-sidecar", enabled: false }], ["deleteRuntimeInstance", { instanceId: "codex-sidecar" }],
      ["signInRuntimeInstance", { repoId: "repo-a", instanceId: "codex-sidecar", idempotencyKey: "login-once" }],
      ["signOutRuntimeInstance", { repoId: "repo-a", instanceId: "codex-sidecar", idempotencyKey: "logout-once" }]
    ] as const;
    for (const [method, payload] of calls) await bridge.invoke(method, payload);
    expect(invokes).toEqual(calls.map(([method, payload]) => ({ method, payload })));
    expect(rawRequests).toEqual([]);
  });

  it("seals the API key before returning create to the registry-derived bridge", async () => {
    const stored: Array<{ readonly reference: string; readonly secret: string }> = [], bridge = controls({ issue: () => "credential:v1:issued-ref", store: async (reference, secret) => { stored.push({ reference, secret }); }, resolve: async () => "" });
    await bridge.invoke("createRuntimeInstance", { instanceId: "codex-sidecar", name: "Codex sidecar", kindId: "codex", installationId: "codex-install", providerId: "openai", models: ["gpt-5.6-sol"], codex: {}, authMode: "api-key", apiKey: "sk-user-input" });
    expect(stored).toEqual([{ reference: "credential:v1:issued-ref", secret: "sk-user-input" }]);
    expect(invokes).toEqual([{ method: "createRuntimeInstance", payload: expect.objectContaining({ credentialRef: "credential:v1:issued-ref" }) }]);
    expect(JSON.stringify(invokes)).not.toContain("sk-user-input");
    expect(rawRequests).toEqual([]);
  });
});
