// harness-test-tier: integration
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  parseCanonicalEvent,
  serializeCanonicalEvent,
} from "../../src/domain/doc-sync.contract.ts";
import {
  serializeTaskEvent,
  type TaskCreatedEvent,
} from "../../src/domain/task-lifecycle.contract.ts";
import { serializeEventHead } from "../../src/domain/write-chain.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import {
  contentObjectRelativePath,
  eventObjectRelativePath,
} from "../../src/layout/ledger-object-layout.ts";
import { localGitObjectRefStore } from "../../src/store/local-version-control-system.ts";
import {
  CANONICAL_EVENT_REF,
  makeTaskEventStore,
} from "../../src/store/task-event-store.ts";
import { withTempStoreAsync } from "./helpers.ts";
import {
  bundle,
  docBundle,
  event,
  eventAt,
  git,
  incrementalObjectBytes,
  initRepo,
  median,
  snapshot,
} from "./task-event-store.fixtures.ts";

test("canonical schema registry parses task/doc once and rejects unknown or non-canonical bytes", () => {
  assert.deepEqual(parseCanonicalEvent(serializeTaskEvent(event)), event);
  assert.throws(
    () =>
      parseCanonicalEvent(
        `${JSON.stringify({ ...event, schema: "unknown/v1" })}\n`,
      ),
    /unknown/u,
  );
  assert.throws(
    () => parseCanonicalEvent(`${JSON.stringify(event)}\n`),
    /not canonical/u,
  );
});

test("current writer rejects incomplete metadata with the exact missing field", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "metadata-boundary", rootDir }),
      metadata = {
        idempotencyKey: null,
        parentTaskId: null,
        workKind: null,
        riskTier: null,
        urgency: null,
        verticalId: "software/coding",
        presetId: "standard-task",
        profileId: "baseline",
        moduleKey: null,
        slug: "replay-task",
        surfaces: [],
      };
    const incomplete = {
      ...event,
      payload: { task: { ...event.payload.task, metadata } },
    } as unknown as TaskCreatedEvent;
    assert.throws(
      () => store.append(bundle(incomplete)),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_write_plan");
        assert.equal(
          (error as Error).message,
          "canonical write requires the current event shape: task metadata is missing required fields: fromLegacyId",
        );
        return true;
      },
    );
    assert.equal(store.readHead(), null);
  });
});

test("Git object reads distinguish a missing commit path from repository failure", async () => {
  await withTempStoreAsync(async (rootDir) => {
    assert.throws(
      () =>
        localGitObjectRefStore.readPath(
          rootDir,
          "0".repeat(40),
          "harness/events/head.json",
        ),
      (error: unknown) => {
        assert.deepEqual(
          {
            code: (error as { code?: string }).code,
            origin: (error as { origin?: string }).origin,
          },
          { code: "vcs_command_failed", origin: "git" },
        );
        return true;
      },
    );
    initRepo(rootDir);
    const commit = git(rootDir, "rev-parse", "HEAD");
    assert.equal(
      localGitObjectRefStore.readPath(
        rootDir,
        commit,
        "harness/events/head.json",
      ),
      null,
    );
    assert.throws(
      () =>
        localGitObjectRefStore.readPath(
          rootDir,
          "f".repeat(40),
          "harness/events/head.json",
        ),
      /git/u,
    );
  });
});

test("opening a settled event store does not scan event or content trees", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    makeTaskEventStore({ repoId: "startup-budget", rootDir });
    const before = localGitObjectRefStore.processCount();
    makeTaskEventStore({ repoId: "startup-budget", rootDir });
    const openedProcesses = localGitObjectRefStore.processCount() - before;
    assert.equal(
      openedProcesses <= 2,
      true,
      `settled store startup opened ${openedProcesses} Git processes`,
    );
  });
});

test("resident publication avoids redundant Git reads and leaves no prepared ref", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const store = makeTaskEventStore({ repoId: "resident-budget", rootDir });
    store.append(bundle(eventAt(1)));
    const receipt = store.append(bundle(eventAt(2)));
    assert.equal(receipt.metrics.gitProcesses, 4);
    assert.equal(
      git(
        rootDir,
        "for-each-ref",
        "--format=%(refname)",
        "refs/ha-event-prepared/",
      ).trim(),
      "",
    );
  });
});

