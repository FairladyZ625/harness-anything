// harness-test-tier: contract
import { describe, expect, it, vi } from "vitest";
import { createRuntimeCredentialController } from "../src/main/secure-credential-broker.ts";

describe("main-only runtime credential broker", () => {
  it("never returns the native secret and binds only an opaque reference", async () => {
    const bind = vi.fn(async (payload: Record<string, unknown>) => ({ schema: "runtime-credential-receipt/v1", ok: true, outcome: "applied", operationId: "op", kindId: payload.kindId, credentialState: "configured", baseUrlConfigured: true, error: null, nextAction: null }));
    const controller = createRuntimeCredentialController({ authorityRepoId: "repo-a", broker: { promptAndStore: async () => "keychain:harness/codex" }, bind });
    const receipt = await controller.configure({ kindId: "codex", baseUrl: "https://api.example.test" });
    expect(bind).toHaveBeenCalledWith({ authorityRepoId: "repo-a", kindId: "codex", baseUrl: "https://api.example.test", credentialRef: "keychain:harness/codex" });
    expect(JSON.stringify(receipt)).not.toMatch(/secret|apiKey|token/u);
  });

  it("fails closed when native secure input is unavailable", async () => {
    const controller = createRuntimeCredentialController({ authorityRepoId: "repo-a", broker: { promptAndStore: async () => { throw new Error("unavailable"); } }, bind: vi.fn() });
    const receipt = await controller.configure({ kindId: "claude" });
    expect(receipt).toMatchObject({ ok: false, error: { code: "secure_prompt_unavailable" } });
  });
});
