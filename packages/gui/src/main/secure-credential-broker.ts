import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { credentialPort, type CredentialCommand, type CredentialPort } from "../../../daemon/src/agent-runtime-credential-port.ts";

// The native credential broker collects an API key through the platform's own
// masked-input prompt (macOS osascript dialog, Windows Get-Credential dialog,
// Linux zenity) and stores it through the shared backend-agnostic credential
// port, so the daemon only ever receives the opaque `credential:v1:` reference.
// The prompt surface is a per-platform command builder with an injectable
// platform parameter; no branch reads process.platform at call sites.
type Kind = "claude" | "codex"; type CreatePayload = { readonly instanceId: string; readonly name: string; readonly kindId: Kind; readonly installationId: string; readonly providerId: string; readonly model: string; readonly reasoningEffort?: string; readonly baseUrl?: string; readonly authMode: "subscription" | "api-key" }; type Receipt = Readonly<Record<string, unknown>>;
export interface NativeCredentialBroker { readonly promptAndStore: (kindId: Kind) => Promise<string> }
export function createRuntimeInstanceCredentialController(input: { readonly broker?: NativeCredentialBroker; readonly create: (payload: Record<string, unknown>) => Promise<Receipt> }) { const broker = input.broker ?? nativeCredentialBroker(); return { create: async (payload: CreatePayload): Promise<Receipt> => { if (payload.authMode === "subscription") return input.create(payload); let credentialRef: string; try { credentialRef = await broker.promptAndStore(payload.kindId); } catch { return unavailable("secure_prompt_unavailable", "The native secure credential prompt or vault store is unavailable on this system; the instance was not created."); } return input.create({ ...payload, credentialRef }); } }; }
export function nativeCredentialBroker(platform: NodeJS.Platform = process.platform, port: CredentialPort = credentialPort(platform), prompt: (command: CredentialCommand) => Promise<string> = runCredentialPrompt): NativeCredentialBroker { return { promptAndStore: async (kindId) => { const secret = (await prompt(credentialPromptCommand(platform, kindId))).replace(/[\r\n]+$/u, ""); if (!secret) throw coded("secure_prompt_unavailable"); const reference = port.issue(); port.store(reference, secret); return reference; } }; }
export function credentialPromptCommand(platform: NodeJS.Platform, kindId: Kind): CredentialCommand {
  if (platform === "darwin") return { file: "/usr/bin/osascript", args: ["-e", `set answer to display dialog "Configure ${kindId} API credential" default answer "" with hidden answer buttons {"Cancel", "Save"} default button "Save"\nreturn text returned of answer`] };
  if (platform === "win32") return { file: "powershell.exe", args: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(windowsPromptScript(kindId), "utf16le").toString("base64")] };
  if (platform === "linux") return { file: "zenity", args: ["--password", "--title", `Configure ${kindId} API credential`] };
  throw coded("secure_prompt_unavailable");
}
async function runCredentialPrompt(command: CredentialCommand): Promise<string> { const { stdout } = await promisify(execFile)(command.file, [...command.args], { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 }); return stdout; }
function windowsPromptScript(kindId: Kind): string { return `$ErrorActionPreference = 'Stop'
$credential = Get-Credential -Message 'Configure ${kindId} API credential' -UserName 'api-key'
if (-not $credential) { exit 3 }
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($credential.Password)
try { [Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
exit 0
`; }
function unavailable(code: string, hint: string): Receipt { return { schema: "command-receipt/v2", ok: false, command: "runtime-instance-create", outcome: "op_rejected", opId: `runtime-instance-create:${randomUUID()}`, code, origin: "electron-main", evidence: `rejection:${code}`, error: { code, hint }, nextAction: hint }; }
function coded(code: string): Error { return Object.assign(new Error(code), { code }); }
