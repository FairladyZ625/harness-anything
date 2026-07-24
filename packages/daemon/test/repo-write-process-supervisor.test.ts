// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  forkRepoWriteProcess
} from "../src/runtime/repo-write-child-process-transport.ts";
import {
  RepoWriteProcessSupervisor
} from "../src/runtime/repo-write-process-supervisor.ts";
import {
  RepoWriteOutcomeUnknownError,
  RepoWriteProtocolViolationError,
  RepoWriteReadyTimeoutError
} from "../src/runtime/repo-write-client.ts";
import {
  calculateDaemonArtifactIdentity
} from "../src/protocol/daemon-artifact-identity.ts";

const fixturePath = fileURLToPath(
  new URL("./support/repo-write-ipc-child.ts", import.meta.url)
);

test("supervisor submits through one child and drains it without inline fallback", async (context) => {
  let forks = 0;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["roundtrip"]
      });
    }
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  await supervisor.start();
  const receipt = await supervisor.submit(command());

  assert.equal(receipt.ok, true);
  assert.equal(receipt.summary, "transport submission");
  assert.equal(forks, 1);
  assert.equal(supervisor.status().connected, true);
  await supervisor.stop();
  assert.equal(supervisor.status().connected, false);
});

test("post-proceed child crash performs one exact op lookup in a replacement capsule", async (context) => {
  let forks = 0;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["crash-after-proceed"]
      });
    }
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  const receipt = await supervisor.submit(command());

  assert.equal(receipt.ok, true);
  assert.equal(receipt.summary, "transport recovery");
  assert.equal(forks, 2);
  assert.equal(supervisor.status().generation, 1);
});

test("connected child that never announces READY is terminated at the readiness deadline", async (context) => {
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    limits: {
      readyTimeoutMs: 40
    },
    spawn: () => forkRepoWriteProcess({
      modulePath: fixturePath,
      args: ["never-ready"]
    })
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  await assert.rejects(supervisor.start(), (error) => {
    assert.ok(error instanceof RepoWriteReadyTimeoutError);
    assert.equal(error.code, "REPO_WRITE_READY_TIMEOUT");
    return true;
  });
  assert.equal(supervisor.status().connected, false);
});

test("child that swallows PROCEED releases the pending request at its deadline", async (context) => {
  let forks = 0;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    limits: {
      requestTimeoutMs: 40
    },
    spawn: () => {
      forks += 1;
      return forkRepoWriteProcess({
        modulePath: fixturePath,
        args: ["swallow-proceed"]
      });
    }
  });
  context.after(() => supervisor.stop().catch(() => undefined));

  await assert.rejects(supervisor.submit(command()), (error) => {
    assert.ok(error instanceof RepoWriteOutcomeUnknownError);
    assert.equal(error.code, "REPO_WRITE_REQUEST_TIMEOUT");
    return true;
  });
  assert.equal(forks, 2);
});

test("replacement recovers an earlier PROCEEDING before admitting a queued append", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-order-"));
  const tracePath = path.join(root, "trace.log");
  let forks = 0;
  let queued: Promise<unknown> | undefined;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    spawn: () => {
      forks += 1;
      const transport = forkRepoWriteProcess({
        modulePath: fixturePath,
        args: [forks === 1 ? "crash-after-proceed" : "roundtrip", tracePath]
      });
      if (forks === 1) {
        transport.onDisconnect(() => {
          queued = supervisor.submit(command("B"));
        });
      }
      return transport;
    }
  });
  context.after(async () => {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  const recovered = await supervisor.submit(command("A"));
  await queued;
  assert.equal(recovered.ok, true);
  const trace = readFileSync(tracePath, "utf8").trim().split("\n");
  assert.ok(
    trace.indexOf("status:op-1:1") < trace.indexOf("submit:B"),
    `expected recovery before B, received ${trace.join(",")}`
  );
});

test("replacement rejects an entrypoint whose artifact changed after initial READY", async (context) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-entrypoint-"));
  const childPath = path.join(root, "pinned-child.mjs");
  const identityModule = new URL(
    "../src/protocol/daemon-artifact-identity.ts",
    import.meta.url
  ).href;
  const source = pinnedChildSource(identityModule);
  writeFileSync(childPath, source, "utf8");
  const expectedArtifactIdentity =
    calculateDaemonArtifactIdentity(childPath).identity;
  const supervisor = new RepoWriteProcessSupervisor({
    repoId: "repo-transport",
    generation: 1,
    expectedArtifactIdentity,
    spawn: () => forkRepoWriteProcess({
      modulePath: childPath
    })
  });
  context.after(async () => {
    await supervisor.stop().catch(() => undefined);
    rmSync(root, { recursive: true, force: true });
  });

  await supervisor.start();
  writeFileSync(childPath, `${source}\n// drift after READY\n`, "utf8");
  process.kill(supervisor.status().pid!, "SIGKILL");
  await waitFor(() => !supervisor.status().connected);

  await assert.rejects(supervisor.lookup("op-after-drift"), (error) => {
    assert.ok(error instanceof RepoWriteProtocolViolationError);
    assert.match(error.message, /artifact identity/u);
    return true;
  });
});

function command(label = "") {
  return {
    commandName: "progress-append",
    actor: { personId: "person-test" },
    context: {},
    payload: { command: "test", label }
  };
}

function pinnedChildSource(identityModule: string): string {
  return [
    `import { calculateDaemonArtifactIdentity } from ${JSON.stringify(identityModule)};`,
    "const artifactIdentity = calculateDaemonArtifactIdentity(process.argv[1]).identity;",
    "const base = { protocol: 'harness-repo-write-ipc/v1', repoId: 'repo-transport', generation: 1 };",
    "process.send({ ...base, kind: 'ready', artifactIdentity });",
    "process.on('message', (message) => {",
    "  if (message.kind === 'status') process.send({ ...base, kind: 'status', requestId: message.requestId, opId: message.opId, state: 'not-found' });",
    "  if (message.kind === 'shutdown') process.send({ ...base, kind: 'drained', requestId: message.requestId }, () => process.disconnect());",
    "});",
    ""
  ].join("\n");
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for child state");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
