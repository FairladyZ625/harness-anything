import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { consumeKnownError } from "../../kernel/src/index.ts";

// Backend-agnostic credential port for runtime instances. Callers hand out and
// store opaque references (`credential:v1:<id>`) and never learn which native
// vault holds the secret; platform selection is injectable so every branch is
// unit-testable on any host (same shape as local-daemon-target.ts). Secrets
// travel only through child stdin / stdout pipes: never in argv, never in
// error text, never in receipts. The legacy `keychain:<service>/<account>`
// form keeps resolving on macOS for instances created before this grammar
// existed; other platforms reject it closed. The darwin store writes the
// secret twice because `security add-generic-password -w` reads entry plus
// retype from stdin; a single line exits 0 without storing anything.
export type CredentialRunner = (command: CredentialCommand) => string;
export interface CredentialCommand { readonly file: string; readonly args: readonly string[]; readonly stdin?: string }
export interface CredentialPort { readonly issue: () => string; readonly store: (reference: string, secret: string) => void; readonly resolve: (reference: string) => string }
const namespace = "com.harness-anything.runtime-instance", neutralPattern = /^credential:v1:([a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?)$/u, legacyPattern = /^keychain:([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/u;
const windowsCredentialApi = `using System;using System.Runtime.InteropServices;public class HarnessCredential { [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct CREDENTIAL { public int Flags; public int Type; public string TargetName; public string Comment; public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist; public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName; } [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredWriteW(ref CREDENTIAL credential, uint flags); [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] public static extern bool CredReadW(string target, uint type, uint reserved, out IntPtr credential); [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential); }`;

export function isCredentialReferenceText(text: string): boolean { return neutralPattern.test(text) || legacyPattern.test(text); }
export function credentialPort(platform: NodeJS.Platform = process.platform, run: CredentialRunner = runCredentialCommand): CredentialPort {
  const backend = credentialBackend(platform);
  return {
    issue: () => `credential:v1:${randomUUID().replaceAll("-", "")}`,
    store: (reference, secret) => { const id = neutralPattern.exec(reference)?.[1]; if (!id || !secret) throw credentialUnavailable(backend.hint); attempt(backend.hint, () => run(backend.store(id, secret))); },
    resolve: (reference) => { const command = backend.resolve(reference); return attempt(backend.hint, () => run(command)) || throwCredentialUnavailable(backend.hint); }
  };
}
function runCredentialCommand(command: CredentialCommand): string { return execFileSync(command.file, [...command.args], { encoding: "utf8", stdio: [command.stdin === undefined ? "ignore" : "pipe", "pipe", "ignore"], input: command.stdin, windowsHide: true }).replace(/[\r\n]+$/u, ""); }
// The underlying error (exit status, stderr, ENOENT) is discarded on purpose:
// it can echo command output, so only the fixed per-backend hint ever surfaces.
function attempt(hint: string, work: () => string): string { try { return work(); } catch (error) { consumeKnownError(error); throwCredentialUnavailable(hint); } }

interface CredentialBackend { readonly store: (id: string, secret: string) => CredentialCommand; readonly resolve: (reference: string) => CredentialCommand; readonly hint: string }
function credentialBackend(platform: NodeJS.Platform): CredentialBackend {
  if (platform === "darwin") return {
    store: (id, secret) => ({ file: "/usr/bin/security", args: ["add-generic-password", "-U", "-s", namespace, "-a", id, "-w"], stdin: `${secret}\n${secret}\n` }),
    resolve: (reference) => { const legacy = legacyPattern.exec(reference); return { file: "/usr/bin/security", args: ["find-generic-password", "-w", "-s", legacy?.[1] ?? namespace, "-a", legacy?.[2] ?? requiredId(reference)] }; },
    hint: "macOS keychain access failed for the configured runtime credential."
  };
  if (platform === "linux") return {
    store: (id, secret) => ({ file: "secret-tool", args: ["store", "--label", `harness runtime instance ${id}`, "service", namespace, "account", id], stdin: secret }),
    resolve: (reference) => { if (legacyPattern.test(reference)) throw credentialUnavailable(legacyHint); return { file: "secret-tool", args: ["lookup", "service", namespace, "account", requiredId(reference)] }; },
    hint: "Linux secret service lookup failed; install libsecret-tools (secret-tool) and keep a Secret Service provider such as gnome-keyring running and unlocked."
  };
  if (platform === "win32") return {
    store: (id, secret) => windowsCommand(windowsStoreScript(id), secret),
    resolve: (reference) => { if (legacyPattern.test(reference)) throw credentialUnavailable(legacyHint); return windowsCommand(windowsReadScript(requiredId(reference))); },
    hint: "Windows Credential Manager access failed for the configured runtime credential."
  };
  throw credentialUnavailable(`Native credential storage has no implementation for ${platform}; supported platforms are darwin, linux, and win32.`);
}
const legacyHint = "Legacy keychain: references resolve only on macOS.";
function requiredId(reference: string): string { const id = neutralPattern.exec(reference)?.[1]; if (!id) throw credentialUnavailable("Credential references must use the credential:v1:<id> grammar."); return id; }
function credentialUnavailable(hint: string): Error { return Object.assign(new Error(hint), { code: "runtime_credential_unavailable" }); }
function throwCredentialUnavailable(hint: string): never { throw credentialUnavailable(hint); }
function windowsCommand(script: string, stdin?: string): CredentialCommand { return { file: "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], ...(stdin === undefined ? {} : { stdin }) }; }
function windowsStoreScript(id: string): string { return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition '${windowsCredentialApi}'
$secret = [Console]::In.ReadToEnd().TrimEnd([char]13, [char]10)
if ($secret.Length -eq 0) { exit 4 }
$bytes = [Text.Encoding]::Unicode.GetBytes($secret)
$credential = New-Object HarnessCredential+CREDENTIAL
$credential.Type = 1
$credential.TargetName = '${namespace}/${id}'
$credential.UserName = 'harness'
$credential.Persist = 2
$credential.CredentialBlobSize = $bytes.Length
$pinned = [Runtime.InteropServices.GCHandle]::Alloc($bytes, [Runtime.InteropServices.GCHandleType]::Pinned)
try {
  $credential.CredentialBlob = $pinned.AddrOfPinnedObject()
  if (-not [HarnessCredential]::CredWriteW([ref]$credential, 0)) { exit 5 }
} finally { $pinned.Free() }
exit 0
`; }
function windowsReadScript(id: string): string { return `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition '${windowsCredentialApi}'
$read = [IntPtr]::Zero
if (-not [HarnessCredential]::CredReadW('${namespace}/${id}', 1, 0, [ref]$read)) { exit 2 }
$credential = [Runtime.InteropServices.Marshal]::PtrToStructure($read, [type][HarnessCredential+CREDENTIAL])
try {
  if ($credential.CredentialBlobSize -lt 2) { exit 2 }
  $blob = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $blob, 0, $blob.Length)
  [Console]::OutputEncoding = [Text.Encoding]::UTF8
  [Console]::Out.Write([Text.Encoding]::Unicode.GetString($blob).TrimEnd([char]13, [char]10))
} finally { [HarnessCredential]::CredFree($read) }
exit 0
`; }
