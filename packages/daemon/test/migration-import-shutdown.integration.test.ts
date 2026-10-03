// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { actor, initRepo, legacyFixture, sources } from "./migration-import.fixtures.ts";
import { openFencedRepoCell as openRepoCell } from "./repo-settings.fixture.ts";

for (const sourceCount of [1, 2])
  test(`shutdown before ${sourceCount}-source migration acceptance rejects without publishing a partial interval`, async () => {
    const scratch = mkdtempSync(path.join(tmpdir(), "ha-migration-shutdown-")),
      destination = path.join(scratch, "destination"),
      repoId = "migration-shutdown";
    let cell: Awaited<ReturnType<typeof openRepoCell>> | undefined;
    let stopping = true,
      stopChecks = 0;
    try {
      const sourceRoots = Array.from({ length: sourceCount }, (_, index) => {
        const source = path.join(scratch, `source-${index}`);
        legacyFixture(source);
        return sources(source)[0]!;
      });
      initRepo(destination);
      cell = await openRepoCell({
        repoId: workspaceId(repoId),
        rootDir: canonicalRoot(destination),
        ownerId: "migration-shutdown-test",
        shouldStop: () => {
          stopChecks += 1;
          return stopping;
        },
      });
      const reader = makeTaskEventReader({ rootDir: destination, repoId }),
        before = reader.read(),
        binding = withPolicyGroup({ actor, source: "local" as const }, "admin");
      const interrupted = await cell.run({ kind: "migrate-import", sourceRoots }, binding);
      assert.equal(interrupted.outcome, "op_rejected", JSON.stringify(interrupted));
      assert.equal(interrupted.code, "daemon_shutdown", JSON.stringify(interrupted));
      assert.ok(stopChecks > 0, "the real import must reach its pre-acceptance stop boundary");
      assert.deepEqual(reader.read(), before, "an interrupted plan must not publish any member");
      stopping = false;
      const accepted = await cell.run({ kind: "migrate-import", sourceRoots }, binding);
      assert.equal(accepted.status, "accepted_durable", JSON.stringify(accepted));
      const outcome = reader.readCommandOutcome(accepted.opId);
      assert.equal(outcome?.status, "accepted_durable");
      assert.ok(outcome.memberOpIds.length > 1);
    } finally {
      await cell?.close();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
