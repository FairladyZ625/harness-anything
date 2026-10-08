// harness-test-tier: integration
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { makeTaskEventStore } from "@harness-anything/kernel";
import { makeTaskProjection } from "@harness-anything/kernel";
import { withTempStoreAsync } from "../../kernel/test/store/helpers.ts";
import { ciDetailMeasurement } from "@harness-anything/kernel";
import { legacyCiDetail } from "../../kernel/test/fixtures/ci-observation.ts";
import { ciRunObservationWritePlan } from "@harness-anything/kernel";
import type { CiRunObservationEventV4 } from "@harness-anything/kernel";
import { fetchCiObservations, ingestCiObservations } from "../src/ci-observation-actions.ts";
import { readCiObservatory } from "../src/ci-observatory-read.ts";

function initialize(root: string) {
  for (const args of [
    ["init", "-q"],
    ["config", "user.name", "Acceptance Fixture"],
    ["config", "user.email", "acceptance@example.invalid"],
    ["commit", "--allow-empty", "-qm", "fixture"],
  ])
    execFileSync("git", args, { cwd: root });
}
const workflow = JSON.parse(
  readFileSync(
    new URL("../../kernel/fixtures/canonical-events/ci-run-observation-v4/workflow.json", import.meta.url),
    "utf8",
  ),
) as CiRunObservationEventV4;
const detail = {
  schema: "ci-run-detail/v1" as const,
  tests: [
    {
      testKey: "test-1",
      file: "tools/example.test.mjs",
      name: "assertion",
      suite: ["suite"],
      executionOrdinal: 1,
      declarationLocation: { line: 2, column: 1 },
      failureLocation: { file: "tools/example.test.mjs", line: 4, column: 2 },
      tier: "fast",
      shard: null,
      durationMs: 2,
      status: "failed" as const,
      failureSummary: "assertion failed",
      truncated: false,
      error: {
        name: "Error",
        message: "assertion failed",
        stack: "full stack",
        cause: { name: "Error", message: "underlying", stack: "cause stack", cause: null },
      },
    },
  ],
  fileOutcomes: [],
  diagnostics: [],
};
const body = JSON.stringify(detail),
  sha256 = createHash("sha256").update(body).digest("hex");
const job: CiRunObservationEventV4 = {
  ...workflow,
  opId: "op-v4-job",
  eventId: "event-v4-job",
  payload: {
    ...workflow.payload,
    scope: "job",
    identity: { ...workflow.payload.identity, jobExecutionId: "456", jobKey: '["fast-contract",{}]' },
    verification: null,
    measurementCoverage: { status: "complete", missingReason: null, startedFileCount: 1, completedFileCount: 1 },
    ...ciDetailMeasurement(detail),
    detailRef: {
      schema: "ci-run-detail/v1",
      sha256,
      mediaType: "application/json",
      encoding: "identity",
      encodedBytes: Buffer.byteLength(body),
      decodedBytes: Buffer.byteLength(body),
    },
  },
};
const blobs = [{ sha256, size: Buffer.byteLength(body), mediaType: "application/json", body }];

test("v4 mandatory detail is durable before acceptance; crash and mismatched measurement cannot leave a dangling reference", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initialize(rootDir);
    let kill = true;
    const store = makeTaskEventStore({
      rootDir,
      repoId: "v4-acceptance",
      killpoint: (point) => {
        if (kill && point === "after_event_write") throw new Error("acceptance crash");
      },
    });
    assert.throws(() => store.append({ event: job, plan: ciRunObservationWritePlan(job), blobs: [] }), /missing/);
    assert.equal(store.readHead(), null);
    assert.throws(() => store.append({ event: job, plan: ciRunObservationWritePlan(job), blobs }), /acceptance crash/);
    assert.equal(store.readHead(), null);
    assert.equal(store.readEvent(job.opId), null);
    assert.equal(Buffer.from(store.readContentBlob(sha256)!).toString(), body, "durable orphan has no event ref");
    kill = false;
    const mismatch = { ...job, payload: { ...job.payload, shardDurations: [] } };
    assert.throws(
      () => store.append({ event: mismatch, plan: ciRunObservationWritePlan(mismatch), blobs }),
      /hot measurement differ/,
    );
    assert.equal(store.readHead(), null);
    store.append({ event: job, plan: ciRunObservationWritePlan(job), blobs });
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    projection.rebuild();
    const read = projection.readCiRunObservations(10);
    assert.equal(read.events[0]!.payload.failedTests[0]!.failureSummary, "assertion failed");
    assert.equal("error" in read.events[0]!.payload.failedTests[0]!, false);
    assert.equal("tests" in store.readEvent(job.opId)!.payload, false);
    assert.deepEqual(JSON.parse(Buffer.from(store.readContentBlob(sha256)!).toString()), detail);
    projection.close();
  });
});

