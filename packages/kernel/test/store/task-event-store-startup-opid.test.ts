// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  DOC_CODEC_ID,
  DOC_POLICY_ID,
  docSyncWritePlan,
  parseCanonicalEvent,
  serializeCanonicalEvent,
  type DocEventV1,
} from "../../src/domain/doc-sync.contract.ts";
import {
  compileDecisionWrite,
  decisionWritePlan,
  type DecisionDocumentState,
  type DecisionEventDraftV1,
} from "../../src/domain/decision-event.ts";
import { REPLAY_TASK_GRAPH } from "../../src/domain/task-graph.ts";
import {
  serializeTaskEvent,
  type TaskCreatedEvent,
} from "../../src/domain/task-lifecycle.contract.ts";
import { taskLifecycleWritePlan } from "../../src/domain/task-lifecycle-publication.ts";
import {
  freezeDeclaredWritePlan,
  serializeEventHead,
} from "../../src/domain/write-chain.contract.ts";
import {
  MIGRATION_DOCUMENT_POLICY_ID,
  migrationImportWritePlan,
  type MigrationImportEventV1,
} from "../../src/domain/migration-import-event.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import {
  contentObjectRelativePath,
  eventObjectRelativePath,
} from "../../src/layout/ledger-object-layout.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import {
  CANONICAL_EVENT_REF,
  makeTaskEventStore,
  type CanonicalWriteBundle,
} from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";

