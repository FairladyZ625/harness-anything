// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { EdgeJoinSshTunnelManager, validateSshTarget } from "../src/fleet/edge-join-ssh-tunnel.ts";
import { EdgeJoinAdminService } from "../src/access-admin-edge-join.ts";
import { createEdgeJoinStore } from "../src/fleet/edge-join.ts";
import type { OidcSessionService } from "../src/oidc-session-service.ts";
import type { ChildProcess } from "node:child_process";

interface FakeProcess {
  readonly process: ChildProcess;
  readonly data: (value: string) => void;
  readonly exit: (exitCode: number) => void;
  readonly killed: () => boolean;
}

function fakeProcess(options: { readonly exitOnKill?: boolean } = {}): FakeProcess {
  let killed = false;
  const process = new EventEmitter() as EventEmitter & {
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: () => boolean;
    },
    stdout = new PassThrough(),
    stderr = new PassThrough();
  process.exitCode = null;
  process.signalCode = null;
  process.stdout = stdout;
  process.stderr = stderr;
  process.kill = () => {
    killed = true;
    if (options.exitOnKill !== false) {
      process.exitCode = 0;
      process.emit("exit", 0);
    }
    return true;
  };
  return {
    process: process as unknown as ChildProcess,
    data: (value) => stderr.write(value),
    exit: (exitCode) => {
      process.exitCode = exitCode;
      process.emit("exit", exitCode);
    },
    killed: () => killed,
  };
}

test("SSH tunnel uses only the validated target and requests two loopback remote forwards", async () => {
  const child = fakeProcess(),
    states: string[] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: ((command: string, argv: readonly string[]) => {
        assert.equal(command, "ssh");
        assert.ok(argv.includes("BatchMode=yes"));
        assert.ok(!argv.includes("ClearAllForwardings=yes"));
        assert.ok(argv.includes("ForwardAgent=no"));
        assert.equal(argv.at(-1), "macbook-air-via-tencent-prod");
        assert.equal(argv.filter((value) => value === "-R").length, 2);
        assert.equal(
          argv.filter((value, index) => argv[index - 1] === "-R" && value.includes(":0:127.0.0.1:")).length,
          2,
        );
        return child.process;
      }) as never,
      onState: (_target, state) => states.push(state),
    }),
    pending = manager.start({
      target: "macbook-air-via-tencent-prod",
      fleetServicePort: 7545,
      loginServicePort: 18544,
    });
  child.data("Allocated port 41231 for remote forward to 127.0.0.1:7545\r\n");
  child.data("Allocated port 41232 for remote forward to 127.0.0.1:18544\r\n");
  assert.deepEqual(await pending, { fleet: 41231, login: 41232 });
  assert.equal(manager.state("macbook-air-via-tencent-prod"), "connected");
  assert.deepEqual(states, ["connecting", "connected"]);
  await manager.close();
  assert.equal(child.killed(), true);
  assert.equal(manager.state("macbook-air-via-tencent-prod"), "stopped");
});

test("a disconnected SSH tunnel reconnects with its allocated ports and can be released", async () => {
  const children: FakeProcess[] = [],
    scheduled: { callback: () => void; cancelled: boolean; delayMs: number }[] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: ((_command: string, args: readonly string[]) => {
        if (children.length > 0) {
          assert.ok(args.includes("127.0.0.1:41231:127.0.0.1:7545"));
          assert.ok(args.includes("127.0.0.1:41232:127.0.0.1:18544"));
        }
        const child = fakeProcess();
        children.push(child);
        return child.process;
      }) as never,
      schedule: (callback, delayMs) => {
        const item = { callback, cancelled: false, delayMs };
        scheduled.push(item);
        return () => {
          item.cancelled = true;
        };
      },
    });
  const pending = manager.start({
    target: "operator@edge.example",
    fleetServicePort: 7545,
    loginServicePort: 18544,
  });
  children[0]!.data("Allocated port 41231 for remote forward to 127.0.0.1:7545\r\n");
  children[0]!.data("Allocated port 41232 for remote forward to 127.0.0.1:18544\r\n");
  assert.deepEqual(await pending, { fleet: 41231, login: 41232 });
  assert.equal(scheduled[0]!.delayMs, 45_000);
  assert.equal(scheduled[0]!.cancelled, true);
  children[0]!.exit(255);
  assert.equal(manager.state("operator@edge.example"), "reconnecting");
  assert.equal(scheduled[1]!.delayMs, 5_000);
  assert.deepEqual(
    await manager.start({ target: "operator@edge.example", fleetServicePort: 7545, loginServicePort: 18544 }),
    { fleet: 41231, login: 41232 },
  );
  assert.equal(children.length, 1);
  scheduled[1]!.callback();
  assert.equal(children.length, 2);
  children[1]!.data("debug1: remote forward success for: listen 127.0.0.1:41231, connect 127.0.0.1:7545\r\n");
  children[1]!.data("debug1: remote forward success for: listen 127.0.0.1:41232, connect 127.0.0.1:18544\r\n");
  assert.equal(manager.state("operator@edge.example"), "connected");
  manager.release("operator@edge.example");
  assert.equal(children[1]!.killed(), true);
  assert.equal(scheduled[1]!.cancelled, false);
  await manager.close();
});

