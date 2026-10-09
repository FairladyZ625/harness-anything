// harness-test-tier: fast
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { ExecutionV1 } from "@harness-anything/kernel";
import { reviewPacket } from "../src/repo-cell-packets.ts";
import { reviewDispatchPrompt } from "../src/task-review-dispatch.ts";

const sha256 = (body: string | Uint8Array) => createHash("sha256").update(body).digest("hex");

test("review prompts reference the frozen submission without inlining artifacts or their anchors", () => {
  const packagePath = "tasks/task-review-prompt-bounds",
    bigBody = `REVIEW-ARTIFACT-HEAD\n${"raw evidence line\n".repeat(2000)}REVIEW-ARTIFACT-TAIL\n`,
    smallBody = "REVIEW-SMALL-ARTIFACT-FULL-BODY\n",
    execution = {
      executionId: "exe_review_bounds",
      iteration: 1,
      deliveryBaseline: { kind: "commit", commitSha: "b".repeat(40) },
      submission: {
        artifacts: [
          { path: "artifacts/raw-evidence.txt", revision: 1, blobSha256: sha256(bigBody) },
          { path: "artifacts/report.md", revision: 1, blobSha256: sha256(smallBody) },
        ],
      },
    } as unknown as ExecutionV1;
  const prompt = reviewDispatchPrompt({
    taskId: "task_review_bounds",
    packagePath,
    dispatchId: "dispatch_reviewbounds000001",
    execution,
    gates: [],
  });
  assert.match(prompt, /Independently review task task_review_bounds/u);
  assert.match(prompt, /JSON required fields: verdict, reason, evidenceChecked/u);
  assert.match(prompt, /verdict: approved\|changes_requested\|dismissed/u);
  assert.doesNotMatch(prompt, /Owner adjudication context/u);
  assert.match(prompt, /execution-frozen delivery baseline.*b{40}/u);
  assert.match(prompt, /Read the G33 production-delta result/u);
  assert.doesNotMatch(prompt, /REVIEW-ARTIFACT|REVIEW-SMALL-ARTIFACT|bodyTruncatedFromChars/u);
  assert.doesNotMatch(prompt, /raw-evidence\.txt|"artifacts":/u);
  assert.match(prompt, /ha task show task_review_bounds --json/u);
  assert.match(prompt, /ha doc show --path <anchor.path> --raw/u);
  assert.match(prompt, /registered anchors at their frozen revisions/u);
});

test("review prompt size is independent of evidence bytes and artifact count", () => {
  const packagePath = "tasks/task-bounds",
    body = "frozen evidence\n".repeat(2000),
    input = {
      taskId: "task-bounds",
      packagePath,
      dispatchId: "dispatch-bounds",
      gates: [],
    },
    promptFor = (count: number) =>
      reviewDispatchPrompt({
        ...input,
        execution: {
          executionId: "execution-bounds",
          iteration: 1,
          submission: {
            artifacts: Array.from({ length: count }, (_, i) => ({
              path: `${packagePath}/artifacts/evidence-${i % 80}.log`,
              revision: 1,
              blobSha256: sha256(body),
            })),
          },
        } as unknown as ExecutionV1,
      });
  assert.ok(Buffer.byteLength(body) * 80 > 1_048_576, "fixture exceeds the observed provider limit");
  const small = promptFor(1),
    large = promptFor(80),
    many = promptFor(10000);
  assert.equal(large.length, small.length);
  assert.equal(many.length, small.length);
  assert.ok(large.length < 10000, `reference prompt has ${large.length} characters`);
  assert.doesNotMatch(large, /frozen evidence/u);
});

test("review input accepts the dispatched field contract and rejects persisted-record metadata", () => {
  const value = { verdict: "approved", reason: "Checked the frozen delivery.", evidenceChecked: ["closeout.md"] };
  assert.deepEqual(
    reviewPacket("/unused", { kind: "task-review-execution", jsonInput: JSON.stringify(value) }).value,
    value,
  );
  for (const metadata of [{ schema: "review/v1" }, { taskId: "task_1" }, { executionId: "exe_1" }, { findings: [] }])
    assert.throws(
      () =>
        reviewPacket("/unused", {
          kind: "task-review-execution",
          jsonInput: JSON.stringify({ ...value, ...metadata }),
        }),
      /Review JSON requires exactly/u,
    );
});

test("resolved fleet review packets preserve the local packet validation and digest", () => {
  const value = { verdict: "approved", reason: "Checked the wire cut.", evidenceChecked: ["tests"] };
  const resolved = { kind: "task-review-execution", taskId: "task_one", reviewId: "review_one", ...value };
  assert.deepEqual(
    reviewPacket("/unused", resolved),
    reviewPacket("/unused", {
      kind: "task-review-execution",
      jsonInput: JSON.stringify(value),
    }),
  );
  assert.throws(() => reviewPacket("/unused", { ...resolved, principal: "client" }), /Review JSON requires exactly/u);
  const { evidenceChecked: _evidence, ...missing } = resolved;
  assert.throws(() => reviewPacket("/unused", missing), /Review JSON requires exactly/u);
});