test("artifact producer is bound to the specific attempt/job API before v4 CAS acceptance; workflow verdict remains separate", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initialize(rootDir);
    const store = makeTaskEventStore({ rootDir, repoId: "v4-provider" });
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    const cell = {
      rootDir,
      store,
      projection,
      now: () => workflow.occurredAt,
      settings: { read: () => ({ ci: { workflows: ["rewrite-ci"] } }) },
      cellCodedError: (_code: string, message: string) => new Error(message),
    };
    let wrong = false;
    const runner = async (_command: string, args: readonly string[]) => {
      if (args[1] === "view")
        return JSON.stringify({
          workflowName: "rewrite-ci",
          headSha: workflow.payload.run.sha,
          headBranch: "main",
          status: "completed",
          conclusion: "failure",
          attempt: 2,
          event: "push",
        });
      if (args[1] === "download") {
        const dir = args[args.indexOf("--dir") + 1]!;
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path.join(dir, "observation.json"),
          JSON.stringify({
            schema: "ci-run-artifact/v2",
            producer: {
              repositoryId: "fixture/repository",
              workflow: ".github/workflows/rewrite-ci.yml",
              databaseRunId: "123",
              runAttempt: 2,
              jobKey: '["fast-contract",{}]',
              jobName: wrong ? "wrong" : "fast-contract",
            },
            run: { ...workflow.payload.run, job: "fast-contract" },
            gates: [],
            detail,
            measurementCoverage: job.payload.measurementCoverage,
          }),
        );
        return "";
      }
      // gh rejects --slurp combined with --jq/--template before any request, and --paginate
      // --slurp prints one JSON array holding every page verbatim (here: a job page, then an
      // empty final page, so the flatten in fetchCiObservations has to cross pages).
      if (args.includes("--slurp")) {
        if (args.includes("--jq") || args.includes("--template"))
          throw new Error("the `--slurp` option is not supported with `--jq` or `--template`");
        return JSON.stringify([{ jobs: [{ id: 456, name: "fast-contract" }] }, { jobs: [] }]);
      }
      assert.equal(args[1], "repos/:owner/:repo/actions/runs/123/attempts/2");
      return JSON.stringify({
        run_attempt: 2,
        head_sha: workflow.payload.run.sha,
        head_branch: "main",
        conclusion: "failure",
        event: "push",
        name: "rewrite-ci",
        path: ".github/workflows/rewrite-ci.yml",
        workflow_id: 1,
        repository: { full_name: "fixture/repository" },
      });
    };
    wrong = true;
    await assert.rejects(
      fetchCiObservations(cell as never, { kind: "ci-observe-pull", runs: [123] }, runner),
      /ambiguous or mismatched/,
    );
    assert.equal(store.readHead(), null);
    wrong = false;
    const fetched = await fetchCiObservations(cell as never, { kind: "ci-observe-pull", runs: [123] }, runner);
    const first = ingestCiObservations(cell as never, { actor: workflow.actor, source: "local" }, fetched);
    assert.equal(JSON.parse(first.evidence).imported, 2);
    assert.equal(
      JSON.parse(ingestCiObservations(cell as never, { actor: workflow.actor, source: "local" }, fetched).evidence)
        .duplicate,
      2,
    );
    projection.catchUp();
    const result = readCiObservatory({ rootDir, projection });
    assert.equal(result.runs.find((row) => row.job === "rewrite-ci")!.pass, false);
    assert.equal(result.runs.find((row) => row.job === "rewrite-ci")!.testCount, null);
    assert.equal(
      result.runs.find((row) => row.job === "fast-contract")!.failedTests[0]!.failureSummary,
      "assertion failed",
    );
    projection.close();
  });
});

