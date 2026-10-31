// harness-test-tier: fast
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { EdgeJoinSshTunnelManager, validateSshTarget } from "../src/fleet/edge-join-ssh-tunnel.ts";
import { EdgeJoinAdminService } from "../src/access-admin-edge-join.ts";
import { createEdgeJoinStore } from "../src/fleet/edge-join.ts";
import { saveFleetCenterConfig } from "../src/fleet-center-config.ts";
import type { IdentitySessionPort } from "@harness-anything/kernel";
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

test("SSH tunnel forwards each service to its configured listener host", async () => {
  const child = fakeProcess(),
    spawnedArgs: string[][] = [],
    states: string[] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: ((command: string, argv: readonly string[]) => {
        assert.equal(command, "ssh");
        assert.ok(argv.includes("BatchMode=yes"));
        assert.ok(!argv.includes("ClearAllForwardings=yes"));
        assert.ok(argv.includes("ForwardAgent=no"));
        assert.equal(argv.at(-1), "macbook-air-via-tencent-prod");
        assert.equal(argv.filter((value) => value === "-R").length, 2);
        spawnedArgs.push([...argv]);
        return child.process;
      }) as never,
      onState: (_target, state) => states.push(state),
      schedule: () => () => undefined,
    }),
    pending = manager.start({
      target: "macbook-air-via-tencent-prod",
      fleetServicePort: 7545,
      fleetServiceHost: "10.211.55.2",
      loginServicePort: 18544,
      loginServiceHost: "10.211.55.2",
    });
  assert.ok(spawnedArgs[0]!.includes("127.0.0.1:0:10.211.55.2:7545"));
  assert.ok(spawnedArgs[0]!.includes("127.0.0.1:0:10.211.55.2:18544"));
  child.data("Allocated port 41231 for remote forward to 10.211.55.2:7545\r\n");
  child.data("Allocated port 41232 for remote forward to 10.211.55.2:18544\r\n");
  assert.deepEqual(await pending, { fleet: 41231, login: 41232 });
  assert.equal(manager.state("macbook-air-via-tencent-prod"), "connected");
  assert.deepEqual(states, ["connecting", "connected"]);
  await assert.rejects(
    manager.start({
      target: "macbook-air-via-tencent-prod",
      fleetServicePort: 7545,
      fleetServiceHost: "10.211.55.3",
      loginServicePort: 18544,
      loginServiceHost: "10.211.55.2",
    }),
    { code: "edge_join_ssh_failed", message: /different service addresses/u },
  );
  await assert.rejects(
    manager.start({
      target: "macbook-air-via-tencent-prod",
      fleetServicePort: 7545,
      fleetServiceHost: "10.211.55.2",
      loginServicePort: 18544,
      loginServiceHost: "10.211.55.3",
    }),
    { code: "edge_join_ssh_failed", message: /different service addresses/u },
  );
  await manager.close();
  assert.equal(child.killed(), true);
  assert.equal(manager.state("macbook-air-via-tencent-prod"), "stopped");
});

test("SSH tunnel brackets IPv6 local hosts for OpenSSH and recognizes their forward logs", async () => {
  const child = fakeProcess(),
    spawnedArgs: string[][] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: ((_command: string, args: readonly string[]) => {
        spawnedArgs.push([...args]);
        return child.process;
      }) as never,
      schedule: () => () => undefined,
    }),
    pending = manager.start({
      target: "operator@edge.example",
      fleetServicePort: 7545,
      fleetServiceHost: "2001:db8::2",
      loginServicePort: 18544,
      loginServiceHost: "2001:db8::3",
    });

  assert.ok(spawnedArgs[0]!.includes("127.0.0.1:0:[2001:db8::2]:7545"));
  assert.ok(spawnedArgs[0]!.includes("127.0.0.1:0:[2001:db8::3]:18544"));
  child.data("Allocated port 41231 for remote forward to [2001:db8::2]:7545\r\n");
  child.data("Allocated port 41232 for remote forward to [2001:db8::3]:18544\r\n");
  assert.deepEqual(await pending, { fleet: 41231, login: 41232 });
  await manager.close();
});

