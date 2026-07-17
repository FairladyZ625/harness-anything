// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { authoritySubmissionWriteError } from "../src/daemon/authority-command-submission.ts";

test("authority JournalUnavailable errors serialize diagnostic fields without stacks", () => {
  const failure = new Error("AUTHORITY_PRODUCTION_PUBLICATION_OBSERVATION_MISMATCH") as Error & { code: string };
  failure.code = "EOBSERVE";
  const writeError = authoritySubmissionWriteError(failure);
  assert.deepEqual(writeError, {
    _tag: "JournalUnavailable",
    cause: {
      name: "Error",
      message: "AUTHORITY_PRODUCTION_PUBLICATION_OBSERVATION_MISMATCH",
      code: "EOBSERVE"
    }
  });
  assert.doesNotMatch(JSON.stringify(writeError), /stack/u);
});
