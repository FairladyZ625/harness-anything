// harness-test-tier: contract
import { describe, expect, it, vi } from "vitest";
import { createRuntimeInstanceCredentialController } from "../src/main/secure-credential-broker.ts";

// The vault port is always injected here; the real one talks to the platform
// keychain. The secret below is an obvious stand-in so a leak in any assertion
// output is unmissable.
const secret = "sk-test-secret-must-never-leave-main";
const base = { instanceId: "codex-sidecar", name: "Codex sidecar", kindId: "codex" as const, installationId: "codex-install", providerId: "codex_local_access", model: "gpt-5.6-terra", codex: { baseUrl: "http://localhost:50818/v1", wireApi: "responses", requiresOpenAiAuth: true } };
const appliedReceipt = (instance: Record<string, unknown> = {}) => ({ schema: "command-receipt/v2", ok: true, command: "runtime-instance-create", outcome: "applied", opId: "runtime-instance-create:1", instance: { instanceId: "codex-sidecar", authMode: "api-key", authState: "configured", ...instance }, evidence: JSON.stringify({ instanceId: "codex-sidecar", authMode: "api-key" }), summary: "runtime-instance-create: codex-sidecar", nextAction: null });

describe("main-only runtime instance credential controller", () => {
  it("stores the typed key in the vault and gives the daemon only an opaque reference", async () => {
    const create = vi.fn(async () => appliedReceipt());
    const stored: { reference: string; secret: string }[] = [];
    const controller = createRuntimeInstanceCredentialController({ port: { issue: () => "credential:v1:issued-ref", store: (reference, secret) => { stored.push({ reference, secret }); }, resolve: () => "" }, create });
    const receipt = await controller.create({ ...base, authMode: "api-key", apiKey: `  ${secret}  ` });
    expect(stored).toEqual([{ reference: "credential:v1:issued-ref", secret }]);
    expect(create).toHaveBeenCalledOnce();
    const forwarded = create.mock.calls[0]![0] as Record<string, unknown>;
    expect(forwarded.credentialRef).toBe("credential:v1:issued-ref");
    expect(Object.keys(forwarded)).not.toContain("apiKey");
    expect(JSON.stringify(forwarded)).not.toContain(secret);
    expect(JSON.stringify(receipt)).not.toMatch(new RegExp(secret, "u"));
    expect(JSON.stringify(receipt)).not.toMatch(/credentialRef|apiKey|keychain:/u);
  });
  it("fails closed before daemon create when the vault refuses to store", async () => {
    const create = vi.fn(), controller = createRuntimeInstanceCredentialController({ port: { issue: () => "credential:v1:issued-ref", store: () => { throw Object.assign(new Error("vault refused"), { code: "runtime_credential_unavailable" }); }, resolve: () => "" }, create });
    const receipt = await controller.create({ ...base, authMode: "api-key", apiKey: secret });
    expect(receipt).toMatchObject({ ok: false, error: { code: "runtime_credential_unavailable" } });
    expect(create).not.toHaveBeenCalled();
    expect(JSON.stringify(receipt)).not.toMatch(new RegExp(secret, "u"));
  });
  it("rejects an api-key create that arrives without a key instead of creating a dead instance", async () => {
    const create = vi.fn(), controller = createRuntimeInstanceCredentialController({ port: { issue: () => "credential:v1:issued-ref", store: () => undefined, resolve: () => "" }, create });
    const receipt = await controller.create({ ...base, authMode: "api-key" });
    expect(receipt).toMatchObject({ ok: false, error: { code: "api_key_required" } });
    expect(create).not.toHaveBeenCalled();
  });
  it("forwards subscription creates unchanged with no credential material attached", async () => {
    const create = vi.fn(async () => appliedReceipt({ authMode: "subscription", authState: "unknown" }));
    const controller = createRuntimeInstanceCredentialController({ port: { issue: () => { throw new Error("vault must not be touched"); }, store: () => undefined, resolve: () => "" }, create });
    const receipt = await controller.create({ instanceId: "claude-one", name: "Claude one", kindId: "claude", installationId: "claude-install", providerId: "anthropic", model: "claude-opus", claude: {}, authMode: "subscription" });
    expect(create).toHaveBeenCalledWith(expect.not.objectContaining({ credentialRef: expect.anything() }));
    expect(JSON.stringify(create.mock.calls[0]![0])).not.toMatch(/apiKey|credentialRef|secret/u);
    expect(receipt).toMatchObject({ ok: true });
  });
});
