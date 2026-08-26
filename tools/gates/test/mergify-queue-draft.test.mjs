// harness-test-tier: contract
import assert from "node:assert/strict";
import test from "node:test";
import { isMergifyQueueDraft } from "../mergify-queue-draft.mjs";

test("identifies Mergify queue drafts by bot author and queue branch", () => {
  assert.equal(
    isMergifyQueueDraft({ headRefName: "mergify/merge-queue/e00b463e2d", authorLogin: "mergify[bot]" }),
    true,
  );
  assert.equal(
    isMergifyQueueDraft({ headRefName: "mergify/merge-queue/e00b463e2d", authorLogin: "app/mergify" }),
    true,
  );
});

test("requires both a Mergify bot author and queue branch", () => {
  assert.equal(isMergifyQueueDraft({ headRefName: "codex/not-a-queue", authorLogin: "mergify[bot]" }), false);
  assert.equal(
    isMergifyQueueDraft({ headRefName: "mergify/merge-queue/e00b463e2d", authorLogin: "FairladyZ625" }),
    false,
  );
});
