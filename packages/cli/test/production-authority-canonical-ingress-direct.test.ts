// harness-test-tier: integration
import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { runRawJsonMaybeFail } from "./helpers/daemon-cli.ts";
import {
  createFixture,
  installProductionArtifactPreset
} from "./production-authority-canonical-ingress/fixture.ts";

test("direct preset scaffold preserves its generated artifact bytes", () => {
  const fixture = createFixture();
  try {
    installProductionArtifactPreset(fixture.repoRoot);
    const result = runRawJsonMaybeFail(fixture.repoRoot, [
      "preset", "action", "production-artifact-scaffold", "scaffold",
      "--task", "task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4", "--allow-scripts"
    ], {
      HARNESS_DAEMON_MODE: "fixture",
      HARNESS_ACTOR: "agent:harness-test",
      HARNESS_GIT_AUTHOR_NAME: "Harness Test",
      HARNESS_GIT_AUTHOR_EMAIL: "harness@example.test"
    });
    assert.equal(result.status, 0, JSON.stringify(result.receipt));
    assert.equal(readFileSync(path.join(
      fixture.authoredRoot,
      "tasks/task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4/artifacts/production-scaffold.md"
    ), "utf8"), "# Production scaffold\n\nTask: task_01KXQ4WTA7Q4XJ5GDDRS1YXNG4\n");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
