// harness-test-tier: fast
import assert from "node:assert/strict";
import test from "node:test";
import {
  formatDaemonFailure,
  repoWriteGracefulFailureLog
} from "../src/lifecycle/daemon-failure-diagnostic.ts";

test("daemon cleanup diagnostics retain every nested AggregateError reason", () => {
  const failure = new AggregateError([
    new Error("repo alpha graceful drain failed"),
    new AggregateError([
      new Error("repo beta did not exit after SIGKILL")
    ], "repo beta termination failed")
  ], "failed to stop daemon service handlers");

  const diagnostic = formatDaemonFailure(failure);

  assert.match(diagnostic, /AggregateError: failed to stop daemon service handlers/u);
  assert.match(diagnostic, /Error: repo alpha graceful drain failed/u);
  assert.match(diagnostic, /AggregateError: repo beta termination failed/u);
  assert.match(diagnostic, /Error: repo beta did not exit after SIGKILL/u);
});

test("confirmed child exit preserves the graceful shutdown failure as a warning", () => {
  const log = repoWriteGracefulFailureLog(new Error("fixture drain failed"));

  assert.equal(log.event, "repo-write.stop.graceful-failed");
  assert.match(log.message, /child exit was confirmed/u);
  assert.match(log.message, /Error: fixture drain failed/u);
});
