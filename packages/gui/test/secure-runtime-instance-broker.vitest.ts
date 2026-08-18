// harness-test-tier: contract
import { describe, expect, it, vi } from "vitest";
import { createRuntimeInstanceCredentialController, credentialPromptCommand, nativeCredentialBroker } from "../src/main/secure-credential-broker.ts";

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

describe("native credential broker platform prompts", () => {
  it("builds the per-platform masked prompt command without any secret material", () => {
    const mac = credentialPromptCommand("darwin", "codex");
    expect(mac.file).toBe("/usr/bin/osascript");
    expect(mac.args[0]).toBe("-e");
    expect(String(mac.args[1])).toContain("with hidden answer");
    const linux = credentialPromptCommand("linux", "claude");
    expect(linux).toMatchObject({ file: "zenity", args: ["--password", "--title", "Configure claude API credential"] });
    const windows = credentialPromptCommand("win32", "codex");
    expect(windows.file).toBe("powershell.exe");
    expect(windows.args.slice(0, 3)).toEqual(["-NoProfile", "-ExecutionPolicy", "Bypass"]);
    const script = Buffer.from(String(windows.args.at(-1)), "base64").toString("utf16le");
    expect(script).toContain("Get-Credential");
    expect(script).toContain("SecureStringToBSTR");
    expect(script).not.toContain("-NonInteractive");
    expect(() => credentialPromptCommand("freebsd" as NodeJS.Platform, "codex")).toThrowError(expect.objectContaining({ code: "secure_prompt_unavailable" }));
  });
  it("stores the prompted secret through the credential port and returns only the opaque reference", async () => {
    const stored: { reference: string; secret: string }[] = [];
    const port = { issue: () => "credential:v1:issued-ref", store: (reference: string, secret: string) => { stored.push({ reference, secret }); }, resolve: () => "" };
    const broker = nativeCredentialBroker("win32", port, async () => "instance-secret\n");
    await expect(broker.promptAndStore("codex")).resolves.toBe("credential:v1:issued-ref");
    expect(stored).toEqual([{ reference: "credential:v1:issued-ref", secret: "instance-secret" }]);
  });
  it("fails closed when the prompt yields nothing or the vault store rejects", async () => {
    const port = { issue: () => "credential:v1:issued-ref", store: () => { throw Object.assign(new Error("vault refused"), { code: "runtime_credential_unavailable" }); }, resolve: () => "" };
    await expect(nativeCredentialBroker("linux", port, async () => "\n").promptAndStore("claude")).rejects.toMatchObject({ code: "secure_prompt_unavailable" });
    await expect(nativeCredentialBroker("linux", port, async () => "instance-secret").promptAndStore("claude")).rejects.toMatchObject({ code: "runtime_credential_unavailable" });
  });
});
