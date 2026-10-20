// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import type { RegisteredRepoInput } from "../src/daemon-host-context.ts";
import type { DaemonHostRegistryContext } from "../src/daemon-host-context.ts";
import { attachInitial } from "../src/daemon-host-recovery.ts";

test("initial attachment starts later repositories without waiting for an earlier slow attach", async () => {
  const repos: RegisteredRepoInput[] = [
      { repoId: "slow", canonicalRoot: "/slow", authoredBranch: "main", mode: "local" },
      { repoId: "fast", canonicalRoot: "/fast", authoredBranch: "main", mode: "local" },
    ],
    started: string[] = [];
  let releaseSlow!: () => void;
  const slowAttachment = new Promise<void>((resolve) => {
    releaseSlow = resolve;
  });
  const context = {
    repos,
    closing: false,
    input: {},
    warming: new Map(repos.map((repo) => [repo.repoId, {} as never])),
    cells: new Map(),
    unavailable: new Map(),
    pruneMissingRoot: () => false,
    openRegistered: (repo: RegisteredRepoInput) => {
      started.push(repo.repoId);
      return repo.repoId === "slow" ? slowAttachment : Promise.resolve();
    },
    latchUnavailable: () => assert.fail("unexpected attach failure"),
    unavailableStatus: () => assert.fail("unexpected attach failure"),
  } as unknown as DaemonHostRegistryContext;

  const attachments = attachInitial(context);
  try {
    assert.deepEqual(started, ["slow", "fast"]);
  } finally {
    releaseSlow();
  }
  await attachments;
});
