// harness-test-tier: fast
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import type { SubmissionV1, TaskProjectionQueries } from "@harness-anything/kernel";
import { checkPrGovernance } from "../../../tools/check-pr-governance.mjs";
import { publishTaskWorkerBranch, updateTaskPullRequestBody } from "../src/runtime-task-publication.ts";
import { publishExit } from "../src/runtime-spawn-settlement.ts";
import { taskPrBodyRenderer } from "../src/task-pr-body-render.ts";
import {
  git,
  workerGitFixture,
  workerSettlementContext,
  workerSettlementRuntime,
} from "./runtime-spawn-settlement.fixtures.ts";

// The lint only accepts the canonical 26-character task-id shape; the shared fixture id predates it.
const taskId = "task_0123456789abcdef0123456789",
  packagePath = `tasks/${taskId}-rendered-pr`,
  protectedFile = "tools/gate-allowlists/example.json",
  manifest = {
    gates: [
      {
        id: "example-gate",
        changeControl: { requiresGovernanceEvidence: true, protectedSurfaces: ["tools/gate-allowlists/**"] },
      },
    ],
  },
  template = readFileSync(path.resolve(import.meta.dirname, "../../../.github/pull_request_template.md"), "utf8"),
  closeout = `# Closeout

## Summary

Rendered from the frozen cut.

## What Changed

- Touched a protected allowlist.

## Verification

- Targeted test passed.

## Residual Risk

- None.

## 摘要

从冻结 cut 生成。

## 验证

- 定向测试通过。
`;

function submission(commitSha: string): SubmissionV1 {
  return {
    commitSha,
    completionClaim: "Rendered from the frozen cut.",
    verificationNotes: ["Targeted test passed."],
    residualRisks: [],
    knownGaps: [],
    deliverables: [protectedFile],
    outputs: [],
    changedFiles: [protectedFile],
    productionDelta: { baseSha: "b".repeat(40), added: 1, deleted: 0, changed: [], unclassified: [] },
    completionContract: {} as never,
  };
}

/** The minimal projection surface `readTaskTransitionDocument` needs for a closeout. */
function projection(sha: string): TaskProjectionQueries {
  const frozen = submission(sha),
    contractPath = `${packagePath}/task-contract.json`,
    closeoutPath = `${packagePath}/closeout.md`;
  return {
    read: () => ({
      watermark: 1,
      sourceRevision: 1,
      packagePath,
      snapshot: {
        task: { taskId, presetSnapshotDigest: "sha256:preset", metadata: { profileId: "baseline" } },
        reviews: [],
        decisionRelations: [],
        executions: [{ executionId: "execution-owner", submission: frozen }],
      },
    }),
    readPresetSnapshot: () => ({ snapshot: { profile: { outputShape: "repository-diff" } } }),
    readDocument: (documentPath: string) => ({
      watermark: 1,
      sourceRevision: 1,
      document:
        documentPath === contractPath
          ? {
              path: contractPath,
              body: JSON.stringify({ documents: [{ slot: "task.closeout", path: "closeout.md" }] }),
            }
          : documentPath === closeoutPath
            ? { path: closeoutPath, body: closeout }
            : null,
    }),
  } as never;
}

function addBodyInputs(canonicalRoot: string): void {
  mkdirSync(path.join(canonicalRoot, ".github"), { recursive: true });
  mkdirSync(path.join(canonicalRoot, "tools"), { recursive: true });
  writeFileSync(path.join(canonicalRoot, ".github", "pull_request_template.md"), template);
  writeFileSync(path.join(canonicalRoot, "tools", "gate-manifest.json"), JSON.stringify(manifest));
}

function publication(context: test.TestContext, slug: string, options: { readonly bodyInputs?: boolean } = {}) {
  const fixture = workerGitFixture(context, slug, { reachableRemote: true }),
    head = git(fixture.worker, "rev-parse", "HEAD").trim(),
    frozen = submission(head);
  // The push port publishes only a branch named after the task id.
  git(fixture.worker, "branch", "-m", taskId);
  if (options.bodyInputs !== false) addBodyInputs(fixture.canonical);
  return { fixture, head, frozen };
}