test("a disconnected SSH tunnel reconnects with its allocated ports and can be released", async () => {
  const children: FakeProcess[] = [],
    spawnedArgs: (readonly string[])[] = [],
    scheduled: { callback: () => void; cancelled: boolean; delayMs: number }[] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: ((_command: string, args: readonly string[]) => {
        spawnedArgs.push(args);
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
    fleetServiceHost: "10.211.55.2",
    loginServicePort: 18544,
    loginServiceHost: "10.211.55.2",
  });
  assert.ok(spawnedArgs[0]!.includes("127.0.0.1:0:10.211.55.2:7545"));
  assert.ok(spawnedArgs[0]!.includes("127.0.0.1:0:10.211.55.2:18544"));
  children[0]!.data("Allocated port 41231 for remote forward to 10.211.55.2:7545\r\n");
  children[0]!.data("Allocated port 41232 for remote forward to 10.211.55.2:18544\r\n");
  assert.deepEqual(await pending, { fleet: 41231, login: 41232 });
  assert.equal(scheduled[0]!.delayMs, 45_000);
  assert.equal(scheduled[0]!.cancelled, true);
  children[0]!.exit(255);
  assert.equal(manager.state("operator@edge.example"), "reconnecting");
  assert.equal(scheduled[1]!.delayMs, 5_000);
  assert.deepEqual(
    await manager.start({
      target: "operator@edge.example",
      fleetServicePort: 7545,
      fleetServiceHost: "10.211.55.2",
      loginServicePort: 18544,
      loginServiceHost: "10.211.55.2",
    }),
    { fleet: 41231, login: 41232 },
  );
  assert.equal(children.length, 1);
  scheduled[1]!.callback();
  assert.equal(children.length, 2);
  assert.ok(spawnedArgs[1]!.includes("127.0.0.1:41231:10.211.55.2:7545"));
  assert.ok(spawnedArgs[1]!.includes("127.0.0.1:41232:10.211.55.2:18544"));
  children[1]!.data("debug1: remote forward success for: listen 127.0.0.1:41231, connect 10.211.55.2:7545\r\n");
  children[1]!.data("debug1: remote forward success for: listen 127.0.0.1:41232, connect 10.211.55.2:18544\r\n");
  assert.equal(manager.state("operator@edge.example"), "connected");
  manager.release("operator@edge.example");
  assert.equal(children[1]!.killed(), true);
  assert.equal(scheduled[1]!.cancelled, false);
  await manager.close();
});

test("an unreachable SSH target backs off while retaining automatic reconnect", async () => {
  let nowMs = 0,
    targetReachable = false;
  const scheduled: { callback: () => void; cancelled: boolean; dueMs: number; delayMs: number }[] = [],
    restartDelays: number[] = [],
    schedule = (callback: () => void, delayMs: number) => {
      const timer = { callback, cancelled: false, dueMs: nowMs + delayMs, delayMs };
      scheduled.push(timer);
      if (delayMs !== 15_000 && delayMs !== 45_000) restartDelays.push(delayMs);
      return () => {
        timer.cancelled = true;
      };
    },
    children: FakeProcess[] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: (() => {
        const child = fakeProcess();
        children.push(child);
        if (!targetReachable) schedule(() => child.exit(255), 15_000);
        return child.process;
      }) as never,
      schedule,
    }),
    pending = manager.start({
      target: "operator@unreachable.example",
      fleetServicePort: 7545,
      fleetServiceHost: "127.0.0.1",
      loginServicePort: 18544,
      loginServiceHost: "127.0.0.1",
    });
  void pending.catch(() => undefined);

  const advanceTo = async (targetMs: number) => {
    while (true) {
      const next = scheduled
        .filter((timer) => !timer.cancelled && timer.dueMs <= targetMs)
        .sort((left, right) => left.dueMs - right.dueMs)[0];
      if (!next) break;
      next.cancelled = true;
      nowMs = next.dueMs;
      next.callback();
      await Promise.resolve();
    }
    nowMs = targetMs;
  };

  await advanceTo(10 * 60_000);
  assert.equal(children.length, 7);
  assert.deepEqual(restartDelays, [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000]);
  assert.equal(manager.state("operator@unreachable.example"), "reconnecting");
  targetReachable = true;
  await advanceTo(12 * 60_000);
  assert.equal(children.length, 8);
  children[7]!.data("Allocated port 41231 for remote forward to 127.0.0.1:7545\r\n");
  children[7]!.data("Allocated port 41232 for remote forward to 127.0.0.1:18544\r\n");
  assert.equal(manager.state("operator@unreachable.example"), "connected");
  children[7]!.exit(255);
  assert.equal(restartDelays.at(-1), 5_000);
  assert.equal(manager.state("operator@unreachable.example"), "reconnecting");
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
  const pending = manager.start({
    target: "operator@edge.example",
    fleetServicePort: 7545,
    fleetServiceHost: "127.0.0.1",
    loginServicePort: 18544,
    loginServiceHost: "127.0.0.1",
  });
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
    pending = manager.start({
      target: "operator@edge.example",
      fleetServicePort: 7545,
      fleetServiceHost: "127.0.0.1",
      loginServicePort: 18544,
      loginServiceHost: "127.0.0.1",
    });

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

