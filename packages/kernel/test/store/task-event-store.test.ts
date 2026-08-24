// harness-test-tier: integration
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { parseCanonicalEvent } from "../../src/domain/doc-sync.contract.ts";
import {
  serializeTaskEvent,
  type TaskCreatedEvent,
} from "../../src/domain/task-lifecycle.contract.ts";
import { sha256Text } from "../../src/integrity/stable-hash.ts";
import { contentObjectRelativePath } from "../../src/layout/ledger-object-layout.ts";
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
  initRepo,
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
