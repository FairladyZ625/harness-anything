// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { compileRuntimeSessionDraft } from "../src/entity-action-runtime-session.ts";
import { sha256Text, type RuntimeSessionActionDraft } from "@harness-anything/kernel";

test("new succeeded outcomes require claimed bytes while historical events remain readable", () => {
  const body = "Completed runtime result.",
    sha256 = sha256Text(body),
    event = {
      schema: "agent-runtime-event/v1",
      type: "runtime_session_outcome_observed",
      opId: "runtime-outcome",
      eventId: "runtime-outcome",
      workspaceRevision: 1,
      actor: { principal: { personId: "owner" }, executor: null },
      source: "local",
      occurredAt: "2026-10-09T00:00:00Z",
      payload: {
        runtimeSessionId: "runtime-1",
        outcome: "succeeded",
        exitCode: 0,
        resultRef: `artifact:runtime-result/sha256/${sha256}`,
        result: null,
      },
    } as const;
  assert.throws(() => compileRuntimeSessionDraft({ event } as RuntimeSessionActionDraft), {
    code: "content_claim_required",
  });
  const claimed = {
    ...event,
    payload: {
      ...event.payload,
      result: {
        sha256,
        size: Buffer.byteLength(body),
        mediaType: "text/plain; charset=utf-8" as const,
      },
    },
  };
  assert.throws(() => compileRuntimeSessionDraft({ event: claimed } as RuntimeSessionActionDraft), {
    code: "content_claim_required",
  });
  assert.equal(
    compileRuntimeSessionDraft({ event: claimed, resultBody: body } as RuntimeSessionActionDraft).blobs[0]?.body,
    body,
  );
});