function hostingInput(fixture: ReturnType<typeof workerGitFixture>, frozen: SubmissionV1, body?: string) {
  return {
    cwd: fixture.worker,
    canonicalRoot: fixture.canonical,
    taskId,
    submittedCommitSha: frozen.commitSha!,
    env: { GH_TOKEN: "daemon-only-fixture" },
    pullRequest: {
      hosting: { kind: "github" as const, host: "github.com", repository: "acme/repo" },
      taskTitle: "Delivered task",
      submission: frozen,
      ...(body === undefined ? {} : { body }),
    },
  };
}

function captureCreate(context: test.TestContext, posted: { body: string }[]) {
  context.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit = {}) => {
    if (!String(url).includes("/pulls")) return Response.json({ default_branch: "main" });
    if (options.method === "GET" || options.method === undefined) return Response.json([]);
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    posted.push({ body: String(payload.body) });
    return Response.json({ number: 42, html_url: "https://github.com/acme/repo/pull/42" });
  });
}

test("the publication port writes the governance declaration from the frozen protected-surface cut", async (context) => {
  const { fixture, frozen } = publication(context, "pr-body-render"),
    renderBody = taskPrBodyRenderer({
      rootDir: fixture.canonical,
      projection: projection(frozen.commitSha!),
      taskId,
      submission: frozen,
    }),
    posted: { body: string }[] = [];
  assert.ok(renderBody, "the framework repository supplies both template and manifest");
  captureCreate(context, posted);

  const input = hostingInput(fixture, frozen);
  await publishTaskWorkerBranch({
    ...input,
    pullRequest: { ...input.pullRequest, renderBody },
  });

  assert.equal(posted.length, 1, "a first publication creates one PR");
  const body = posted[0]!.body,
    lint = checkPrGovernance({ body, changedFiles: frozen.changedFiles ?? [], manifest });
  assert.match(body, /^## Governance Declaration$/mu);
  assert.match(body, new RegExp(protectedFile, "u"));
  assert.equal(lint.ok, true, lint.issues.join("\n"));
  assert.match(body, /Delivery commit: `[0-9a-f]{40}`/u, "the frozen delivery facts ride the same body");
});

test("the legacy submission-prose body fails the same governance lint (negative control)", async (context) => {
  const { fixture, frozen } = publication(context, "pr-body-render-legacy"),
    posted: { body: string }[] = [];
  captureCreate(context, posted);

  await publishTaskWorkerBranch(hostingInput(fixture, frozen));

  assert.equal(posted.length, 1, "the legacy path still creates the PR");
  const body = posted[0]!.body,
    lint = checkPrGovernance({ body, changedFiles: frozen.changedFiles ?? [], manifest });
  assert.doesNotMatch(body, /^## Governance Declaration$/mu);
  assert.equal(lint.ok, false, "without the renderer the protected cut ships a lint-red body");
  assert.ok(lint.issues.some((issue) => issue.includes("Governance Declaration")));
});

test("an update re-renders the existing body instead of replacing authored prose", async (context) => {
  const { fixture, frozen } = publication(context, "pr-body-render-update"),
    renderBody = taskPrBodyRenderer({
      rootDir: fixture.canonical,
      projection: projection(frozen.commitSha!),
      taskId,
      submission: frozen,
    });
  assert.ok(renderBody);
  const authored = renderBody(undefined).replace("Rendered from the frozen cut.", "CEO-edited summary."),
    patches: { body: string }[] = [];
  let existing: Record<string, unknown> | undefined = {
    number: 42,
    html_url: "https://github.com/acme/repo/pull/42",
    body: authored,
  };
  const updated: SubmissionV1 = {
    ...frozen,
    productionDelta: { ...frozen.productionDelta!, added: 2, deleted: 1 },
  };
  const renderUpdatedBody = taskPrBodyRenderer({
    rootDir: fixture.canonical,
    projection: projection(frozen.commitSha!),
    taskId,
    submission: updated,
  });
  assert.ok(renderUpdatedBody);
  context.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit = {}) => {
    if (!String(url).includes("/pulls")) return Response.json({ default_branch: "main" });
    if ((options.method ?? "GET") === "GET") return Response.json(existing ? [existing] : []);
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    patches.push({ body: String(payload.body) });
    existing = { ...existing, ...payload };
    return Response.json(existing);
  });

  assert.equal(
    await updateTaskPullRequestBody({
      hosting: { kind: "github", host: "github.com", repository: "acme/repo" },
      branch: taskId,
      taskTitle: "Delivered task",
      submission: updated,
      env: { GH_TOKEN: "daemon-only-fixture" },
      renderBody: renderUpdatedBody,
    }),
    "https://github.com/acme/repo/pull/42",
  );
  assert.equal(patches.length, 1, "the update path patches rather than recreates");
  assert.match(patches[0]!.body, /CEO-edited summary\./u, "authored prose survives the re-render");
  assert.match(patches[0]!.body, /^## Governance Declaration$/mu, "the governance declaration is still written");
});

test("a marker-less template-shaped existing body gains governance while preserving its prose", async (context) => {
  const { fixture, frozen } = publication(context, "pr-body-render-markerless"),
    renderBody = taskPrBodyRenderer({
      rootDir: fixture.canonical,
      projection: projection(frozen.commitSha!),
      taskId,
      submission: frozen,
    });
  assert.ok(renderBody);
  const authored = template
    .replace(/<!-- harness:submission-facts:start -->\n<!-- harness:submission-facts:end -->\n/u, "")
    .replace("## Summary\n", "## Summary\n\nLegacy summary stays.\n");
  assert.doesNotMatch(authored, /harness:submission-facts/u, "the fixture predates the marker convention");
  const patches: { body: string }[] = [];
  let existing: Record<string, unknown> | undefined = {
    number: 42,
    html_url: "https://github.com/acme/repo/pull/42",
    body: authored,
  };
  context.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit = {}) => {
    if (!String(url).includes("/pulls")) return Response.json({ default_branch: "main" });
    if ((options.method ?? "GET") === "GET") return Response.json(existing ? [existing] : []);
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    patches.push({ body: String(payload.body) });
    existing = { ...existing, ...payload };
    return Response.json(existing);
  });

  await updateTaskPullRequestBody({
    hosting: { kind: "github", host: "github.com", repository: "acme/repo" },
    branch: taskId,
    taskTitle: "Delivered task",
    submission: frozen,
    env: { GH_TOKEN: "daemon-only-fixture" },
    renderBody,
  });
  assert.equal(patches.length, 1, "the marker-less body is patched, not recreated");
  assert.match(patches[0]!.body, /Legacy summary stays\./u, "the authored prose survives");
  assert.match(patches[0]!.body, /^## Governance Declaration$/mu);
  assert.equal(
    checkPrGovernance({ body: patches[0]!.body, changedFiles: frozen.changedFiles ?? [], manifest }).ok,
    true,
    "the updated marker-less body now passes the governance lint",
  );
});