import {
  bundle,
  decisionProposal,
  docBundle,
  event,
  eventAt,
  flatLedgerFixture,
  git,
  incrementalObjectBytes,
  initRepo,
  median,
  mixedLedgerFixture,
  repoFileBundle,
  repoLinkBundle,
  snapshot,
} from "./task-event-store.fixtures.ts";
test("startup recovery is independent of 100 versus 10,000-event history", async (context) => {
  const prepare = (rootDir: string, count: number) => {
    initRepo(rootDir);
    const eventsRoot = path.join(rootDir, "harness/events");
    mkdirSync(eventsRoot, { recursive: true });
    let last = event;
    for (let revision = 1; revision <= count; revision += 1) {
      last = eventAt(revision);
      const target = path.join(
        rootDir,
        "harness",
        eventObjectRelativePath(last.opId),
      );
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, serializeTaskEvent(last));
    }
    const bytes = serializeTaskEvent(last);
    writeFileSync(
      path.join(eventsRoot, "head.json"),
      serializeEventHead({
        revision: count,
        opId: last.opId,
        eventDigest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      }),
    );
    git(rootDir, "add", "harness/events");
    git(rootDir, "commit", "-qm", `${count} events`);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      appendParent = store.currentCommit().sha,
      appendReceipt = store.append(bundle(eventAt(count + 1))),
      objectBytes = incrementalObjectBytes(
        rootDir,
        appendParent,
        appendReceipt.commitSha.sha,
      );
    return {
      rootDir,
      count,
      nextRevision: count + 2,
      appendProcesses: appendReceipt.metrics.gitProcesses,
      objectBytes,
    };
  };
  const recoverOnce = (fixture: ReturnType<typeof prepare>) => {
    const next = eventAt(fixture.nextRevision);
    fixture.nextRevision += 1;
    const interrupted = makeTaskEventStore({
      repoId: "test-repo",
      rootDir: fixture.rootDir,
      killpoint: (point) => {
        if (point === "after_head_write") throw new Error("crash");
      },
    });
    assert.throws(() => interrupted.append(bundle(next)), /crash/u);
    const started = performance.now(),
      store = makeTaskEventStore({
        repoId: "test-repo",
        rootDir: fixture.rootDir,
      }),
      constructorMs = performance.now() - started,
      recovered = store.recover();
    assert.equal(recovered.status, "committed");
    return {
      totalMs: constructorMs + recovered.elapsedMs,
      constructorMs,
      recoverMs: recovered.elapsedMs,
    };
  };
  await withTempStoreAsync(async (hundredRoot) =>
    withTempStoreAsync(async (thousandRoot) =>
      withTempStoreAsync(async (tenThousandRoot) => {
        const hundred = prepare(hundredRoot, 100),
          thousand = prepare(thousandRoot, 1_000),
          tenThousand = prepare(tenThousandRoot, 10_000),
          hundredSamples: ReturnType<typeof recoverOnce>[] = [],
          tenThousandSamples: ReturnType<typeof recoverOnce>[] = [],
          ratios: number[] = [];
        for (let round = 0; round < 11; round += 1) {
          let hundredSample: ReturnType<typeof recoverOnce> | undefined,
            tenThousandSample: ReturnType<typeof recoverOnce> | undefined;
          const order =
            round % 2 === 0 ? [hundred, tenThousand] : [tenThousand, hundred];
          for (const fixture of order) {
            const sample = recoverOnce(fixture);
            if (fixture.count === 100) hundredSample = sample;
            else tenThousandSample = sample;
          }
          assert.ok(hundredSample);
          assert.ok(tenThousandSample);
          hundredSamples.push(hundredSample);
          tenThousandSamples.push(tenThousandSample);
          ratios.push(tenThousandSample.totalMs / hundredSample.totalMs);
        }
        const totals = (samples: readonly ReturnType<typeof recoverOnce>[]) =>
            samples.map((sample) => sample.totalMs),
          constructors = (samples: readonly ReturnType<typeof recoverOnce>[]) =>
            samples.map((sample) => sample.constructorMs),
          recoveries = (samples: readonly ReturnType<typeof recoverOnce>[]) =>
            samples.map((sample) => sample.recoverMs),
          describe = (values: readonly number[]) =>
            `p50=${median(values).toFixed(3)}ms min=${Math.min(...values).toFixed(3)}ms max=${Math.max(...values).toFixed(3)}ms`;
        context.diagnostic(
          `recovery-samples history=100 samples=${hundredSamples.length} total(${describe(totals(hundredSamples))}) constructor(${describe(constructors(hundredSamples))}) recover(${describe(recoveries(hundredSamples))})`,
        );
        context.diagnostic(
          `recovery-samples history=10000 samples=${tenThousandSamples.length} total(${describe(totals(tenThousandSamples))}) constructor(${describe(constructors(tenThousandSamples))}) recover(${describe(recoveries(tenThousandSamples))})`,
        );
        const orderedRatios = [...ratios].sort((left, right) => left - right),
          ratio = median(ratios),
          objectRatio = tenThousand.objectBytes / thousand.objectBytes;
        context.diagnostic(
          `recovery-ratio=paired-10000-over-100 samples=${ratios.length} p50=${ratio.toFixed(3)}x min=${orderedRatios[0]!.toFixed(3)}x max=${orderedRatios.at(-1)!.toFixed(3)}x appendObjectBytes1000=${thousand.objectBytes} appendObjectBytes10000=${tenThousand.objectBytes} objectRatio=${objectRatio.toFixed(3)}`,
        );
        assert.equal(
          ratio < 2,
          true,
          `10k/100 paired p50 ratio ${ratio} (spread ${orderedRatios[0]}-${orderedRatios.at(-1)})`,
        );
        assert.equal(
          tenThousand.appendProcesses,
          hundred.appendProcesses,
          "append Git subprocess count must be history-independent",
        );
        assert.equal(
          objectRatio < 2,
          true,
          `10k/1k append object-byte ratio ${objectRatio}`,
        );
      }),
    ),
  );
});

// #1587: the predicate passing is not the same as the predicate being wired into publication.
// This drives a real append, so removing the assertion from assertBundle turns it red — the
// unit test over assertPublishableOpId alone stayed green when the call site was deleted.
test("#1587: publishing an event whose opId cannot be a filename is refused, and nothing is written", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      before = store.currentCommit();
    const unportable = {
      ...event,
      opId: "runtime-spawn-abcdef:installation",
    } as typeof event;
    assert.throws(
      () =>
        store.append({
          event: unportable,
          plan: taskLifecycleWritePlan(unportable),
          blobs: [],
        }),
      /cannot be a filename/u,
    );
    assert.deepEqual(store.currentCommit(), before);
    assert.equal(store.readEvent(unportable.opId), null);
    // The legal spelling of the same publication still goes through.
    const portable = {
      ...event,
      opId: "runtime-spawn-abcdef-installation",
    } as typeof event;
    assert.equal(
      store.append({
        event: portable,
        plan: taskLifecycleWritePlan(portable),
        blobs: [],
      }).commitSha.sha.length,
      40,
    );
  });
});
