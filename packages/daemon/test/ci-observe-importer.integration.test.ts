// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection, createScheduleV1, type ScheduleV1 } from "@harness-anything/kernel";
import { withTempStoreAsync } from "../../kernel/test/store/helpers.ts";
import { reconcileCiOccurrence } from "../src/ci-observe-importer.ts";
import { ingestCiObservations, type RunGh } from "../src/ci-observation-actions.ts";

const actor = { principal: { personId: "ci-import-test" }, executor: null } as const;
const binding = { actor, source: "local" as const };
const now = "2026-10-08T10:00:00.000Z";
const sha = "a".repeat(40);
function schedule(): ScheduleV1 {
  return createScheduleV1({
    scheduleId: "builtin-ci-observe",
    name: "CI",
    mode: "detect",
    state: "armed",
    actor,
    occurredAt: now,
    spec: {
      trigger: { kind: "interval", everyMs: 60_000, anchorAt: now },
      target: { kind: "builtin", builtinId: "ci-observe" },
      mission: "CI reconciliation",
    },
  });
}

function provider() {
  const state = {
    runs: 0,
    latestAttempt: 1,
    artifacts: true,
    extraJob: false,
    artifactsOnSecondPage: false,
    archiveMissing: false,
    expired: false,
    missingRun: false,
    offline: false,
    rateLimited: false,
    authFailed: false,
    calls: [] as string[],
    seen: [] as string[],
  };
  let requestedAttempt = 1;
  const gh: RunGh = async (command, args, options) => {
    state.calls.push(args.join(" "));
    if (state.offline) throw new Error("offline");
    if (state.rateLimited) throw new Error("HTTP 429 rate limit; try again in 2m");
    if (state.authFailed) throw new Error("HTTP 401 authentication required");
    const api = args.find((arg) => arg.startsWith("repos/")) ?? "";
    if (api.includes("/workflows/")) {
      const page = Number(new URL(api, "https://fixture.invalid").searchParams.get("page"));
      const start = (page - 1) * 20;
      return JSON.stringify({
        workflow_runs: Array.from({ length: Math.max(0, Math.min(20, state.runs - start)) }, (_, i) => ({
          id: start + i + 1,
          run_attempt: state.latestAttempt,
          head_branch: "main",
          status: "completed",
        })),
      });
    }
    if (api.includes("/artifacts?")) {
      const runId = Number(api.split("/")[5]);
      const artifacts =
        state.artifacts || state.expired
          ? [
              {
                id: runId * 1000 + requestedAttempt,
                name: `ci-observation-${runId}-${requestedAttempt}-fast`,
                expired: state.expired,
              },
            ]
          : [];
      return JSON.stringify(
        state.artifactsOnSecondPage
          ? [
              {
                artifacts: Array.from({ length: 100 }, (_, i) => ({
                  id: 900000 + i,
                  name: `unrelated-${i}`,
                  expired: false,
                })),
              },
              {
                artifacts: [
                  ...artifacts,
                  { id: 800001, name: `ci-observation-${runId}-${requestedAttempt}-expired`, expired: true },
                  { id: 800002, name: `ci-observation-${runId}-${requestedAttempt + 1}-fast`, expired: false },
                ],
              },
            ]
          : [{ artifacts }],
      );
    }
    if (api.includes("/jobs"))
      return JSON.stringify([
        {
          jobs: [
            { id: Number(api.split("/")[5]) * 10, name: "fast" },
            ...(state.extraJob ? [{ id: Number(api.split("/")[5]) * 10 + 1, name: "missing-job" }] : []),
          ],
        },
        { jobs: [] },
      ]);
    if (api.includes("/attempts/")) {
      if (state.missingRun) throw new Error("HTTP 404 Not Found");
      const runId = api.split("/")[5]!,
        attempt = Number(api.split("/")[7]);
      requestedAttempt = attempt;
      state.seen.push(`${runId}.${attempt}`);
      return JSON.stringify({
        name: "rewrite-ci",
        head_sha: sha,
        head_branch: "main",
        status: "completed",
        conclusion: "success",
        run_attempt: attempt,
        event: "push",
        path: ".github/workflows/rewrite-ci.yml",
        workflow_id: 11,
        repository: { full_name: "fixture/repository" },
      });
    }
    if (command === "gh" && args[0] === "run" && args[1] === "download") {
      if (state.archiveMissing) throw new Error("HTTP 404 Not Found: selected artifact archive");
      const runId = args[2]!,
        dir = args[args.indexOf("--dir") + 1]!;
      assert.deepEqual(args.slice(3, -2), ["-n", `ci-observation-${runId}-${requestedAttempt}-fast`]);
      assert.equal(options.cwd.length > 0, true);
      mkdirSync(dir, { recursive: true });
      for (let attempt = requestedAttempt; attempt <= requestedAttempt; attempt++)
        writeFileSync(
          path.join(dir, `${attempt}.json`),
          JSON.stringify({
            schema: "ci-run-artifact/v2",
            producer: {
              repositoryId: "fixture/repository",
              workflow: ".github/workflows/rewrite-ci.yml",
              databaseRunId: runId,
              runAttempt: attempt,
              jobKey: '["fast",{}]',
              jobName: "fast",
            },
            run: {
              runId: `${runId}.${attempt}`,
              sha,
              branch: "main",
              job: "fast",
              prNumber: null,
              wallclockMs: 1,
              runner: "github-actions",
            },
            gates: [],
            detail: { schema: "ci-run-detail/v1", tests: [], fileOutcomes: [], diagnostics: [] },
            measurementCoverage: {
              status: "complete",
              missingReason: null,
              startedFileCount: 0,
              completedFileCount: 0,
            },
          }),
        );
      return "";
    }
    throw new Error(`unexpected gh call ${args.join(" ")}`);
  };
  return { state, gh };
}

