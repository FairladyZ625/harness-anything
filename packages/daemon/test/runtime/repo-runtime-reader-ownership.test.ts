// harness-test-tier: integration
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  rebuildTaskProjection,
  type ProjectionSourceFenceFactory
} from "@harness-anything/kernel";
import { createDaemonRuntime } from "../../src/runtime/repo-runtime.ts";
import { docWrite, withTempStoreAsync } from "./helpers/store.ts";
import {
  commitAuthoredFixture,
  daemonAttribution,
  git,
  initAuthoredGit,
  stableProjectionFence,
  writeExecutionEvidenceFixture
} from "./helpers/daemon-runtime.ts";

const testAttribution = daemonAttribution("person_test", "test", "credential-test");
const projectionFenceFactory: ProjectionSourceFenceFactory = ({ rootDir }) => {
  const fence = stableProjectionFence(
    `test-${path.basename(rootDir)}`,
    git(rootDir, "rev-parse", "HEAD"),
    []
  );
  return { capture: () => fence };
};

test("reader runtime owns no lock or inline writer while one child runtime owns both", async () => {
  await withTempStoreAsync(async (rootDir) => {
    writeExecutionEvidenceFixture(rootDir, "Reader-owned projection");
    initAuthoredGit(rootDir);
    commitAuthoredFixture(rootDir);
    rebuildTaskProjection({ rootDir });
    const parentReader = createDaemonRuntime({
      rootDir,
      writeOwnership: "reader",
      materializerPollMs: false,
      projectionSourceFenceFactory: projectionFenceFactory
    });
    const childWriter = createDaemonRuntime({
      rootDir,
      writeOwnership: "writer",
      materializerPollMs: false,
      projectionSourceFenceFactory: projectionFenceFactory
    });
    const competingWriter = createDaemonRuntime({
      rootDir,
      materializerPollMs: false
    });

    const readerStatus = await parentReader.start();
    assert.equal(readerStatus.started, true);
    assert.equal(readerStatus.writeOwnership, "reader");
    assert.equal(readerStatus.lockPath, undefined);
    assert.equal(
      (await parentReader.queryExecutionEvidencePage({ limit: 1 }))
        .groups[0]?.title,
      "Reader-owned projection"
    );
    assert.throws(
      () => parentReader.enqueueInteractiveWrite({
        commandId: "parent-inline-forbidden",
        attribution: testAttribution,
        ops: [
          docWrite(
            "op-parent-inline-forbidden",
            "task-reader",
            "note.md",
            "forbidden"
          )
        ]
      }),
      (error: unknown) => {
        assert.equal(
          (error as { readonly _tag?: unknown })._tag,
          "JournalUnavailable"
        );
        assert.match(
          (error as { readonly cause: Error }).cause.message,
          /write ownership belongs to its child capsule/u
        );
        return true;
      }
    );

    const writerStatus = await childWriter.start();
    assert.equal(writerStatus.writeOwnership, "writer");
    assert.ok(writerStatus.lockPath);
    await assert.rejects(
      competingWriter.start(),
      /lock already held|global\.lock/u
    );

    await childWriter.stop();
    await parentReader.stop();
  });
});