test("an arbitrary marker-less existing body is migrated to the rendered template", async (context) => {
  const { fixture, frozen } = publication(context, "pr-body-render-arbitrary"),
    renderBody = taskPrBodyRenderer({
      rootDir: fixture.canonical,
      projection: projection(frozen.commitSha!),
      taskId,
      submission: frozen,
    });
  assert.ok(renderBody);
  const patches: { body: string }[] = [];
  let existing: Record<string, unknown> | undefined = {
    number: 42,
    html_url: "https://github.com/acme/repo/pull/42",
    body: "Legacy prose only.\n",
  };
  context.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit = {}) => {
    if (!String(url).includes("/pulls")) return Response.json({ default_branch: "main" });
    if ((options.method ?? "GET") === "GET") return Response.json(existing ? [existing] : []);
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    patches.push({ body: String(payload.body) });
    existing = { ...existing, ...payload };
    return Response.json(existing);
  });

  await updateTaskPullRequestBody({
    hosting: { kind: "github", host: "github.com", repository: "acme/repo" },
    branch: taskId,
    taskTitle: "Delivered task",
    submission: frozen,
    env: { GH_TOKEN: "daemon-only-fixture" },
    renderBody,
  });
  assert.equal(patches.length, 1);
  assert.doesNotMatch(patches[0]!.body, /Legacy prose only\./u, "an unanchorable body is replaced by the template");
  assert.match(patches[0]!.body, /^## Governance Declaration$/mu);
  assert.equal(
    checkPrGovernance({ body: patches[0]!.body, changedFiles: frozen.changedFiles ?? [], manifest }).ok,
    true,
  );
});