async function fixture(
  work: (input: {
    run: () => ReturnType<typeof reconcileCiOccurrence>;
    state: ReturnType<typeof provider>["state"];
    store: ReturnType<typeof makeTaskEventStore>;
    current: () => ScheduleV1;
    crash: (point: "before-accept" | "after-accept" | null) => void;
  }) => Promise<void>,
) {
  await withTempStoreAsync(async (rootDir) => {
    const store = makeTaskEventStore({ rootDir, repoId: "ci-importer" });
    const projection = makeTaskProjection({ rootDir, eventStore: store });
    const { state, gh } = provider();
    let current = schedule(),
      crash: "before-accept" | "after-accept" | null = null;
    const cell = {
      rootDir,
      store,
      projection,
      now: () => now,
      settings: { read: () => ({ ci: { workflows: ["rewrite-ci"] } }) },
      cellCodedError: (code: string, message: string) => Object.assign(new Error(message), { code }),
    };
    const run = async () => {
      const result = await reconcileCiOccurrence({
        cell: cell as never,
        schedule: current,
        gh,
        requests: () => [],
        accept: async (fetched) => {
          if (fetched.runs.length && crash === "before-accept") throw new Error("crash before acceptance");
          const receipt = ingestCiObservations(cell as never, binding, fetched);
          if (fetched.runs.length && crash === "after-accept")
            throw new Error("crash after acceptance, before settlement");
          return receipt;
        },
      });
      current = { ...current, status: { ...current.status, ciObserve: result.ciObserve! } };
      return result;
    };
    try {
      await work({
        run,
        state,
        store,
        current: () => current,
        crash: (point) => {
          crash = point;
        },
      });
    } finally {
      projection.close();
    }
  });
}

test("reconciliation crosses 100 runs and the empty API tail; an old run's new attempt is imported on the next full pass", async () => {
  await fixture(async ({ run, state, store, current }) => {
    state.runs = 121;
    for (let page = 0; page < 8; page++) assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.scanPass, 1);
    assert.equal(current().status.ciObserve!.nextPage, 1);
    const revision = store.readHead()!.revision;
    assert.equal(revision, 363, "one workflow, one job and one authority inventory per run");
    state.latestAttempt = 2;
    assert.equal((await run()).outcome, "succeeded");
    assert.ok(state.seen.includes("1.2"));
    assert.equal(store.readHead()!.revision, revision + 60);
    assert.equal(current().status.ciObserve!.pending.length, 0);
  });
});

