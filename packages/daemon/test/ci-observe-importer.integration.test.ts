// harness-test-tier: integration
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTaskEventStore, makeTaskProjection, createScheduleV1, type ScheduleV1 } from "@harness-anything/kernel";
import { withTempStoreAsync } from "../../kernel/test/store/helpers.ts";
import { reconcileCiOccurrence } from "../src/ci-observe-importer.ts";
import type { RepoTaskAction } from "../src/repo-cell-types.ts";
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
    firstArchiveError: null as Error | null,
    expired: false,
    missingRun: false,
    offline: false,
    rateLimited: false,
    authFailed: false,
    firstReadError: null as Error | null,
    readStage: "",
    transientEvery: 0,
    transientCalls: 0,
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
    if (state.firstReadError && api.includes("/runs/1/") && api.includes(state.readStage)) throw state.firstReadError;
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
    if (api.includes("/artifacts?") && state.transientEvery && ++state.transientCalls % state.transientEvery === 0)
      throw new Error("Get https://api.github.com/artifacts: EOF");
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
      if (args[2] === "1" && state.firstArchiveError) throw state.firstArchiveError;
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
    seedPending: (count: number) => void;
    request: (runId: number) => void;
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
    const requests: RepoTaskAction[] = [];
    const run = async () => {
      const result = await reconcileCiOccurrence({
        cell: cell as never,
        schedule: current,
        gh,
        requests: () => requests.splice(0),
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
        seedPending: (count) => {
          current = {
            ...current,
            status: {
              ...current.status,
              ciObserve: {
                workflow: "rewrite-ci",
                workflowIndex: 0,
                scanPass: 0,
                nextPage: 1,
                nextRunId: null,
                nextAttempt: 1,
                pending: Array.from({ length: count }, (_, i) => ({
                  runId: i + 1,
                  attempt: 1,
                  workflow: "rewrite-ci",
                })),
                unavailable: [],
                lastCompletedScanAt: null,
                error: null,
                retryAt: null,
              },
            },
          };
        },
        request: (runId) => requests.push({ kind: "ci-observe-pull", runs: [runId], attempts: { [runId]: 1 } }),
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
    assert.equal(store.readHead()!.revision, revision + 30);
    assert.equal((await run()).outcome, "succeeded");
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
    for (let occurrence = 1; occurrence <= 10; occurrence++) {
      assert.equal((await run()).outcome, "succeeded");
      assert.equal(current().status.ciObserve!.nextRunId, 1);
      assert.equal(current().status.ciObserve!.nextAttempt, occurrence * 20 + 1);
      assert.equal(current().status.ciObserve!.nextPage, 1);
      assert.equal(store.readHead()!.revision, occurrence * 60);
    }
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

for (const [mode, failure] of [
  ["normal", null],
  ["404", new Error("HTTP 404 Not Found: selected artifact archive")],
  [
    "azure-blob-failure",
    Object.assign(new Error("Command failed: gh run download 1"), {
      stderr: "error downloading artifact from Azure Blob Storage: HTTP 503 Service Unavailable",
    }),
  ],
] as const) {
  test(`a first archive ${mode} permits truthful recording, the later run and the empty scan tail`, async (t) => {
    await fixture(async ({ run, state, current, store }) => {
      state.runs = 2;
      state.firstArchiveError = failure;
      const checkpoints = [];
      for (let occurrence = 0; occurrence < 2; occurrence++) {
        const result = await run(),
          progress = current().status.ciObserve!,
          observations = store.read().events.filter((event) => event.schema === "ci-run-observation/v4");
        checkpoints.push({
          outcome: result.outcome,
          nextPage: progress.nextPage,
          nextRunId: progress.nextRunId,
          pending: progress.pending,
          unavailable: progress.unavailable,
          scanPass: progress.scanPass,
          events: observations.length,
          artifactRuns: observations
            .filter((event) => event.payload.detailRef !== null)
            .map((event) => event.payload.identity.databaseRunId),
          seen: [...state.seen],
        });
        t.diagnostic(JSON.stringify({ occurrence, checkpoint: checkpoints.at(-1), error: progress.error }));
      }
      const accepted = {
        outcome: "succeeded",
        nextRunId: null,
        pending: [],
        events: mode === "normal" ? 6 : 5,
        artifactRuns: mode === "normal" ? ["1", "2"] : ["2"],
        seen: ["1.1", "1.1", "2.1", "2.1"],
      };
      assert.deepEqual(
        checkpoints,
        [
          {
            ...accepted,
            nextPage: 2,
            scanPass: 0,
            unavailable: mode === "normal" ? [] : [{ runId: 1, attempt: 1, reason: "provider-artifact-unavailable" }],
          },
          { ...accepted, nextPage: 1, scanPass: 1, unavailable: [] },
        ],
        "one unavailable archive must not pin the scan or fabricate artifact evidence",
      );
    });
  });
}

for (const [name, failure, errorPattern, retryAt] of [
  [
    "rate-limit 403",
    Object.assign(new Error("Command failed: gh run download 1"), {
      stderr: "API rate limit exceeded; rate limit reset in 2m (HTTP 403)",
    }),
    /rate-limited/u,
    "2026-10-08T10:02:00.000Z",
  ],
  ["rate-limit 429", new Error("HTTP 429 rate limit; try again in 2m"), /rate-limited/u, "2026-10-08T10:02:00.000Z"],
  ["authentication", new Error("HTTP 401 authentication required"), /401/u, null],
  ["permission", new Error("HTTP 403 Forbidden"), /403/u, null],
  ["mixed disk and EOF", new Error("ENOSPC: no space left on device; unexpected EOF"), /ENOSPC/u, null],
  ["local filesystem", new Error("ENOSPC: no space left on device, open '/tmp/artifact.zip'"), /ENOSPC/u, null],
  ["programmer", new TypeError("unexpected fixture invariant"), /fixture invariant/u, null],
] as const) {
  test(`a download-stage ${name} failure remains fail-closed and pins the run cursor`, async () => {
    await fixture(async ({ run, state, current, store }) => {
      state.runs = 2;
      state.firstArchiveError = failure;
      const result = await run(),
        progress = current().status.ciObserve!;
      assert.equal(result.outcome, "failed");
      assert.match(progress.error!, errorPattern);
      assert.equal(progress.nextPage, 1);
      assert.equal(progress.nextRunId, 1);
      assert.deepEqual(progress.unavailable, []);
      assert.deepEqual(state.seen, ["1.1"], "the later run must not be visited after an occurrence failure");
      assert.equal(store.readHead(), null);
      assert.equal(progress.retryAt, retryAt);
    });
  });
}

test("a partially obtained attempt retains its missing job target even when another job detail exists", async () => {
  await fixture(async ({ run, state, current }) => {
    state.runs = 1;
    state.extraJob = true;
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.pending.length, 1);
  });
});

test("C1 intermittent listing EOF preserves page progress and publishes witnesses across occurrences", async (t) => {
  await fixture(async ({ run, state, current, store }) => {
    state.runs = 41;
    state.transientEvery = 7;
    for (let occurrence = 0; occurrence < 8; occurrence++) {
      const result = await run();
      t.diagnostic(JSON.stringify({ occurrence, outcome: result.outcome, progress: result.ciObserve }));
      assert.equal(result.outcome, "succeeded");
    }
    assert.ok(current().status.ciObserve!.lastCompletedScanAt);
    const witnesses = store
      .read()
      .events.filter((event) => event.schema === "ci-run-observation/v4" && event.payload.scope === "workflow");
    assert.equal(new Set(witnesses.map((event) => event.payload.identity.databaseRunId)).size, 41);
  });
});

for (const [mode, failure] of [
  ["EOF", new Error('Get "https://productionresultssa9.blob.core.windows.net/archive": EOF')],
  [
    "connection reset",
    Object.assign(new Error("Command failed: gh run download 1"), {
      stderr: "read tcp 127.0.0.1:1234->127.0.0.2:443: read: connection reset by peer",
    }),
  ],
  ["TLS interruption", new Error("net/http: TLS handshake timeout")],
  ["unexpected EOF", new Error("error downloading artifact: unexpected EOF")],
  ["offline", new Error("connect ENETUNREACH")],
] as const) {
  test(`C1 archive ${mode} retains a pending run while accepting the later run and finishing the scan`, async () => {
    await fixture(async ({ run, state, current, store }) => {
      state.runs = 2;
      state.firstArchiveError = failure;
      assert.equal((await run()).outcome, "succeeded");
      assert.equal(current().status.ciObserve!.nextPage, 2);
      assert.deepEqual(current().status.ciObserve!.pending, [{ runId: 1, attempt: 1, workflow: "rewrite-ci" }]);
      assert.equal(store.readHead()!.revision, 3);
      assert.equal((await run()).outcome, "succeeded");
      assert.ok(current().status.ciObserve!.lastCompletedScanAt);
      state.firstArchiveError = null;
      assert.equal((await run()).outcome, "succeeded");
      assert.equal(current().status.ciObserve!.pending.length, 0);
      assert.equal(store.readHead()!.revision, 6);
    });
  });
}

for (const stage of ["/artifacts?", "/attempts/1", "/jobs?"]) {
  test(`C1 transient ${stage} retains only that run and advances to the empty tail`, async () => {
    await fixture(async ({ run, state, current, store }) => {
      state.runs = 2;
      state.readStage = stage;
      state.firstReadError = new Error("read: connection reset by peer");
      assert.equal((await run()).outcome, "succeeded");
      assert.equal(current().status.ciObserve!.nextPage, 2);
      assert.deepEqual(current().status.ciObserve!.pending, [{ runId: 1, attempt: 1, workflow: "rewrite-ci" }]);
      assert.equal(store.readHead()!.revision, 3);
      assert.equal((await run()).outcome, "succeeded");
      assert.ok(current().status.ciObserve!.lastCompletedScanAt);
      state.firstReadError = null;
      assert.equal((await run()).outcome, "succeeded");
      assert.equal(current().status.ciObserve!.pending.length, 0);
      assert.equal(store.readHead()!.revision, 6);
    });
  });
}
for (const detail of ["HTTP 401; EOF", "HTTP 403; EOF", "HTTP 429; EOF", "ENOSPC; EOF"]) {
  test(`C1 listing ${detail} stays fail-closed`, async () => {
    await fixture(async ({ run, state, current, store }) => {
      state.runs = 2;
      state.readStage = "/artifacts?";
      state.firstReadError = new Error(detail);
      assert.equal((await run()).outcome, "failed");
      assert.equal(current().status.ciObserve!.nextPage, 1);
      assert.equal(store.readHead(), null);
    });
  });
}

test("explicit demand precedes a bounded pending batch and remaining diagnostics resume next occurrence", async () => {
  await fixture(async ({ run, state, current, seedPending, request }) => {
    seedPending(12);
    request(77);
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(state.seen[0], "77.1", "explicit demand must precede old artifact downloads");
    assert.equal(current().status.ciObserve!.pending.length, 7);
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.pending.length, 2);
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.pending.length, 0);
  });
});

