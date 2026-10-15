// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import { renderCliReceipt } from "../src/cli/receipt-render-registry.ts";

function failedJobReceipt(failure: Record<string, unknown>) {
  return {
    ok: true,
    command: "task-ci",
    outcome: "applied",
    summary: "task-ci: applied",
    ci: {
      schema: "task-ci/v2",
      taskId: "task-fleet",
      branch: "task-fleet",
      headSha: "a".repeat(40),
      conclusion: "failure",
      checks: [],
      runs: [
        {
          id: 2,
          attempt: 1,
          event: "pull_request",
          status: "completed",
          conclusion: "failure",
          url: "https://runs/2",
          jobs: [
            {
              id: 21,
              name: "integration-shard (1)",
              status: "completed",
              conclusion: "failure",
              url: "https://jobs/21",
              failure,
            },
          ],
        },
      ],
    },
  };
}

test("a red job renders its failed file, test names, error line and stack frames", () => {
  const rendered = renderCliReceipt(
    failedJobReceipt({
      testFiles: ["fail tools/stress/fleet-campaign.integration.test.mjs"],
      tests: ["S4 exercises fleet claim, replica, takeover and injected-clock arms"],
      errors: [
        {
          test: "S4 exercises fleet claim, replica, takeover and injected-clock arms",
          firstLine: "TypeError: Cannot read properties of undefined (reading 'length')",
          frames: [
            "at runWorktreeSetup (packages/daemon/src/worktree-setup.ts:75:19)",
            "at prepareScheduleOccurrenceWorkspace (packages/daemon/src/schedule-occurrence-workspace.ts:200:22)",
          ],
        },
      ],
      excerpt: "",
      truncated: false,
      logUrl: "https://jobs/21",
    }),
  );
  assert.deepEqual(
    rendered.text.split("\n"),
    [
      "task task-fleet aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa: failure",
      "failed job integration-shard (1) (https://jobs/21)",
      "  test file: fail tools/stress/fleet-campaign.integration.test.mjs",
      "  failed test: S4 exercises fleet claim, replica, takeover and injected-clock arms",
      "  error: TypeError: Cannot read properties of undefined (reading 'length') " +
        "(S4 exercises fleet claim, replica, takeover and injected-clock arms)",
      "    at runWorktreeSetup (packages/daemon/src/worktree-setup.ts:75:19)",
      "    at prepareScheduleOccurrenceWorkspace (packages/daemon/src/schedule-occurrence-workspace.ts:200:22)",
      "  full log: https://jobs/21",
    ].map((line) => line),
  );
});

test("an unreachable log and a markerless failure each render their honest reason", () => {
  const unavailable = renderCliReceipt(
    failedJobReceipt({
      testFiles: [],
      tests: [],
      errors: [],
      excerpt: "",
      truncated: false,
      logUrl: "https://jobs/21",
      unavailable: "raw job log unavailable: gh: API HTTP 404 - Not Found",
    }),
  );
  assert.match(unavailable.text, /log unavailable: raw job log unavailable: gh: API HTTP 404/u);
  const markerless = renderCliReceipt(
    failedJobReceipt({
      testFiles: [],
      tests: [],
      errors: [],
      excerpt: "##[error]Process completed with exit code 1.",
      truncated: false,
      logUrl: "https://jobs/21",
    }),
  );
  assert.match(markerless.text, /assertion: ##\[error\]Process completed with exit code 1\./u);
});
