// harness-test-tier: integration
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { credentialPort, type CredentialPort } from "../src/agent-runtime-credential-port.ts";
import { openRuntimeInstanceStore } from "../src/agent-runtime-instance-store.ts";
import { runtimeInstanceCredentialService } from "../src/runtime-instance-credentials.ts";
import { writeProviderExecutable } from "./fixtures/runtime-stub.ts";
import { openDaemonHost } from "../src/daemon-host.ts";
import { localUserDaemonEndpoint, assertRuntimeCredentialEndpoint } from "../src/client/local-daemon-target.ts";
import { createJsonRpcProtocolServer } from "../src/protocol/json-rpc-server.ts";
import { createUnixSocketTransportServer } from "../src/transport/unix-socket.ts";
import { createLocalGuiServiceBridge } from "../../gui/src/main/local-composition-root.ts";

const keyA = "fixture-provider-key-a",
  keyB = "fixture-provider-key-b",
  keyC = "fixture-provider-key-c";
function vault() {
  const secrets = new Map<string, string>(),
    removed: string[] = [];
  let serial = 0;
  const port: CredentialPort = {
    issue: () => `credential:v1:fixture-${++serial}`,
    store: async (ref, secret) => {
      secrets.set(ref, secret);
    },
    resolve: async (ref) => {
      const secret = secrets.get(ref);
      if (!secret) throw new Error("missing fixture credential");
      return secret;
    },
    remove: async (ref) => {
      removed.push(ref);
      secrets.delete(ref);
    },
  };
  return { port, secrets, removed };
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "ha-credential-replacement-")),
    userRoot = path.join(root, "user");
  const executablePath = writeProviderExecutable(
    path.join(root, "provider.mjs"),
    `
import { readFileSync } from 'node:fs'; import path from 'node:path';
const config = process.env.CODEX_HOME ? readFileSync(path.join(process.env.CODEX_HOME, 'config.toml'), 'utf8') : '';
const key = process.env.ANTHROPIC_API_KEY ?? /^\\s*experimental_bearer_token\\s*=\\s*"([^"\\n]+)"/mu.exec(config)?.[1];
process.stdout.write(key === '${keyA}' ? 'a' : key === '${keyB}' ? 'b' : key === '${keyC}' ? 'c' : 'unexpected');
`,
  );
  const installations = (["claude", "codex"] as const).map((kindId) => ({
    kindId,
    installationId: `${kindId}-fixture`,
    executablePath,
    version: "fixture",
    observedAt: "2026-10-02T00:00:00.000Z",
  }));
  const backend = vault(),
    store = openRuntimeInstanceStore({
      userRoot,
      discover: () => installations,
      env: { PATH: process.env.PATH },
      resolveCredential: backend.port.resolve,
    });
  return {
    root,
    userRoot,
    installations,
    backend,
    store,
    service: runtimeInstanceCredentialService(store, backend.port),
  };
}
function create(kindId: string, instanceId = kindId, apiKey = keyA) {
  return {
    kind: "runtime-instance-create",
    instanceId,
    name: instanceId,
    kindId,
    installationId: `${kindId}-fixture`,
    providerId: "fixture-provider",
    models: ["one", "two"],
    defaultModel: "two",
    [kindId]: { baseUrl: "https://example.test/v1" },
    authMode: "api-key",
    apiKey,
  };
}
async function consume(f: ReturnType<typeof fixture>, instanceId: string) {
  const prepared = await f.store.prepareLaunch(instanceId, { cwd: f.root, prompt: "fixture" });
  assert.doesNotMatch(
    JSON.stringify({ args: prepared.args, definition: prepared.definition }),
    /fixture-provider-key-[abc]/u,
  );
  return execFileSync(prepared.executablePath, prepared.args, { env: prepared.env, encoding: "utf8" });
}

