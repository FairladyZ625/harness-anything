// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { credentialPort, isCredentialReferenceText, runCredentialCommand, type CredentialCommand } from "../src/agent-runtime-credential-port.ts";

const namespace = "com.harness-anything.runtime-instance";
type Recorded = { command: CredentialCommand; results: string[] };

function recorder(output = "resolved-secret"): { recorded: Recorded[]; run: (command: CredentialCommand) => Promise<string> } {
  const recorded: Recorded[] = [];
  return { recorded, run: async (command) => { recorded.push({ command, results: [] }); return output; } };
}
function decoded(command: CredentialCommand): string { const encoded = command.args.at(-1); assert.match(String(encoded), /^[A-Za-z0-9+/=]+$/u); return Buffer.from(String(encoded), "base64").toString("utf16le"); }

test("a blocked credential backend does not stop its caller's event loop", async (context) => {
  const run = (_command: CredentialCommand) => runCredentialCommand({ file: process.execPath, args: ["-e", "setTimeout(() => process.stdout.write('resolved-secret'), 200)"] }), port = credentialPort("darwin", run);
  let heartbeats = 0;
  const heartbeat = setInterval(() => { heartbeats += 1; }, 5);
  try { assert.equal(await port.resolve("credential:v1:codex-review"), "resolved-secret"); }
  finally { clearInterval(heartbeat); }
  context.diagnostic(`event-loop-heartbeats-during-credential-command=${heartbeats}`);
  assert.ok(heartbeats > 0, `expected a responsive event loop, observed ${heartbeats} heartbeats`);
});

test("the async credential runner forwards secret material through stdin", async () => {
  const input = "instance-secret\ninstance-secret\n";
  assert.equal(await runCredentialCommand({ file: process.execPath, args: ["-e", "process.stdin.pipe(process.stdout)"], stdin: input }), input.trimEnd());
});

test("darwin backend resolves both reference grammars through the macOS keychain", async () => {
  const { recorded, run } = recorder(), port = credentialPort("darwin", run);
  assert.equal(await port.resolve("credential:v1:codex-review"), "resolved-secret");
  assert.equal(await port.resolve("keychain:custom-service/custom-account"), "resolved-secret");
  assert.deepEqual(recorded.map(({ command }) => command), [
    { file: "/usr/bin/security", args: ["find-generic-password", "-w", "-s", namespace, "-a", "codex-review"] },
    { file: "/usr/bin/security", args: ["find-generic-password", "-w", "-s", "custom-service", "-a", "custom-account"] }
  ]);
});

test("darwin backend stores secrets over stdin (entry plus retype), never in argv", async () => {
  const { recorded, run } = recorder(), port = credentialPort("darwin", run);
  await port.store("credential:v1:claude-review", "instance-secret");
  const command = recorded[0]!.command;
  assert.equal(command.file, "/usr/bin/security");
  assert.deepEqual(command.args, ["add-generic-password", "-U", "-s", namespace, "-a", "claude-review", "-w"]);
  assert.equal(command.stdin, "instance-secret\ninstance-secret\n");
  assert.equal(JSON.stringify(command.args).includes("instance-secret"), false);
});

test("linux backend resolves and stores through the secret service", async () => {
  const { recorded, run } = recorder(), port = credentialPort("linux", run);
  assert.equal(await port.resolve("credential:v1:codex-review"), "resolved-secret");
  await port.store("credential:v1:codex-review", "instance-secret");
  assert.deepEqual(recorded.map(({ command }) => command), [
    { file: "secret-tool", args: ["lookup", "service", namespace, "account", "codex-review"] },
    { file: "secret-tool", args: ["store", "--label", "harness runtime instance codex-review", "service", namespace, "account", "codex-review"], stdin: "instance-secret" }
  ]);
});

