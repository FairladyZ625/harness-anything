// harness-test-tier: fast
import assert from "node:assert/strict";
import {
  fork,
  type ChildProcess
} from "node:child_process";
import { EventEmitter, once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  forkRepoWriteProcess,
  RepoWriteParentProcessTransport,
  RepoWriteProcessDisconnectError,
} from "../src/runtime/repo-write-child-process-transport.ts";
import {
  repoWriteProtocolType,
  type RepoWriteChildMessage
} from "../src/runtime/repo-write-protocol.ts";

const fixturePath = fileURLToPath(new URL("./support/repo-write-ipc-child.ts", import.meta.url));

test("uses Node IPC for validated ready and command roundtrips", async (context) => {
  const transport = start("roundtrip");
  context.after(() => stop(transport));

  assert.deepEqual(await nextMessage(transport), {
    protocol: repoWriteProtocolType,
    repoId: "repo-transport",
    generation: 1,
    kind: "ready"
  });

  const prepared = nextMessage(transport);
  await transport.send({
    protocol: repoWriteProtocolType,
    repoId: "repo-transport",
    generation: 1,
    kind: "submit",
    requestId: "request-1",
    command: {
      commandName: "task.create",
      actor: { actorId: "actor-1" },
      context: {},
      payload: { title: "bounded command" }
    }
  });
  assert.deepEqual(await prepared, {
    protocol: repoWriteProtocolType,
    repoId: "repo-transport",
    generation: 1,
    kind: "prepared",
    requestId: "request-1",
    opId: "op-request-1"
  });

  const drained = nextMessage(transport);
  await transport.send({
    protocol: repoWriteProtocolType,
    repoId: "repo-transport",
    generation: 1,
    kind: "shutdown",
    requestId: "shutdown-1"
  });
  assert.equal((await drained).kind, "drained");
});

test("delivers a buffered frame only after listener registration returns", async (context) => {
  const transport = start("roundtrip");
  context.after(() => stop(transport));
  await new Promise((resolve) => setTimeout(resolve, 50));

  let registrationReturned = false;
  const ready = new Promise<RepoWriteChildMessage>((resolve) => {
    const remove = transport.onMessage((message) => {
      assert.equal(registrationReturned, true);
      remove();
      resolve(message);
    });
    registrationReturned = true;
  });

  assert.equal((await ready).kind, "ready");
});

test("rejects malformed child frames, disconnects once, and terminates the child", async (context) => {
  const transport = start("malformed-child");
  context.after(() => stop(transport));
  const errors: Error[] = [];
  const disconnected = new Promise<Error>((resolve) => {
    transport.onDisconnect((error) => {
      errors.push(error);
      resolve(error);
    });
  });

  const error = await disconnected;
  assertDisconnect(error, "protocol");
  await waitForExit(transport.child);
  assert.equal(errors.length, 1);
  assert.equal(transport.child.signalCode, "SIGTERM");
});

test("child transport rejects malformed parent frames and closes the IPC channel", async (context) => {
  const transport = start("reject-parent");
  context.after(() => stop(transport));
  await nextMessage(transport);
  const disconnected = nextDisconnect(transport);

  transport.child.send({ protocol: "wrong", kind: "submit" });

  const error = await disconnected;
  assert.ok(error instanceof RepoWriteProcessDisconnectError);
  await waitForExit(transport.child);
  assert.equal(transport.child.exitCode, 42);
});

test("reports exit codes and signals with one terminal disconnect", async (context) => {
  const exited = start("exit");
  context.after(() => stop(exited));
  const exitErrors: Error[] = [];
  const exit = new Promise<Error>((resolve) => {
    exited.onDisconnect((error) => {
      exitErrors.push(error);
      resolve(error);
    });
  });
  const exitError = await exit;
  assertDisconnect(exitError, "exit");
  assert.equal((exitError as RepoWriteProcessDisconnectError).exitCode, 23);
  assert.equal(exitErrors.length, 1);

  const signaled = start("wait");
  context.after(() => stop(signaled));
  await nextMessage(signaled);
  const signalErrorPromise = nextDisconnect(signaled);
  signaled.terminate("SIGTERM");
  const signalError = await signalErrorPromise;
  assertDisconnect(signalError, "signal");
  assert.equal((signalError as RepoWriteProcessDisconnectError).signal, "SIGTERM");
});

test("forks once and never hides an exit behind an implicit restart", async (context) => {
  let forks = 0;
  const transport = forkRepoWriteProcess({
    modulePath: fixturePath,
    args: ["exit"],
    forkProcess: (modulePath, args, options) => {
      forks += 1;
      return fork(modulePath, [...args], options);
    }
  });
  context.after(() => stop(transport));

  await nextDisconnect(transport);
  await waitForExit(transport.child);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(forks, 1);
});

test("terminal process failure rejects sends whose callbacks never settled", async () => {
  const child = stalledChild();
  const transport = new RepoWriteParentProcessTransport(child);
  const pending = transport.send({
    protocol: repoWriteProtocolType,
    repoId: "repo-transport",
    generation: 1,
    kind: "shutdown",
    requestId: "shutdown-stalled-send"
  });

  child.emit("exit", 31, null);

  await assert.rejects(pending, (error) => {
    assertDisconnect(error as Error, "exit");
    assert.equal((error as RepoWriteProcessDisconnectError).exitCode, 31);
    return true;
  });
});

function start(mode: string): RepoWriteParentProcessTransport {
  return forkRepoWriteProcess({
    modulePath: fixturePath,
    args: [mode]
  });
}

function nextMessage(transport: RepoWriteParentProcessTransport): Promise<RepoWriteChildMessage> {
  return new Promise((resolve) => {
    const remove = transport.onMessage((message) => {
      remove();
      resolve(message);
    });
  });
}

function nextDisconnect(transport: RepoWriteParentProcessTransport): Promise<Error> {
  return new Promise((resolve) => {
    const remove = transport.onDisconnect((error) => {
      remove();
      resolve(error);
    });
  });
}

function assertDisconnect(error: Error, reason: RepoWriteProcessDisconnectError["reason"]): void {
  assert.ok(error instanceof RepoWriteProcessDisconnectError);
  assert.equal(error.reason, reason);
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await once(child, "exit");
}

function stop(transport: RepoWriteParentProcessTransport): void {
  if (transport.child.exitCode === null && transport.child.signalCode === null) {
    transport.terminate("SIGKILL");
  }
}

function stalledChild(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    exitCode: null,
    signalCode: null,
    send: () => true,
    kill: () => true
  });
  return child as unknown as ChildProcess;
}
