// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { OPAQUE_TEXTUAL_POLICY_ID } from "../../src/domain/artifact-text-classification.ts";
import { documentPath } from "../../src/domain/doc-sync.contract.ts";

import { decide, lease, opaqueClaim } from "./doc-sync.fixtures.ts";

test("task path fallback derives the owning task from both real id shapes in slug folders", () => {
  const body = "report\n";
  const write = (taskId: string, folder: string) =>
    decide(
      {
        path: documentPath(`tasks/${folder}/artifacts/report.md`),
        baseBlobSha256: null,
        policyId: OPAQUE_TEXTUAL_POLICY_ID,
        candidate: opaqueClaim(body),
      },
      null,
      Buffer.from(body),
      { lease: { ...lease, taskId } },
    );

  const hexId = "task_f7cc215a54a194898ad733c20a";
  const ulidId = "task_01KWVTPX3AH5TG8VK4RJYXE7EZ";

  const hexWrite = write(hexId, `${hexId}-allowlist-hex-ref`);
  assert.equal(hexWrite.accepted, true, JSON.stringify(hexWrite));

  const ulidWrite = write(ulidId, `${ulidId}-legacy-ulid`);
  assert.equal(ulidWrite.accepted, true, JSON.stringify(ulidWrite));

  const mismatch = write(hexId, `${ulidId}-legacy-ulid`);
  assert.equal(mismatch.accepted, false);
  if (!mismatch.accepted) assert.equal(mismatch.code, "unresolved_touch");
});