test("resume derives actual service hosts and an expired invitation releases its shared SSH tunnel", async (t) => {
  let now = Date.parse("2026-10-22T00:00:00.000Z"),
    interactiveAuthorityCalls = 0;
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-edge-join-resume-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  saveFleetCenterConfig(userRoot, "default", {
    bind: "10.211.55.2",
    port: 7545,
    repoId: "repo-a",
    keyPath: path.join(userRoot, "center.key"),
    certPath: path.join(userRoot, "center.crt"),
    stateRoot: path.join(userRoot, "fleet-state"),
    quotaBytes: 1024 * 1024,
  });
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
    spawnedArgs: (readonly string[])[] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: ((_command: string, args: readonly string[]) => {
        spawnedArgs.push(args);
        const child = fakeProcess();
        children.push(child);
        return child.process;
      }) as never,
      schedule: () => () => undefined,
    }),
    expiryTimers: { callback: () => void; delayMs: number; cancelled: boolean }[] = [],
    admin = new EdgeJoinAdminService({
      oidc: {
        interactiveAuthority: async () => {
          interactiveAuthorityCalls += 1;
          throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18544"), { code: "ECONNREFUSED" });
        },
      } as IdentitySessionPort,
      userRoot,
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
  assert.equal(interactiveAuthorityCalls, 0);
  assert.ok(spawnedArgs[0]!.includes("127.0.0.1:41231:10.211.55.2:7545"));
  assert.ok(spawnedArgs[0]!.includes("127.0.0.1:41232:login.example:18544"));
  children[0]!.data("debug1: remote forward success for: listen 127.0.0.1:41231, connect 10.211.55.2:7545\r\n");
  children[0]!.data("debug1: remote forward success for: listen 127.0.0.1:41232, connect login.example:18544\r\n");
  assert.equal(manager.state("macbook-air-via-tencent-prod"), "connected");

  now += 1_000;
  expiryTimers[0]!.callback();
  assert.equal(children[0]!.killed(), true);
  assert.equal(manager.state("macbook-air-via-tencent-prod"), "stopped");
  await admin.close();
});

test("resume restores consumed SSH invitations without probing the login listener", async (t) => {
  const userRoot = mkdtempSync(path.join(tmpdir(), "ha-edge-join-consumed-resume-"));
  t.after(() => rmSync(userRoot, { recursive: true, force: true }));
  saveFleetCenterConfig(userRoot, "default", {
    bind: "10.211.55.2",
    port: 7545,
    repoId: "repo-a",
    keyPath: path.join(userRoot, "center.key"),
    certPath: path.join(userRoot, "center.crt"),
    stateRoot: path.join(userRoot, "fleet-state"),
    quotaBytes: 1024 * 1024,
  });
  const store = createEdgeJoinStore({ now: () => "2026-10-22T00:00:00.000Z" }),
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
      ttlMs: 72 * 60 * 60 * 1000,
    });
  const consumed = store.consume(created.record.joinId, "node-edge"),
    journal = [JSON.stringify({ schema: "harness-edge-join/v2", kind: "record", record: consumed })],
    children: FakeProcess[] = [],
    spawnedArgs: (readonly string[])[] = [],
    manager = new EdgeJoinSshTunnelManager({
      spawn: ((_command: string, args: readonly string[]) => {
        spawnedArgs.push(args);
        const child = fakeProcess();
        children.push(child);
        return child.process;
      }) as never,
      schedule: () => () => undefined,
    }),
    admin = new EdgeJoinAdminService({
      oidc: {
        interactiveAuthority: async () => {
          throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:18544"), { code: "ECONNREFUSED" });
        },
      } as IdentitySessionPort,
      userRoot,
      daemonId: "default",
      now: () => "2026-10-22T00:00:00.000Z",
      journal: { read: () => journal, append: (line) => journal.push(line) },
      session: async () => {
        throw new Error("the consumed restore path does not use OIDC");
      },
      sshTunnels: manager,
      schedule: () => () => undefined,
    });

  await admin.resumeSshTunnels(7545);
  assert.equal(spawnedArgs.length, 1);
  assert.ok(spawnedArgs[0]!.includes("127.0.0.1:41231:10.211.55.2:7545"));
  assert.ok(spawnedArgs[0]!.includes("127.0.0.1:41232:login.example:18544"));
  assert.equal(admin.status(created.record.joinId).state, "consumed");
  await admin.close();
  assert.equal(children[0]!.killed(), true);
});