test("late and expired artifacts retain the workflow witness and a durable diagnostic target", async () => {
  await fixture(async ({ run, state, store, current }) => {
    state.runs = 1;
    state.artifacts = false;
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(store.readHead()!.revision, 2);
    assert.equal(current().status.ciObserve!.pending.length, 1);
    state.artifacts = true;
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(store.readHead()!.revision, 4);
    assert.equal(current().status.ciObserve!.pending.length, 0);
    state.runs = 2;
    state.artifacts = false;
    await run();
    await run();
    state.expired = true;
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.pending.length, 0);
    assert.equal(current().status.ciObserve!.unavailable[0]!.reason, "artifact-expired");
    assert.equal(store.readHead()!.revision, 6, "expiry cannot remove an accepted workflow witness");
  });
});

test("offline cycles, authentication errors and 429 leave the scan cursor intact; reset hints bound re-querying", async () => {
  await fixture(async ({ run, state, current, store }) => {
    state.runs = 1;
    state.offline = true;
    for (let cycle = 0; cycle < 3; cycle++) assert.equal((await run()).outcome, "failed");
    assert.equal(current().status.ciObserve!.nextPage, 1);
    assert.equal(store.readHead(), null);
    state.offline = false;
    state.authFailed = true;
    assert.match((await run()).ciObserve!.error!, /401/);
    state.authFailed = false;
    state.rateLimited = true;
    assert.match((await run()).ciObserve!.error!, /429/);
    const calls = state.calls.length;
    assert.equal(current().status.ciObserve!.retryAt, "2026-10-08T10:02:00.000Z");
    await run();
    assert.equal(state.calls.length, calls, "no provider call before its reset hint");
  });
});

test("a crash before acceptance or after append preserves continuation; replay cannot accept the same fact twice", async () => {
  await fixture(async ({ run, state, current, store, crash }) => {
    state.runs = 1;
    crash("before-accept");
    assert.equal((await run()).outcome, "failed");
    assert.equal(store.readHead(), null);
    assert.equal(current().status.ciObserve!.nextPage, 1);
    crash("after-accept");
    assert.equal((await run()).outcome, "failed");
    assert.equal(store.readHead()!.revision, 3);
    assert.equal(current().status.ciObserve!.nextPage, 1);
    crash(null);
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(store.readHead()!.revision, 3);
    assert.equal(current().status.ciObserve!.nextPage, 2);
  });
});

test("a run with hundreds of attempts resumes a bounded subpage instead of restarting after every occurrence", async () => {
  await fixture(async ({ run, state, current, store }) => {
    state.runs = 1;
    state.latestAttempt = 201;
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.nextRunId, 1);
    assert.equal(current().status.ciObserve!.nextAttempt, 101);
    assert.equal(current().status.ciObserve!.nextPage, 1);
    assert.equal(store.readHead()!.revision, 300);
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.nextAttempt, 201);
    assert.equal(store.readHead()!.revision, 600);
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.nextRunId, null);
    assert.equal(current().status.ciObserve!.nextPage, 2);
    assert.equal(store.readHead()!.revision, 603);
  });
});

test("artifact pages beyond 100 download only the exact unexpired attempt name and authoritatively expire diagnostics", async () => {
  await fixture(async ({ run, state, current, store }) => {
    state.runs = 1;
    state.artifactsOnSecondPage = true;
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(store.readHead()!.revision, 3);
    assert.ok(state.calls.some((call) => call.startsWith("run download 1 -n ci-observation-1-1-fast --dir ")));
    assert.equal(
      state.calls.some((call) => call.includes("-n unrelated-")),
      false,
    );
    state.artifacts = false;
    state.expired = true;
    state.latestAttempt = 2;
    await run(); // authoritative empty tail ends the first pass
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.pending.length, 0);
    assert.ok(
      current().status.ciObserve!.unavailable.some(
        (target) => target.attempt === 2 && target.reason === "artifact-expired",
      ),
    );
  });
});

test("a selected archive's authoritative 404 ends diagnostics visibly while retaining the trusted workflow", async () => {
  await fixture(async ({ run, state, current, store }) => {
    state.runs = 1;
    state.archiveMissing = true;
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(store.readHead()!.revision, 2, "the workflow verdict survives missing diagnostics");
    assert.equal(current().status.ciObserve!.pending.length, 0);
    assert.deepEqual(current().status.ciObserve!.unavailable, [
      { runId: 1, attempt: 1, reason: "provider-artifact-unavailable" },
    ]);
  });
});

test("a partially obtained attempt retains its missing job target even when another job detail exists", async () => {
  await fixture(async ({ run, state, current }) => {
    state.runs = 1;
    state.extraJob = true;
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.pending.length, 1);
  });
});
