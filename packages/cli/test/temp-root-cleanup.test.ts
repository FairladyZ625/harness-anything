// harness-test-tier: fast
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  readPublicationGitObject,
  shutdownPublicationGitObjectReader
} from "../../daemon/src/authority/production/publication-object-reader.ts";
import { removeTemporaryTestRoot } from "../../../tools/test-temp-root-cleanup.mjs";

test("temporary-root cleanup retries transient filesystem errors with linear backoff", async () => {
  const attempts: string[] = [];
  const waits: number[] = [];

  await removeTemporaryTestRoot("/fixture", {
    remove: () => {
      attempts.push("remove");
      if (attempts.length === 1) throw filesystemError("EPERM");
      if (attempts.length === 2) throw filesystemError("EBUSY");
    },
    wait: async (milliseconds) => { waits.push(milliseconds); },
    maxRetries: 2,
    retryDelayMs: 25
  });

  assert.equal(attempts.length, 3);
  assert.deepEqual(waits, [25, 50]);
});

test("temporary-root cleanup covers every recursive-removal transient errno", async () => {
  for (const code of ["EBUSY", "EMFILE", "ENFILE", "ENOTEMPTY", "EPERM"]) {
    let attempts = 0;
    await removeTemporaryTestRoot("/fixture", {
      remove: () => {
        attempts += 1;
        if (attempts === 1) throw filesystemError(code);
      },
      wait: async () => undefined,
      maxRetries: 1
    });
    assert.equal(attempts, 2, code);
  }
});

test("temporary-root cleanup rejects non-transient filesystem errors immediately", async () => {
  const error = filesystemError("EACCES");
  let attempts = 0;

  await assert.rejects(
    removeTemporaryTestRoot("/fixture", {
      remove: () => {
        attempts += 1;
        throw error;
      },
      wait: async () => undefined
    }),
    (observed) => observed === error
  );
  assert.equal(attempts, 1);
});

test("temporary-root cleanup preserves the final transient error after its retry budget", async () => {
  const error = filesystemError("EPERM");
  let attempts = 0;

  await assert.rejects(
    removeTemporaryTestRoot("/fixture", {
      remove: () => {
        attempts += 1;
        throw error;
      },
      wait: async () => undefined,
      maxRetries: 2
    }),
    (observed) => observed === error
  );
  assert.equal(attempts, 3);
});

test("temporary-root cleanup identifies an unclosed publication reader after retries are exhausted", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "ha-temp-root-reader-diagnostic-"));
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "user.name", "Harness Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "harness@example.test"]);
  writeFileSync(path.join(root, "seed.txt"), "seed\n");
  execFileSync("git", ["-C", root, "add", "."]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "seed"]);
  await readPublicationGitObject(root, "HEAD:seed.txt");
  const canonicalRoot = realpathSync.native(root);
  const error = filesystemError("EPERM");
  let attempts = 0;

  try {
    await assert.rejects(
      removeTemporaryTestRoot(root, {
        remove: () => {
          attempts += 1;
          throw error;
        },
        wait: async () => undefined,
        maxRetries: 2
      }),
      (observed) => observed === error
        && observed.message.includes(`still has 1 unclosed publication reader(root=${canonicalRoot})`)
    );
    assert.equal(attempts, 3);
  } finally {
    await shutdownPublicationGitObjectReader(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function filesystemError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}
