// harness-test-tier: contract
import assert from "node:assert/strict";
import {
  closeSync,
  fchmodSync,
  mkdtempSync,
  openSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DurableRepoWriteOutcomeStoreV1,
  repoWriteActorStampDigestV1,
  RepoWriteOutcomeUnsupportedPlatformError,
  type RepoWriteProceedingInputV1,
  type RepoWriteTerminalEvidenceV1
} from "../src/index.ts";

const outcomeTest = process.platform === "win32" ? test.skip : test;

test("win32 store construction is explicitly unsupported", {
  skip: process.platform !== "win32"
}, () => {
  assert.throws(() => new DurableRepoWriteOutcomeStoreV1({
    directory: "C:\\repo-write-outcomes",
    ...axes()
  }), (error) => error instanceof RepoWriteOutcomeUnsupportedPlatformError
    && error.code === "REPO_WRITE_OUTCOME_PLATFORM_UNSUPPORTED");
});

outcomeTest("existing outcomes are never returned when the observation directory fsync fails", () => {
  withDirectory((directory) => {
    const input = proceedingInput("outer-observation-fsync");
    const durable = new DurableRepoWriteOutcomeStoreV1({ directory, ...axes() });
    durable.begin(input);
    const observedReasons: string[] = [];
    const targetFsyncReasons: string[] = [];
    const failingObserver = new DurableRepoWriteOutcomeStoreV1({
      directory,
      ...axes(),
      __testOnlyDurabilityHooks: {
        afterTargetFsync: ({ reason }) => targetFsyncReasons.push(reason),
        beforeDirectoryFsync: (reason) => {
          observedReasons.push(reason);
          if (reason === "observe-existing") throw new Error("injected observation fsync failure");
        }
      }
    });

    assert.throws(() => failingObserver.get(input.outerOpId), /injected observation fsync failure/u);
    assert.throws(() => failingObserver.lookup(input.outerOpId), /injected observation fsync failure/u);
    assert.throws(() => failingObserver.begin(input), /injected observation fsync failure/u);
    assert.deepEqual(observedReasons, [
      "observe-existing",
      "observe-existing",
      "observe-existing"
    ]);
    assert.deepEqual(targetFsyncReasons, [
      "observe-existing",
      "observe-existing",
      "observe-existing"
    ]);
  });
});

outcomeTest("an EEXIST race observer must complete its own directory fsync before continuing", () => {
  withDirectory((directory) => {
    const input = proceedingInput("outer-eexist-race");
    let injected = false;
    const reasons: string[] = [];
    const targetFsyncReasons: string[] = [];
    const racingStore = new DurableRepoWriteOutcomeStoreV1({
      directory,
      ...axes(),
      __testOnlyDurabilityHooks: {
        beforePublishLink: ({ target, text }) => {
          if (injected) return;
          injected = true;
          const descriptor = openSync(target, "wx", 0o600);
          try {
            fchmodSync(descriptor, 0o600);
            writeFileSync(descriptor, text, "utf8");
          } finally {
            closeSync(descriptor);
          }
        },
        afterTargetFsync: ({ reason }) => targetFsyncReasons.push(reason),
        beforeDirectoryFsync: (reason) => {
          reasons.push(reason);
          if (reason === "eexist-observer") throw new Error("injected EEXIST fsync failure");
        }
      }
    });

    assert.throws(() => racingStore.begin(input), /injected EEXIST fsync failure/u);
    assert.deepEqual(reasons, ["eexist-observer"]);
    assert.deepEqual(targetFsyncReasons, ["eexist-observer"]);
    assert.equal(new DurableRepoWriteOutcomeStoreV1({
      directory,
      ...axes()
    }).get(input.outerOpId)?.phase, "PROCEEDING");
  });
});

outcomeTest("restrictive umask cannot weaken the 0700 directory and 0600 record modes", () => {
  withDirectory((directory) => {
    const previous = process.umask(0o777);
    try {
      new DurableRepoWriteOutcomeStoreV1({ directory, ...axes() })
        .begin(proceedingInput("outer-umask"));
    } finally {
      process.umask(previous);
    }
    const record = readdirSync(directory).find((name) => name.endsWith(".proceeding.json"));
    assert.ok(record);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(directory, record)).mode & 0o777, 0o600);
  });
});

outcomeTest("oversized authority mutation proofs are budgeted before evidence hashing", () => {
  withDirectory((directory) => {
    const input = proceedingInput("outer-mutation-budget");
    const store = new DurableRepoWriteOutcomeStoreV1({ directory, ...axes() });
    const proceeding = store.begin(input);
    assert.throws(() => store.terminalize({
      ...axes(),
      outerOpId: input.outerOpId,
      requestDigest: proceeding.requestDigest,
      receipt: {
        ok: false,
        schema: "command-receipt/v2",
        command: input.receiptSeed.command,
        action: input.receiptSeed.action,
        summary: "rejected",
        details: { actor: input.authenticatedContext.actor },
        meta: { generatedAt: input.receiptSeed.generatedAt, compatibility: {} }
      },
      authorityEvidence: {
        tag: "COMMITTED",
        authorityIntegrity: {
          canonicalMutationSet: { mutations: Array.from({ length: 16_385 }, () => null) }
        }
      } as unknown as RepoWriteTerminalEvidenceV1
    }), /bounded JSON array item count/u);
  });
});

function proceedingInput(outerOpId: string): RepoWriteProceedingInputV1 {
  const actor = {
    personId: "person_zeyu",
    displayName: "Zeyu Li",
    providerId: "local-socket",
    credential: {
      kind: "unix-socket-owner-boundary",
      issuer: "local-daemon",
      subject: "person_zeyu"
    }
  } as const;
  return {
    ...axes(),
    outerOpId,
    innerOpId: `inner-${outerOpId}`,
    authoritySemanticDigest: "1".repeat(64),
    canonicalCommand: {
      commandName: "task.create",
      actor,
      context: { presentation: "json" },
      payload: { title: "durability" }
    },
    authenticatedContext: { actor, presentation: { json: true } },
    receiptSeed: {
      schema: "repo-write-receipt-seed/v1",
      renderer: "cli-command-receipt/v2@1",
      generatedAt: "2026-07-23T12:00:00.000Z",
      command: "task create",
      action: "create",
      actorStampDigest: repoWriteActorStampDigestV1(actor)
    },
    recoveryContext: { authorityEnvelopeDigest: "1".repeat(64) }
  };
}

function axes() {
  return {
    repoId: "repo-canonical",
    workspaceId: "workspace-canonical",
    generation: 1
  } as const;
}

function withDirectory(run: (directory: string) => void): void {
  const root = mkdtempSync(path.join(os.tmpdir(), "ha-repo-write-durability-"));
  try {
    run(path.join(root, "outcomes"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