test("manual pull then completion collection separates ledger commits and preserves duplicate/conflict checks", async () => {
  await withTempStoreAsync(async (rootDir) => {
    initialize(rootDir);
    const ledgerRoot = path.join(rootDir, "harness");
    mkdirSync(ledgerRoot, { recursive: true });
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: ledgerRoot });
    const publishLedger = (body: string) => {
      writeFileSync(path.join(ledgerRoot, "note.md"), body);
      execFileSync("git", ["add", "note.md"], { cwd: ledgerRoot });
      execFileSync(
        "git",
        ["-c", "user.name=Acceptance Fixture", "-c", "user.email=acceptance@example.invalid", "commit", "-qm", body],
        { cwd: ledgerRoot },
      );
    };
    publishLedger("first private publication");
    const store = makeTaskEventStore({ rootDir, repoId: "v4-ledger-identity" });
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    const cell = {
      rootDir,
      store,
      projection,
      now: () => workflow.occurredAt,
      settings: { read: () => ({ ci: { workflows: ["rewrite-ci"] } }) },
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    };
    const runner = async (_command: string, args: readonly string[]) => {
      if (args[1] === "list")
        return JSON.stringify([{ databaseId: 123, headBranch: "main", createdAt: workflow.occurredAt }]);
      if (args[1] === "view")
        return JSON.stringify({
          workflowName: "rewrite-ci",
          headSha: workflow.payload.run.sha,
          headBranch: "main",
          status: "completed",
          conclusion: "success",
          attempt: 2,
          event: "push",
        });
      if (args[1] === "download") throw new Error("no valid artifacts found to download");
      assert.equal(args[1], "repos/:owner/:repo/actions/runs/123/attempts/2");
      return JSON.stringify({
        run_attempt: 2,
        head_sha: workflow.payload.run.sha,
        head_branch: "main",
        conclusion: "success",
        event: "push",
        name: "rewrite-ci",
        path: ".github/workflows/rewrite-ci.yml",
        workflow_id: 1,
        repository: { full_name: "fixture/repository" },
      });
    };
    const ingest = (fetched: Awaited<ReturnType<typeof fetchCiObservations>>) =>
      JSON.parse(ingestCiObservations(cell as never, { actor: workflow.actor, source: "local" }, fetched).evidence);
    try {
      const manual = await fetchCiObservations(cell as never, { kind: "ci-observe-pull", runs: [123] }, runner);
      assert.equal(ingest(manual).imported, 1);
      const githubOpId = `ci-observation-${createHash("sha256")
        .update(JSON.stringify(["github-actions", "fixture/repository", 123, 2, "workflow", null]))
        .digest("hex")}`;
      assert.ok(store.readEvent(githubOpId), "GitHub observation identities remain unchanged");
      const first = await fetchCiObservations(cell as never, { kind: "ci-observe-pull" }, runner);
      const collected = ingest(first);
      assert.deepEqual([collected.imported, collected.duplicate], [1, 1]);
      assert.equal(ingest(first).duplicate, 2);
      publishLedger("second private publication");
      const second = await fetchCiObservations(cell as never, { kind: "ci-observe-pull" }, runner);
      const next = ingest(second);
      assert.deepEqual([next.imported, next.duplicate], [1, 1]);
      const repeated = ingest(second);
      assert.deepEqual([repeated.imported, repeated.duplicate], [0, 2]);
      const ledgerEvents = projection
        .readCiRunObservations(10)
        .events.filter((event) => event.payload.identity.provider === "write-coordinator");
      assert.equal(ledgerEvents.length, 2);
      assert.equal(new Set(ledgerEvents.map((event) => event.opId)).size, 2);
      assert.equal(new Set(ledgerEvents.map((event) => event.payload.run.sha)).size, 2);
      for (const provider of ["github-actions", "write-coordinator"])
        assert.throws(
          () =>
            ingest({
              ...second,
              runs: second.runs.map((run) =>
                (run.databaseId === 0) === (provider === "write-coordinator")
                  ? { ...run, summary: { ...run.summary, conclusion: "failure" } }
                  : run,
              ),
            }),
          { code: "op_conflict" },
          "different content for the same identity still fails",
        );
    } finally {
      projection.close();
    }
  });
});

test("frozen v2/v3 bytes survive one decoder and a cold projection replay without historical rewrites", async () => {
  await withTempStoreAsync(async (rootDir) => {
    const history = ["v2", "v3"].map((version) =>
      readFileSync(
        new URL(`../../kernel/fixtures/canonical-events/ci-run-observation-${version}/accepted.json`, import.meta.url),
        "utf8",
      ),
    );
    const events = history.map((bytes, index) => ({ ...JSON.parse(bytes), workspaceRevision: index + 1 }));
    const reader = {
      readHead: () => ({
        repoId: "history",
        revision: 2,
        eventId: events[1].eventId,
        opId: events[1].opId,
        digest: "0".repeat(64),
      }),
      readBatch: () => ({
        events,
        sourceRevision: 2,
        cursor: null,
        done: true,
        accessedItems: 2,
        prefetchContent: () => new Map(),
      }),
      readContentBlob: () => null,
    };
    const projection = makeTaskProjection({ rootDir, eventStore: reader as never });
    projection.rebuild();
    const read = projection.readCiRunObservations(10);
    assert.equal(read.events.length, 2);
    assert.ok(
      read.events.every(
        (event) => event.payload.scope === "legacy" && event.payload.measurementCoverage.status === "unknown",
      ),
    );
    for (const [index, bytes] of history.entries()) {
      const original = JSON.parse(bytes);
      assert.equal(legacyCiDetail(original).tests.length, original.payload.tests.length);
      assert.equal(
        readFileSync(
          new URL(
            `../../kernel/fixtures/canonical-events/ci-run-observation-v${index + 2}/accepted.json`,
            import.meta.url,
          ),
          "utf8",
        ),
        bytes,
      );
    }
    projection.close();
  });
});
