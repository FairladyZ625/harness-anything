// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { taskEntityId } from "../../kernel/src/index.ts";
import { daemonActorAttribution } from "../src/composition/actor-attribution.ts";
import {
  createCliProductionAuthorityLifecycle as createProductionAuthorityLifecycle
} from "../src/composition/production-authority-lifecycle.ts";
import {
  productionAuthorityActor,
  productionAuthorityConnection
} from "./helpers/production-authority-connection.ts";
import {
  createProductionAuthorityLifecycleFixture as createFixture,
  fixtureGit as git,
  productionWriterRuntime as writerRuntime
} from "./helpers/production-authority-lifecycle-fixture.ts";

test("the next publication commits a V2 event left durable before its evidence commit", async () => {
  const fixture = createFixture();
  try {
    const lifecycle = createProductionAuthorityLifecycle({ manifestPath: fixture.manifestPath });
    const started = await lifecycle.startRepo(
      { repoId: "canonical", canonicalRoot: fixture.repoRoot },
      writerRuntime(fixture.authoredRoot)
    );
    assert.equal(started.ok, true, started.ok ? "" : started.error);
    if (!started.ok) return;
    const actor = productionAuthorityActor();
    const submission = started.component.bindConnection(productionAuthorityConnection(actor));
    const submit = (text: string) => submission.submit({
      command: {
        rootDir: fixture.repoRoot,
        json: true,
        action: { kind: "progress-append" as const, taskId: "task_A", text, dryRun: false }
      },
      attribution: daemonActorAttribution(actor, { kind: "agent", id: "codex" }),
      currentSession: {
        runtime: "codex" as const,
        sessionId: "session-production",
        source: "manual" as const,
        detectedAt: new Date().toISOString()
      },
      canonicalEntityId: taskEntityId("task_A")
    });

    const first = await submit("first durable event\n");
    assert.equal(first.tag, "COMMITTED", JSON.stringify(first));
    if (first.tag !== "COMMITTED") return;
    const firstEvent = execFileSync("find", [
      path.join(fixture.authoredRoot, "authority-attribution-events/v2"), "-type", "f"
    ], { encoding: "utf8" }).trim();
    assert.ok(firstEvent);

    // Recreate the durable crash boundary: the event file exists, but its
    // dedicated evidence commit did not finish.
    git(fixture.authoredRoot, "reset", "--mixed", first.commitSha);
    assert.match(
      git(fixture.authoredRoot, "status", "--porcelain", "--untracked-files=all", "--", "authority-attribution-events/v2"),
      /^\?\? authority-attribution-events\/v2\//u
    );

    const second = await submit("second publication recovers evidence\n");
    assert.equal(second.tag, "COMMITTED", JSON.stringify(second));
    if (second.tag !== "COMMITTED") return;
    assert.equal(git(fixture.authoredRoot, "status", "--porcelain", "--untracked-files=all", "--", "authority-attribution-events/v2"), "");
    const committedEvidence = git(
      fixture.authoredRoot,
      "show",
      "--format=",
      "--name-only",
      "HEAD",
      "--",
      "authority-attribution-events/v2"
    ).split("\n").filter(Boolean);
    assert.equal(committedEvidence.length, 2);
    assert.equal(committedEvidence.includes(path.relative(fixture.authoredRoot, firstEvent)), true);
    assert.equal(
      git(fixture.authoredRoot, "show", "-s", "--format=%s", "HEAD"),
      `authority: V2 attribution evidence for ${second.commitSha.slice(0, 12)}`
    );
    await lifecycle.stopAll("daemon-shutdown");
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
