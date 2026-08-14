// harness-test-tier: contract
import { describe, expect, it, vi } from "vitest";
import { createRuntimeInstanceCredentialController } from "../src/main/secure-credential-broker.ts";

describe("main-only runtime instance credential broker", () => {
  it("never returns the native secret and gives daemon only an opaque reference", async () => {
    const create = vi.fn(async (payload: Record<string, unknown>) => ({ schema: "command-receipt/v2", ok: true, outcome: "applied", instance: { instanceId: payload.instanceId } }));
    const controller = createRuntimeInstanceCredentialController({ broker: { promptAndStore: async () => "keychain:harness/codex-review" }, create });
    const receipt = await controller.create({ instanceId: "codex-review", name: "Codex Review", kindId: "codex", installationId: "installation-codex", providerId: "openai", model: "gpt-5.6-sol", authMode: "api-key" });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ credentialRef: "keychain:harness/codex-review" }));
    expect(JSON.stringify(receipt)).not.toMatch(/keychain:|credentialRef|apiKey|token|host-secret/u);
  });
  it("fails closed before daemon create when native secure input is unavailable", async () => {
    const create = vi.fn(), controller = createRuntimeInstanceCredentialController({ broker: { promptAndStore: async () => { throw new Error("unavailable"); } }, create });
    const receipt = await controller.create({ instanceId: "claude-review", name: "Claude Review", kindId: "claude", installationId: "installation-claude", providerId: "anthropic", model: "claude-opus", authMode: "api-key" });
    expect(receipt).toMatchObject({ ok: false, error: { code: "secure_prompt_unavailable" } }); expect(create).not.toHaveBeenCalled();
  });
});