/** Run the real settlement path with a projection that can read the closeout. */
async function settlement(
  context: test.TestContext,
  slug: string,
  bodyInputs: boolean,
): Promise<{ bodies: string[]; existing: Record<string, unknown> | undefined; frozen: SubmissionV1 }> {
  const { fixture, frozen } = publication(context, slug, { bodyInputs });
  // detectHostingProvider parses the origin URL; a bare filesystem path has no host.
  git(fixture.canonical, "remote", "set-url", "origin", `file://${fixture.bare}`);
  mkdirSync(path.join(fixture.canonical, "harness"), { recursive: true });
  writeFileSync(
    path.join(fixture.canonical, "harness", "harness.yaml"),
    "schema: harness-anything/v1\nsettings:\n  hosting:\n    provider: github\n    host: github.com\n",
  );
  const bodies: string[] = [],
    settleContext = workerSettlementContext(fixture, async (type, _payload, _opId, _binding, body) => {
      if (type === "runtime_session_outcome_observed") bodies.push(String(body));
      return {};
    }),
    projectionStub = projection(frozen.commitSha!);
  let existing: Record<string, unknown> | undefined;
  context.mock.method(globalThis, "fetch", async (url: string | URL, options: RequestInit = {}) => {
    if (!String(url).includes("/pulls")) return Response.json({ default_branch: "main" });
    if ((options.method ?? "GET") === "GET") return Response.json(existing ? [existing] : []);
    const payload = JSON.parse(String(options.body)) as Record<string, unknown>;
    existing = { number: 8, html_url: "https://github.com/acme/repo/pull/8", ...payload };
    return Response.json(existing);
  });
  await publishExit(
    {
      ...settleContext,
      requiredRuntimeProjection: () => projectionStub as never,
      prepareDaemonGitEnvironment: async () => ({ GH_TOKEN: "daemon-only-fixture" }),
    },
    workerSettlementRuntime(fixture, {
      task: { taskId, executionId: "execution-owner", leaseVersion: 1 },
    }),
    0,
  );
  return { bodies, existing, frozen };
}

test("terminal settlement renders the protected-surface PR body (positive control)", async (context) => {
  const { bodies, existing, frozen } = await settlement(context, "settlement-render", true);
  assert.match(bodies[0]!, /Task pull request published: https:\/\/github\.com\/acme\/repo\/pull\/8/u);
  assert.ok(existing, "settlement created the first PR");
  const body = String(existing.body);
  assert.match(body, /^## Governance Declaration$/mu);
  assert.equal(
    checkPrGovernance({ body, changedFiles: frozen.changedFiles ?? [], manifest }).ok,
    true,
    "the settlement-created PR passes the governance lint",
  );
});

test("terminal settlement without the renderer keeps the legacy body (negative control)", async (context) => {
  const { existing, frozen } = await settlement(context, "settlement-legacy", false);
  assert.ok(existing, "settlement still creates the PR without a template");
  const body = String(existing.body);
  assert.doesNotMatch(body, /^## Governance Declaration$/mu);
  assert.equal(
    checkPrGovernance({ body, changedFiles: frozen.changedFiles ?? [], manifest }).ok,
    false,
    "without the renderer the settlement body remains lint-red",
  );
});