for (const kindId of ["claude", "codex"])
  test(`${kindId} replacement preserves metadata, removes the retired item and reaches a real fake-provider process`, async () => {
    const f = fixture();
    try {
      await f.service.command(create(kindId));
      assert.equal(await consume(f, kindId), "a");
      const before = f.store.read(kindId)!;
      const unchanged = await f.service.command({
        kind: "runtime-instance-update",
        instanceId: kindId,
        name: before.name,
      });
      assert.equal(unchanged.credentialChanged, undefined);
      assert.equal(await consume(f, kindId), "a");
      const receipt = await f.service.command({ kind: "runtime-instance-update", instanceId: kindId, apiKey: keyB });
      assert.equal(receipt.credentialChanged, true);
      assert.equal(await consume(f, kindId), "b");
      const after = f.store.read(kindId)!;
      assert.deepEqual({ ...after, auth: before.auth }, before);
      assert.notDeepEqual(after.auth, before.auth);
      assert.doesNotMatch(JSON.stringify(receipt), /fixture-provider-key-[abc]|credentialRef/u);
      assert.doesNotMatch(
        readFileSync(path.join(f.userRoot, "runtime-instances.json"), "utf8"),
        /fixture-provider-key-[abc]/u,
      );
      assert.equal(f.backend.secrets.size, 1);
      assert.equal(f.backend.removed.length, 1);
    } finally {
      rmSync(f.root, { recursive: true, force: true });
    }
  });