test("one occurrence scans at most twenty attempts and resumes the first unprocessed attempt", async () => {
  await fixture(async ({ run, state, current }) => {
    state.runs = 1;
    state.latestAttempt = 21;
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.nextAttempt, 21);
    assert.equal(current().status.ciObserve!.nextRunId, 1);
    assert.equal(state.seen.includes("1.21"), false);
    assert.equal((await run()).outcome, "succeeded");
    assert.equal(current().status.ciObserve!.nextRunId, null);
    assert.equal(state.seen.includes("1.21"), true);
  });
});

test("a gh deadline failure counts the target as failed and permits later targets and settlement", async () => {
  await fixture(async ({ run, state, current }) => {
    state.runs = 2;
    state.firstArchiveError = Object.assign(new Error("Command failed: gh run download 1"), {
      killed: true,
      signal: "SIGTERM",
      code: null,
    });
    const result = await run();
    assert.equal(result.outcome, "succeeded");
    assert.match(result.detail!, /1 target/u);
    assert.deepEqual(current().status.ciObserve!.pending, [{ runId: 1, attempt: 1, workflow: "rewrite-ci" }]);
    assert.ok(state.seen.includes("2.1"));
  });
});

test("an unfinished pending target rotates behind later diagnostics instead of starving them", async () => {
  await fixture(async ({ run, state, current, seedPending }) => {
    seedPending(12);
    state.firstArchiveError = new Error("unexpected EOF");
    for (let occurrence = 0; occurrence < 3; occurrence++) assert.equal((await run()).outcome, "succeeded");
    assert.deepEqual(current().status.ciObserve!.pending, [{ runId: 1, attempt: 1, workflow: "rewrite-ci" }]);
    assert.ok(state.seen.includes("12.1"));
  });
});