test("linux and win32 backends reject legacy keychain references without touching a vault", async () => {
  for (const platform of ["linux", "win32"] as const) {
    const { recorded, run } = recorder(), port = credentialPort(platform, run);
    await assert.rejects(port.resolve("keychain:harness/codex-review"), (error: unknown) => codedAs(error, "runtime_credential_unavailable"));
    assert.equal(recorded.length, 0);
  }
});

test("win32 backend reads and writes Windows Credential Manager generic credentials via PowerShell", async () => {
  const { recorded, run } = recorder(), port = credentialPort("win32", run);
  assert.equal(await port.resolve("credential:v1:codex-review"), "resolved-secret");
  await port.store("credential:v1:codex-review", "instance-secret");
  for (const { command } of recorded) {
    assert.equal(command.file, "powershell.exe");
    assert.deepEqual(command.args.slice(0, 4), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass"]);
    assert.match(command.args[4], /^-EncodedCommand$/u);
    const script = decoded(command);
    assert.match(script, /HarnessCredential/u);
    assert.doesNotMatch(script, /instance-secret|resolved-secret/u);
  }
  assert.match(decoded(recorded[0]!.command), /CredReadW/u);
  assert.match(decoded(recorded[0]!.command), new RegExp(`${namespace}/codex-review`.replaceAll(".", "\\."), "u"));
  assert.match(decoded(recorded[1]!.command), /CredWriteW/u);
  assert.equal(recorded[1]!.command.stdin, "instance-secret");
});

test("failures surface a fixed coded hint and never the backend stderr or secret", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const port = credentialPort(platform, () => runCredentialCommand({ file: process.execPath, args: ["-e", "process.stderr.write('vault-backend-sensitive-output'); process.exit(44)"] }));
    await assert.rejects(port.resolve("credential:v1:codex-review"), (error: unknown) => { assert.equal(codedAs(error, "runtime_credential_unavailable"), true); assert.doesNotMatch((error as Error).message, /vault-backend-sensitive-output|stderr|status/u); return true; });
    await assert.rejects(port.store("credential:v1:codex-review", "instance-secret"), (error: unknown) => codedAs(error, "runtime_credential_unavailable"));
  }
  const silent = credentialPort("linux", async () => "");
  await assert.rejects(silent.resolve("credential:v1:codex-review"), (error: unknown) => codedAs(error, "runtime_credential_unavailable"));
});

test("unsupported platforms and malformed references fail closed", async () => {
  assert.throws(() => credentialPort("freebsd" as NodeJS.Platform, async () => ""), (error: unknown) => codedAs(error, "runtime_credential_unavailable"));
  const { recorded, run } = recorder(), port = credentialPort("linux", run);
  await assert.rejects(port.store("keychain:harness/codex-review", "instance-secret"), (error: unknown) => codedAs(error, "runtime_credential_unavailable"));
  await assert.rejects(port.store("credential:v1:codex-review", ""), (error: unknown) => codedAs(error, "runtime_credential_unavailable"));
  await assert.rejects(port.resolve("credential:v1:../escape"), (error: unknown) => codedAs(error, "runtime_credential_unavailable"));
  assert.equal(recorded.length, 0);
});

test("issued references use the backend-agnostic grammar", () => {
  const port = credentialPort("darwin", async () => "");
  const reference = port.issue();
  assert.match(reference, /^credential:v1:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u);
  assert.equal(isCredentialReferenceText(reference), true);
  assert.equal(isCredentialReferenceText(`credential:v1:${"a".repeat(64)}`), true);
  assert.equal(isCredentialReferenceText("credential:v1:-leading-dash"), false);
  assert.equal(isCredentialReferenceText("keychain:harness/codex-review"), true);
  assert.equal(isCredentialReferenceText("keychain:a/b/c"), false);
  assert.equal(isCredentialReferenceText("plaintext-secret"), false);
  assert.notEqual(port.issue(), port.issue());
});

function codedAs(error: unknown, code: string): boolean { return error instanceof Error && "code" in error && error.code === code; }