test("invalid keys, subscription mode, failed vault and rejected metadata preserve the prior credential", async () => {
  const f = fixture();
  try {
    await f.service.command(create("claude"));
    const before = f.store.read("claude"),
      bytes = readFileSync(path.join(f.userRoot, "runtime-instances.json"), "utf8");
    for (const apiKey of ["", "   ", "line\nline", "nul\u0000key", false, "x".repeat(1281)])
      await assert.rejects(f.service.command({ kind: "runtime-instance-update", instanceId: "claude", apiKey }), {
        code: "invalid_api_key",
      });
    await assert.rejects(
      f.service.command({
        kind: "runtime-instance-update",
        instanceId: "claude",
        defaultModel: "missing",
        apiKey: keyB,
      }),
      { code: "invalid_runtime_model" },
    );
    const failing = runtimeInstanceCredentialService(f.store, {
      ...f.backend.port,
      store: async () => {
        throw Object.assign(new Error("fixture vault unavailable"), { code: "runtime_credential_unavailable" });
      },
    });
    await assert.rejects(failing.command({ kind: "runtime-instance-update", instanceId: "claude", apiKey: keyB }), {
      code: "runtime_credential_unavailable",
    });
    const subscription = { ...create("codex", "subscription"), authMode: "subscription" };
    const { apiKey: _key, ...metadata } = subscription;
    await f.service.command(metadata);
    await assert.rejects(
      f.service.command({ kind: "runtime-instance-update", instanceId: "subscription", apiKey: keyB }),
      { code: "runtime_auth_mode_mismatch" },
    );
    assert.deepEqual(f.store.read("claude"), before);
    assert.ok(bytes.includes("credential:v1:"));
    assert.equal(await consume(f, "claude"), "a");
    assert.equal(f.backend.secrets.size, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("daemon FIFO orders simultaneous replacements and metadata updates; shared references remain usable", async () => {
  const f = fixture();
  try {
    await f.service.command(create("claude"));
    const original = f.store.read("claude")!;
    f.store.create({
      ...original,
      instanceId: "other",
      name: "other",
      githubCredentialRef: original.auth.mode === "api-key" ? original.auth.credentialRef : undefined,
    });
    let entered!: () => void, release!: () => void;
    const storing = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
    const ordered = runtimeInstanceCredentialService(f.store, {
      ...f.backend.port,
      store: async (ref, secret) => {
        if (secret === keyB) {
          entered();
          await blocked;
        }
        await f.backend.port.store(ref, secret);
      },
    });
    const first = ordered.command({ kind: "runtime-instance-update", instanceId: "claude", apiKey: keyB });
    await storing;
    const metadata = ordered.command({ kind: "runtime-instance-update", instanceId: "claude", name: "edited" });
    const second = ordered.command({ kind: "runtime-instance-update", instanceId: "claude", apiKey: keyC });
    assert.equal(await consume(f, "claude"), "a");
    release();
    await Promise.all([first, metadata, second]);
    assert.equal(f.store.read("claude")?.name, "edited");
    assert.equal(await consume(f, "claude"), "c");
    assert.equal(await consume(f, "other"), "a");
    assert.equal(f.backend.secrets.size, 2);
    assert.equal(f.backend.removed.length, 1);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("native remove commands stay reference-scoped and bare remote credential endpoints are rejected", async () => {
  for (const platform of ["darwin", "linux", "win32"] as const) {
    const commands: unknown[] = [];
    await credentialPort(platform, async (command) => {
      commands.push(command);
      return "";
    }).remove("credential:v1:fixture-key");
    assert.equal(commands.length, 1);
    assert.doesNotMatch(JSON.stringify(commands), /fixture-provider-key-[abc]/u);
    assert.match(JSON.stringify(commands), platform === "win32" ? /EncodedCommand/u : /clear|delete-generic-password/u);
  }
  for (const endpoint of ["/tmp/fixture.sock", "tcp://127.0.0.1:9999", "tcp://[::1]:9999", "tcp://localhost:9999"])
    assert.doesNotThrow(() => assertRuntimeCredentialEndpoint(endpoint));
  for (const endpoint of ["tcp://example.test:9999", "tcp://192.0.2.1:9999", "tcp://127.evil.test:9999"])
    assert.throws(() => assertRuntimeCredentialEndpoint(endpoint), { code: "runtime_credential_transport_unsafe" });
});

test("a launch already resolving the old item finishes before replacement cleanup", async () => {
  const f = fixture();
  let entered!: () => void, release!: () => void;
  const resolving = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
  const store = openRuntimeInstanceStore({
    userRoot: f.userRoot,
    discover: () => f.installations,
    resolveCredential: async (reference) => {
      const secret = await f.backend.port.resolve(reference);
      if (secret === keyA) {
        entered();
        await blocked;
      }
      return await f.backend.port.resolve(reference);
    },
  });
  const service = runtimeInstanceCredentialService(store, f.backend.port);
  try {
    await service.command(create("claude"));
    const starting = service.prepareLaunch("claude", { cwd: f.root, prompt: "fixture" });
    await resolving;
    const replacing = service.command({ kind: "runtime-instance-update", instanceId: "claude", apiKey: keyB });
    assert.equal(f.backend.removed.length, 0);
    release();
    const prepared = await starting;
    await replacing;
    assert.equal(execFileSync(prepared.executablePath, prepared.args, { env: prepared.env, encoding: "utf8" }), "a");
    assert.equal(await consume(f, "claude"), "b");
  } finally {
    release();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("readback failure rolls back and retired-item cleanup failure reports successful replacement", async () => {
  const f = fixture();
  try {
    await f.service.command(create("claude"));
    const current = f.store.read("claude")!,
      reference = current.auth.mode === "api-key" ? current.auth.credentialRef : "";
    const unreadable = runtimeInstanceCredentialService(f.store, {
      ...f.backend.port,
      resolve: async (ref) => (ref === reference ? keyA : "mismatch"),
    });
    await assert.rejects(unreadable.command({ kind: "runtime-instance-update", instanceId: "claude", apiKey: keyB }), {
      code: "runtime_credential_unavailable",
    });
    assert.deepEqual(f.store.read("claude"), current);
    assert.deepEqual([...f.backend.secrets.values()], [keyA]);
    const retained = runtimeInstanceCredentialService(f.store, {
      ...f.backend.port,
      remove: async () => {
        throw new Error("fixture cleanup denied");
      },
    });
    const receipt = await retained.command({ kind: "runtime-instance-update", instanceId: "claude", apiKey: keyB });
    assert.equal(receipt.ok, true);
    assert.equal(receipt.credentialCleanup, "retained");
    assert.doesNotMatch(JSON.stringify(receipt), /fixture-provider-key-[abc]|credentialRef/u);
    assert.equal(await consume(f, "claude"), "b");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("real CLI stdin and GUI registry IPC bridge replace through the same isolated daemon", async () => {
  const f = fixture(),
    daemonId = "credential-cli-gui",
    endpoint = localUserDaemonEndpoint(f.userRoot, daemonId);
  const host = await openDaemonHost({
    daemonId,
    userRoot: f.userRoot,
    runtimeCredentialPort: f.backend.port,
    runtimeDiscover: () => f.installations,
    runtimeEnv: { PATH: process.env.PATH },
  });
  const transport = createUnixSocketTransportServer({
    daemonId,
    socketPath: endpoint,
    createProtocolServer: (authContext, emit) =>
      createJsonRpcProtocolServer({ host, build: { commit: null }, authContext, emit }),
  });
  await transport.start();
  const previous = {
    root: process.env.HARNESS_DAEMON_USER_ROOT,
    id: process.env.HARNESS_DAEMON_ID,
    endpoint: process.env.HARNESS_DAEMON_ENDPOINT,
  };
  process.env.HARNESS_DAEMON_USER_ROOT = f.userRoot;
  process.env.HARNESS_DAEMON_ID = daemonId;
  delete process.env.HARNESS_DAEMON_ENDPOINT;
  try {
    const gui = createLocalGuiServiceBridge(f.root);
    const { kind: _kind, ...payload } = create("claude");
    const created = (await gui.invoke("createRuntimeInstance", payload)) as Record<string, unknown>;
    assert.equal(created.ok, true, JSON.stringify(created));
    const cliArgs = [
      path.resolve("packages/cli/src/index.ts"),
      "runtime",
      "instance",
      "update",
      "claude",
      "--api-key-stdin",
      "--json",
    ];
    assert.doesNotMatch(JSON.stringify(cliArgs), /fixture-provider-key-[abc]/u);
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawn(process.execPath, cliArgs, {
        cwd: f.root,
        env: { ...process.env, HARNESS_DAEMON_USER_ROOT: f.userRoot, HARNESS_DAEMON_ID: daemonId },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "",
        stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(`fixture CLI exit ${code}: ${stdout} ${stderr}`)),
      );
      child.stdin.end(`${keyB}\n`);
    });
    const receipt = JSON.parse(output);
    assert.equal(receipt.credentialChanged, true);
    assert.doesNotMatch(output, /fixture-provider-key-[abc]/u);
    const updated = (await gui.invoke("updateRuntimeInstance", { instanceId: "claude", apiKey: keyC })) as Record<
      string,
      unknown
    >;
    assert.equal(updated.ok, true, JSON.stringify(updated));
    assert.doesNotMatch(JSON.stringify(updated), /fixture-provider-key-[abc]/u);
    const metadata = JSON.parse(readFileSync(path.join(f.userRoot, "runtime-instances.json"), "utf8"));
    assert.equal(await f.backend.port.resolve(metadata.instances[0].auth.credentialRef), keyC);
    assert.equal(metadata.instances[0].defaultModel, "two");
    assert.doesNotMatch(JSON.stringify(metadata), /fixture-provider-key-[abc]/u);
    assert.equal(await consume(f, "claude"), "c");
  } finally {
    await transport.stop();
    await host.close();
    for (const [name, value] of [
      ["HARNESS_DAEMON_USER_ROOT", previous.root],
      ["HARNESS_DAEMON_ID", previous.id],
      ["HARNESS_DAEMON_ENDPOINT", previous.endpoint],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    rmSync(f.root, { recursive: true, force: true });
  }
});
