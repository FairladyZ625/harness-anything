// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { classifyTextualArtifactPath, sha256Text } from "@harness-anything/kernel";
import { executionId, fixture, owner, taskId } from "./task-completion-review.fixture.ts";
import { openRepoWriterCell } from "../src/repo-cell-open.ts";
import { acquireWorkspaceLock } from "../src/repo-cell-lock.ts";
import { fixtureFence, settleSettingsEvent } from "./repo-settings.fixture.ts";
import {
  policyTestCenter,
  provisionPolicyTestRepository,
  refreshPolicyTestRepository,
  revokeTestPolicyActions,
} from "./keycloak-policy.fixtures.ts";

async function openPublicationCell(input: Parameters<typeof openRepoWriterCell>[0]) {
  provisionPolicyTestRepository(input.repoId);
  const fence = fixtureFence(input.repoId, input.rootDir, path.join(input.rootDir, ".harness", "writer-epochs"));
  await settleSettingsEvent({
    ...input,
    writerEpochFence: fence,
    runtimeInstances: input.runtimeInstances?.(),
  });
  return openRepoWriterCell(
    { keycloakCenter: policyTestCenter, ...input, defaultWriterEpochFence: fence },
    await acquireWorkspaceLock(input.rootDir),
  );
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function publicationFixture(context: test.TestContext) {
  const f = await fixture(false, true, false, false, false, {
    autoSubmit: false,
    openCell: openPublicationCell,
    create: { presetId: "standard-task" },
  });
  context.after(() => f.close());
  await f.install();
  const remote = path.join(f.root, "origin.git"),
    worktree = path.join(f.root, ".worktrees", taskId);
  git(f.root, "init", "--bare", "-q", "--initial-branch=main", remote);
  git(f.root, "remote", "add", "origin", `file://${remote}`);
  // Declare hosting while every Git operation stays inside this isolated fixture.
  await f.cell().settlePendingMaterialization("hosting fixture settings");
  const configPath = path.join(f.root, "harness", "harness.yaml");
  writeFileSync(
    configPath,
    readFileSync(configPath, "utf8").replace(
      "settings:\n",
      "settings:\n  hosting:\n    provider: github\n    host: github.com\n",
    ),
  );
  git(f.root, "push", "-q", "origin", "main:main");
  git(worktree, "push", "-q", "origin", `HEAD:refs/heads/${taskId}`);
  const previous = git(remote, "rev-parse", `refs/heads/${taskId}`),
    order: string[] = [];
  let prHead = previous,
    prExists = false,
    failHosting = false,
    stalePrHead = false,
    cuts = 0,
    publicationBarrier: (() => Promise<void>) | undefined;
  const priorToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "fixture-hosting-token";
  context.after(() => {
    if (priorToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = priorToken;
  });
  const fetchBeforeMock = globalThis.fetch;
  context.mock.method(globalThis, "fetch", async (_url: string | URL, options: RequestInit = {}) => {
    if (!String(_url).startsWith("https://api.github.com/")) return fetchBeforeMock(_url, options);
    await publicationBarrier?.();
    const method = options.method ?? "GET";
    if (failHosting) return Response.json({ message: "unavailable" }, { status: 503 });
    if (!String(_url).includes("/pulls")) return Response.json({ default_branch: "main" });
    prHead = stalePrHead ? previous : git(remote, "rev-parse", `refs/heads/${taskId}`);
    order.push(`hosting:${method}:${prHead}`);
    const pr = { number: 42, html_url: "https://github.com/acme/repo/pull/42", head: { sha: prHead } };
    if (method === "GET" && !String(_url).endsWith("/42")) return Response.json(prExists ? [pr] : []);
    prExists = true;
    return Response.json(pr);
  });
  f.launches.push = (...launches: (typeof f.launches)[number][]) => {
    const submitted = f.events().findLast((event) => event.type === "execution_submitted");
    assert.ok(submitted?.type === "execution_submitted");
    const frozen = submitted.payload.execution.submission!.commitSha;
    order.push(`review:${prHead}`);
    console.log(
      "[review-launch-head]",
      JSON.stringify({ frozen, branchHead: git(remote, "rev-parse", `refs/heads/${taskId}`), prHead }),
    );
    assert.equal(
      git(remote, "rev-parse", `refs/heads/${taskId}`),
      frozen,
      "review starts after the frozen branch lands",
    );
    assert.equal(prHead, frozen, "the PR head observed at reviewer launch equals the frozen delivery");
    return Array.prototype.push.apply(f.launches, launches);
  };
  const cut = () => {
    writeFileSync(path.join(worktree, "delivery.txt"), `${++cuts} next delivery\n`);
    git(worktree, "add", "delivery.txt");
    git(worktree, "commit", "-qm", "fix: frozen delivery");
    return git(worktree, "rev-parse", "HEAD");
  };
  const writeCloseout = () => {
    writeFileSync(
      path.join(f.root, "harness", f.packagePath, "closeout.md"),
      "# Closeout\n\n## Summary\n\nPublish before review.\n\n## Verification\n\nDirected tests.\n\n" +
        "## 摘要\n\n先推送后评审。\n\n## 验证\n\n定向测试。\n",
    );
  };
  const submit = (amend = false, extra: Record<string, unknown> = {}) => {
    writeCloseout();
    return f.run({
      kind: "task-submit",
      taskId,
      executionId,
      ...(amend ? { amend: true } : {}),
      ...extra,
    });
  };
  return {
    f,
    order,
    previous,
    cut,
    submit,
    writeCloseout,
    pausePublication: (barrier: (() => Promise<void>) | undefined) => {
      publicationBarrier = barrier;
    },
    failHosting: (value = true) => {
      failHosting = value;
    },
    stalePrHead: () => {
      stalePrHead = true;
    },
    failPush: () => git(f.root, "config", "remote.origin.pushurl", `file://${f.root}/missing.git`),
  };
}

test(
  "submit publishes the frozen delivery and PR head before automatic review starts",
  { timeout: 20_000 },
  async (context) => {
    const { f, order, previous, cut, submit } = await publicationFixture(context),
      frozen = cut(),
      receipt = await submit();
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.notEqual(frozen, previous);
    assert.equal(f.launches.length, 1, JSON.stringify(receipt));
    assert.equal(order.at(-1), `review:${frozen}`, JSON.stringify(order));
    const resumed = await submit();
    assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
    assert.equal(f.launches.length, 1, "resuming the cut does not launch a second reviewer");
    const amendedHead = cut(),
      amended = await submit(true);
    assert.equal(amended.outcome, "applied", JSON.stringify(amended));
    assert.equal(f.launches.length, 2, JSON.stringify(amended));
    assert.equal(order.at(-1), `review:${amendedHead}`);
    console.log("[publication-order]", JSON.stringify(order));
  },
);

test(
  "a publication failure keeps the cut frozen without launching an inevitable failing review",
  { timeout: 20_000 },
  async (context) => {
    const { f, cut, submit, failHosting } = await publicationFixture(context),
      frozen = cut();
    failHosting();
    const receipt = await submit();
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(f.launches.length, 0, "no reviewer starts before PR publication is confirmed");
    const submitted = f.events().findLast((event) => event.type === "execution_submitted");
    assert.ok(submitted?.type === "execution_submitted");
    assert.equal(submitted.payload.execution.submission!.commitSha, frozen);
    assert.match(JSON.stringify(receipt), /publication|publish/iu);
    assert.match(JSON.stringify(receipt.warnings), /ha task submit task-completion-review --amend/u);
    failHosting(false);
    const resumed = await submit(true);
    assert.equal(resumed.outcome, "applied", JSON.stringify(resumed));
    assert.equal(f.launches.length, 1, "explicit resumption publishes the same cut and dispatches once");
    console.log("[publication-recovery-order]", JSON.stringify(frozen));
  },
);

test(
  "submit and subsequent task push publish the frozen commit when worker HEAD has advanced",
  { timeout: 20_000 },
  async (context) => {
    const { f, cut, submit, order } = await publicationFixture(context),
      frozen = cut(),
      submitted = await submit(),
      later = cut();
    assert.notEqual(frozen, later);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    assert.equal(f.launches.length, 1, JSON.stringify(submitted));
    assert.equal(order.at(-1), `review:${frozen}`);
    const pushed = await f.run({ kind: "task-push", taskId });
    assert.equal(pushed.outcome, "applied", JSON.stringify(pushed));
    assert.match(pushed.evidence, new RegExp(frozen, "u"));
    assert.doesNotMatch(pushed.evidence, new RegExp(later, "u"));
  },
);

test(
  "a rejected branch push keeps the frozen cut and does not dispatch a reviewer",
  { timeout: 20_000 },
  async (context) => {
    const { f, cut, submit, failPush } = await publicationFixture(context);
    cut();
    failPush();
    const receipt = await submit();
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(f.launches.length, 0);
    assert.match(JSON.stringify(receipt), /delivery_publish_failed/u);
  },
);

test(
  "a stale hosting PR head blocks automatic review after a successful branch push",
  { timeout: 20_000 },
  async (context) => {
    const { f, cut, submit, stalePrHead } = await publicationFixture(context);
    cut();
    stalePrHead();
    const receipt = await submit();
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(f.launches.length, 0);
    assert.match(JSON.stringify(receipt), /PR head.*does not match the frozen delivery/u);
  },
);

test("queued reviewer authorization preserves the failed step and warning", { timeout: 20_000 }, async (context) => {
  const { f, cut, submit } = await publicationFixture(context);
  cut();
  revokeTestPolicyActions(owner.actor.principal.personId, "completion-review", ["runtime-spawn"]);
  context.after(() => refreshPolicyTestRepository("completion-review"));
  const receipt = await submit();
  assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
  assert.equal(f.launches.length, 0);
  assert.match(JSON.stringify(receipt.warnings), /dispatch failed: authorization_denied:/u);
  assert.match(JSON.stringify((receipt as Record<string, unknown>).steps), /review_dispatch_failed/u);
  assert.ok(f.events().some((event) => event.type === "execution_submitted"));
});

for (const mode of ["ordinary", "amend", "docChanges", "resume", "settle"] as const) {
  test(
    `a frozen ${mode} submit releases the write queue while PR publication is pending`,
    { timeout: 30_000 },
    async (context) => {
      const { f, cut, submit, writeCloseout, pausePublication } = await publicationFixture(context),
        entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      context.signal.addEventListener("abort", () => release.resolve(), { once: true });
      cut();
      if (mode === "resume" || mode === "amend") {
        assert.equal((await submit()).outcome, "applied");
        if (mode === "amend") cut();
      }
      const extra: Record<string, unknown> = mode === "settle" ? { kind: "task-settle" } : {};
      if (mode === "docChanges") {
        writeCloseout();
        assert.equal((await f.run({ kind: "doc-submit", paths: [`${f.packagePath}/closeout.md`] })).outcome, "applied");
        const artifact = `${f.packagePath}/artifacts/carried.md`,
          body = "Carried submission evidence.\n",
          ref = "doc-sync-claims/0123456789abcdef0123456789abcdef",
          claim = path.join(f.root, ".harness", ref);
        mkdirSync(path.dirname(claim), { recursive: true });
        writeFileSync(claim, body);
        extra.docChanges = [
          {
            path: artifact,
            baseBlobSha256: null,
            policyId: classifyTextualArtifactPath(artifact)!.policyId,
            candidate: { ref, sha256: sha256Text(body), size: Buffer.byteLength(body), mediaType: "text/markdown" },
          },
        ];
      }
      pausePublication(async () => {
        entered.resolve();
        await release.promise;
      });
      const launches = f.launches.length;
      let returned = false;
      const submitting = submit(mode === "amend", extra).then((receipt) => {
        returned = true;
        return receipt;
      });
      try {
        await entered.promise;
        assert.ok(f.events().some((event) => event.type === "execution_submitted"));
        const unrelated = await f.run({
          kind: "fact-record",
          statement: "An unrelated canonical write during publication.",
          evidenceSource: "README.md",
          confidence: "high",
          memoryClass: "episodic",
          memoryTags: [],
        });
        assert.equal(unrelated.outcome, "applied", JSON.stringify(unrelated));
        assert.equal(returned, false, "submit still awaits the full synchronous receipt");
        assert.equal(f.launches.length, launches, "publication has not been released");
        console.log(`[publication-barrier:${mode}] unrelated=applied submit=pending`);
      } finally {
        pausePublication(undefined);
        release.resolve();
        const receipt = await submitting,
          steps = (receipt as Record<string, unknown>).steps;
        assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
        assert.ok(Array.isArray(steps) && steps.length > 0, JSON.stringify(receipt));
        if (mode !== "docChanges") assert.ok((receipt as Record<string, unknown>).riskTierAssessment);
      }
    },
  );
}

test("concurrent resumes publish one frozen cut and hold one review dispatch", { timeout: 30_000 }, async (context) => {
  const { f, cut, submit, pausePublication } = await publicationFixture(context),
    entered = Promise.withResolvers<void>(),
    bothEntered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  context.signal.addEventListener("abort", () => release.resolve(), { once: true });
  cut();
  let arrivals = 0;
  pausePublication(async () => {
    arrivals += 1;
    entered.resolve();
    if (arrivals === 2) bothEntered.resolve();
    await release.promise;
  });
  const first = submit();
  await entered.promise;
  const resumed = submit();
  try {
    await bothEntered.promise;
    assert.equal(f.launches.length, 0);
    assert.equal(f.events().filter((event) => event.type === "execution_submitted").length, 1);
  } finally {
    pausePublication(undefined);
    release.resolve();
    const receipts = await Promise.all([first, resumed]);
    for (const receipt of receipts) assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    assert.equal(f.launches.length, 1, "queued admission deduplicates the shared cut after concurrent preparation");
    assert.ok(receipts.some((receipt) => /no new reviewer was dispatched/u.test(JSON.stringify(receipt.warnings))));
  }
});