test("a startup timeout waits for the SSH child to exit before scheduling a replacement", async () => {
  const children: FakeProcess[] = [],
    scheduled: { callback: () => void; cancelled: boolean; delayMs: number }[] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: (() => {
        const child = fakeProcess({ exitOnKill: children.length !== 0 });
        children.push(child);
        return child.process;
      }) as never,
      schedule: (callback, delayMs) => {
        const item = { callback, cancelled: false, delayMs };
        scheduled.push(item);
        return () => {
          item.cancelled = true;
        };
      },
    });
  const pending = manager.start({ target: "operator@edge.example", fleetServicePort: 7545, loginServicePort: 18544 });
  assert.equal(scheduled[0]!.delayMs, 45_000);
  scheduled[0]!.callback();
  await assert.rejects(pending, { code: "edge_join_ssh_failed", message: /within 45 seconds/u });
  assert.equal(children[0]!.killed(), true);
  assert.equal(manager.state("operator@edge.example"), "reconnecting");
  assert.equal(children.length, 1);
  assert.equal(scheduled.length, 1);

  children[0]!.exit(143);
  assert.equal(scheduled[1]!.delayMs, 5_000);
  scheduled[1]!.callback();
  assert.equal(children.length, 2);
  await manager.close();
});

test("a synchronous OpenSSH spawn failure is surfaced and scheduled for reconnect", async () => {
  const scheduled: { callback: () => void; cancelled: boolean; delayMs: number }[] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: (() => {
        throw new Error("spawn denied");
      }) as never,
      schedule: (callback, delayMs) => {
        const item = { callback, cancelled: false, delayMs };
        scheduled.push(item);
        return () => {
          item.cancelled = true;
        };
      },
    }),
    pending = manager.start({ target: "operator@edge.example", fleetServicePort: 7545, loginServicePort: 18544 });

  await assert.rejects(pending, { message: "spawn denied" });
  assert.equal(manager.state("operator@edge.example"), "reconnecting");
  assert.equal(scheduled[0]!.delayMs, 5_000);
  assert.equal(scheduled[0]!.cancelled, false);
  await manager.close();
});

test("SSH targets reject options, commands, and shell syntax", () => {
  assert.equal(validateSshTarget(" macbook-air-via-tencent-prod "), "macbook-air-via-tencent-prod");
  assert.equal(validateSshTarget("edge-user@edge.example"), "edge-user@edge.example");
  for (const target of ["-oProxyCommand=bad", "edge; touch /tmp/pwned", "user@host command", "user@host:22"])
    assert.throws(() => validateSshTarget(target), { code: "edge_join_ssh_target_invalid" });
});

test("an expired pending invitation releases its shared SSH tunnel", async () => {
  let now = Date.parse("2026-10-22T00:00:00.000Z");
  const journal: string[] = [],
    store = createEdgeJoinStore({ now: () => new Date(now).toISOString() }),
    created = store.create({
      centerOrigin: "https://127.0.0.1:41231",
      transport: "ssh-reverse",
      centerServername: "center.example",
      repoIds: ["repo-a"],
      personId: "person-edge",
      permissionSnapshot: [{ groupId: "viewer", version: "scope-v1" }],
      spkiSha256: "a".repeat(64),
      loginUrl: "https://127.0.0.1:41232",
      loginServername: "login.example",
      loginBrowserUrl: "https://login.example:18544",
      sshTarget: "macbook-air-via-tencent-prod",
      sshFleetPort: 41231,
      sshLoginPort: 41232,
      sshLoginServicePort: 18544,
      loginRealm: "harness",
      loginClientId: "harness-edge",
      createdBy: "person-center",
      ttlMs: 1_000,
    });
  journal.push(JSON.stringify({ schema: "harness-edge-join/v2", kind: "record", record: created.record }));

  const children: FakeProcess[] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: (() => {
        const child = fakeProcess();
        children.push(child);
        return child.process;
      }) as never,
      schedule: () => () => undefined,
    }),
    expiryTimers: { callback: () => void; delayMs: number; cancelled: boolean }[] = [],
    admin = new EdgeJoinAdminService({
      oidc: {} as OidcSessionService,
      userRoot: "/unused",
      daemonId: "default",
      now: () => new Date(now).toISOString(),
      journal: { read: () => journal, append: (line) => journal.push(line) },
      session: async () => {
        throw new Error("the expiry path does not use OIDC");
      },
      sshTunnels: manager,
      schedule: (callback, delayMs) => {
        const timer = { callback, delayMs, cancelled: false };
        expiryTimers.push(timer);
        return () => {
          timer.cancelled = true;
        };
      },
    });

  assert.equal(expiryTimers[0]!.delayMs, 1_000);
  await admin.resumeSshTunnels(7545);
  children[0]!.data("Allocated port 41231 for remote forward to 127.0.0.1:7545\r\n");
  children[0]!.data("Allocated port 41232 for remote forward to 127.0.0.1:18544\r\n");
  assert.equal(manager.state("macbook-air-via-tencent-prod"), "connected");

  now += 1_000;
  expiryTimers[0]!.callback();
  assert.equal(children[0]!.killed(), true);
  assert.equal(manager.state("macbook-air-via-tencent-prod"), "stopped");
  await admin.close();
});
