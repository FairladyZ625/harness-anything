// harness-test-tier: integration
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  forkRepoWriteProcess
} from "../src/runtime/repo-write-child-process-transport.ts";
import {
  RepoWriteProcessSupervisor
} from "../src/runtime/repo-write-process-supervisor.ts";

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

function command() {
  return {
    commandName: "progress-append",
    actor: { personId: "person-test" },
    context: {},
    payload: { command: "test" }
  };
}