test("reading the whole event stream validates every content blob in batches instead of one Git process per blob", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const count = 40,
      writer = makeTaskEventStore({ repoId: "stream-budget", rootDir });
    for (let revision = 1; revision <= count; revision += 1)
      writer.append(
        docBundle(
          writer,
          `# Doc ${revision}\n`,
          revision,
          `op-doc-${String(revision).padStart(4, "0")}`,
          `context/doc-${revision}.md`,
        ),
      );
    const store = makeTaskEventStore({ repoId: "stream-budget", rootDir }),
      before = localGitObjectRefStore.processCount(),
      stream = store.read(),
      readProcesses = localGitObjectRefStore.processCount() - before;
    assert.equal(stream.revision, count);
    assert.deepEqual(
      stream.events.map((value) => value.workspaceRevision),
      Array.from({ length: count }, (_value, index) => index + 1),
    );
    assert.equal(
      readProcesses <= 6,
      true,
      `reading ${count} events with one content blob each opened ${readProcesses} Git processes`,
    );
  });
});

test("batched stream validation still rejects an unreachable content blob", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    const writer = makeTaskEventStore({ repoId: "stream-corrupt", rootDir });
    writer.append(
      docBundle(writer, "# Doc 1\n", 1, "op-doc-0001", "context/doc-1.md"),
    );
    const hash = sha256Text("# Doc 1\n"),
      objectPath = path.join(
        rootDir,
        "harness",
        contentObjectRelativePath(hash),
      );
    writeFileSync(objectPath, "corrupt\n");
    git(rootDir, "add", "harness/objects");
    git(rootDir, "commit", "-qm", "corrupt blob");
    git(rootDir, "update-ref", CANONICAL_EVENT_REF, "HEAD");
    const store = makeTaskEventStore({ repoId: "stream-corrupt", rootDir });
    assert.throws(
      () => store.read(),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "invalid_store");
        return new RegExp(
          `content blob ${hash} is not reachable and exact`,
          "u",
        ).test(String(error));
      },
    );
  });
});

test("unified publication advances canonical and authored refs to one SHA while preserving index, prose, and every unrelated dirty path byte", async (context) => {
  await withTempStoreAsync(async (rootDir) => {
    initRepo(rootDir);
    mkdirSync(path.join(rootDir, "harness/context"), { recursive: true });
    writeFileSync(path.join(rootDir, "harness/context/user.md"), "draft\n");
    writeFileSync(path.join(rootDir, "dirty.txt"), "dirty\n");
    git(rootDir, "add", "harness/context/user.md");
    git(rootDir, "commit", "-qm", "user prose");
    writeFileSync(
      path.join(rootDir, "harness/context/user.md"),
      "draft plus local edit\n",
    );
    const before = snapshot(rootDir),
      head = git(rootDir, "rev-parse", "HEAD"),
      store = makeTaskEventStore({ repoId: "test-repo", rootDir }),
      receipt = store.append(bundle(event)),
      after = snapshot(rootDir);
    assert.deepEqual(after.bytes, before.bytes);
    assert.equal(after.status, before.status);
    assert.equal(
      (after.index as string).includes(before.index as string),
      true,
    );
    assert.notEqual(git(rootDir, "rev-parse", "HEAD"), head);
    assert.equal(store.currentCommit().sha, git(rootDir, "rev-parse", "HEAD"));
    assert.equal(existsSync(path.join(rootDir, "harness/events")), true);
    assert.equal(
      git(
        rootDir,
        "show",
        `${CANONICAL_EVENT_REF}:harness/${eventObjectRelativePath(event.opId)}`,
      ),
      serializeCanonicalEvent(event).trimEnd(),
    );
    assert.equal(store.readTaskEvent(event.opId)?.opId, event.opId);
    const reopened = makeTaskEventStore({ repoId: "test-repo", rootDir });
    assert.deepEqual(reopened.append(bundle(event)).metrics.changedPaths, []);
    assert.throws(
      () =>
        reopened.append(
          bundle({
            ...event,
            payload: { task: { ...event.payload.task, title: "different" } },
          }),
        ),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "op_conflict");
        return /different event/u.test(String(error));
      },
    );
    assert.equal(receipt.metrics.nodeSyncs, 4);
    context.diagnostic(
      `unified-publisher-git-processes=${receipt.metrics.gitProcesses}`,
    );
  });
});

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
