// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { removeTemporaryTestRoot } from "./helpers/temp-root-cleanup.ts";

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

function filesystemError(code: string): Error & { readonly code: string } {
  return Object.assign(new Error(code), { code });
}
