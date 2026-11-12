// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";
import { openBootstrappedRepoCell } from "./repo-settings.fixture.ts";
import { executionId, fixture, taskId, principal, owner } from "./task-completion-review.fixture.ts";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function preparationFixture(t: test.TestContext, phase: "fetch" | "risk") {
  const f = await fixture(false, false, false, true, false, {
    autoSubmit: false,
    openCell: async (input) => {
      const previous = process.env.GIT_TRACE;
      process.env.GIT_TRACE = path.join(input.rootDir, "submit-git.trace");
      try {
        return await openBootstrappedRepoCell(input);
      } finally {
        if (previous === undefined) delete process.env.GIT_TRACE;
        else process.env.GIT_TRACE = previous;
      }
    },
    create: { presetId: "standard-task", riskTier: "low" },
  });
  t.after(() => f.close());
  await f.cell().settlePendingMaterialization("pre-write fixture");
  const worktree = path.join(f.root, ".worktrees", taskId),
    remote = path.join(f.root, "origin.git"),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    sockets = new Set<import("node:net").Socket>(),
    server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      entered.resolve();
      void release.promise.then(() => socket.end("continue\n"));
    });
  t.signal.addEventListener("abort", () => release.resolve(), { once: true });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    release.resolve();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  git(f.root, "clone", "--bare", "--quiet", f.root, remote);
  git(f.root, "remote", "add", "origin", remote);
  git(f.root, "fetch", "--quiet", "origin");
  git(f.root, "remote", "set-head", "origin", "main");
  const file = "packages/daemon/src/prepared-delivery.ts";
  mkdirSync(path.dirname(path.join(worktree, file)), { recursive: true });
  writeFileSync(path.join(worktree, file), "export const preparedDelivery = 1;\n");
  git(worktree, "add", file);
  git(worktree, "commit", "-qm", "fix: prepared delivery");
  const headSha = git(worktree, "rev-parse", "HEAD"),
    baseSha = git(worktree, "merge-base", "origin/main", headSha),
    helper = path.join(f.root, "preparation-barrier.cjs"),
    captured = path.join(f.root, "risk-input.json");
  writeFileSync(
    helper,
    `const net = require('node:net');\n` +
      `const fs = require('node:fs');\n` +
      `const socket = net.connect(${address.port}, '127.0.0.1');\n` +
      `socket.once('data', () => { socket.end();\n` +
      (phase === "fetch"
        ? `const child = require('node:child_process').spawn('git', ['upload-pack', process.argv[2]], { stdio: 'inherit' });\nchild.once('exit', code => process.exitCode = code);\n`
        : `let body = ''; process.stdin.setEncoding('utf8'); process.stdin.on('data', chunk => body += chunk);\nprocess.stdin.on('end', () => { fs.writeFileSync(${JSON.stringify(captured)}, body); console.log(JSON.stringify({ schema: 'task-risk-tier-result/v1', minimumTier: 'low', reasons: ['prepared risk'] })); });\n`) +
      `});\n`,
  );
  if (phase === "fetch") git(f.root, "config", "remote.origin.uploadpack", `"${process.execPath}" "${helper}"`);
  else {
    mkdirSync(path.join(f.root, "tools"), { recursive: true });
    writeFileSync(
      path.join(f.root, "tools", "task-risk-manifest.json"),
      JSON.stringify({
        schema: "task-risk-manifest/v1",
        scripts: [{ id: "barrier", command: [process.execPath, helper] }],
      }),
    );
  }
  writeFileSync(
    path.join(f.root, "harness", f.packagePath, "closeout.md"),
    "## Summary\nPrepared delivery.\n## Verification\nPromise barriers.\n" +
      "## Residual Risk\nNone.\n## Same Mechanism Elsewhere\nQueue external reads.\n",
  );
  return { f, worktree, entered, release, baseSha, headSha, file, captured };
}

for (const [phase, mode] of [
  ["fetch", "submit"],
  ["risk", "submit"],
  ["fetch", "settle"],
  ["risk", "settle-rejoin"],
] as const) {
  test(`an unrelated write commits while ${mode} awaits ${phase}`, { timeout: 20_000 }, async (t) => {
    const { f, entered, release, baseSha, headSha, file, captured } = await preparationFixture(t, phase);
    if (mode === "settle-rejoin") assert.equal((await f.run({ kind: "task-release", taskId })).outcome, "applied");
    let returned = false;
    const submitting = f
      .run({ kind: mode === "submit" ? "task-submit" : "task-settle", taskId, executionId })
      .then((receipt) => {
        returned = true;
        return receipt;
      });
    try {
      await entered.promise;
      assert.equal(
        f.events().some((event) => event.type === "execution_submitted"),
        false,
      );
      const unrelated = await f.run({
        kind: "fact-record",
        statement: "An unrelated write while submit prepares its delivery.",
        evidenceSource: "README.md",
        confidence: "high",
        memoryClass: "episodic",
        memoryTags: [],
      });
      assert.equal(unrelated.outcome, "applied", JSON.stringify(unrelated));
      assert.equal(returned, false);
      console.log(`[pre-write-barrier:${mode}:${phase}] unrelated=applied submit=pending`);
    } finally {
      release.resolve();
      const receipt = await submitting;
      assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
      const submitted = f.events().findLast((event) => event.type === "execution_submitted");
      assert.ok(submitted?.type === "execution_submitted");
      const submission = submitted.payload.execution.submission!;
      assert.equal(submission.commitSha, headSha);
      assert.deepEqual(submission.changedFiles, [file]);
      assert.deepEqual(submission.productionDelta, {
        baseSha,
        added: 1,
        deleted: 0,
        changed: [{ filePath: file, module: "daemon", added: 1, deleted: 0 }],
        unclassified: [],
      });
      assert.equal(submission.riskTierAssessment?.effectiveTier, "low");
      if (phase === "risk") {
        const input = JSON.parse(readFileSync(captured, "utf8"));
        assert.equal(input.delivery.baseSha, baseSha);
        assert.equal(input.delivery.headSha, headSha);
        assert.equal(input.delivery.files.length, 1);
        assert.equal(input.delivery.files[0].path, file);
        assert.match(input.delivery.files[0].patch, /\+export const preparedDelivery = 1;/u);
        assert.deepEqual(submission.riskTierAssessment?.reasons, ["barrier: prepared risk"]);
      }
    }
  });
}

for (const drift of ["head", "default-ref", "path-reviewers", "lease"] as const) {
  test(`a changed ${drift} rejects prepared submission before accepting documents`, { timeout: 20_000 }, async (t) => {
    const { f, worktree, entered, release, headSha } = await preparationFixture(t, "risk"),
      submitting = f.run({ kind: "task-submit", taskId, executionId });
    try {
      await entered.promise;
      if (drift === "head") {
        writeFileSync(path.join(worktree, "later.txt"), "Moved during preparation.\n");
        git(worktree, "add", "later.txt");
        git(worktree, "commit", "-qm", "fix: move delivery head");
      } else if (drift === "default-ref") {
        git(f.root, "update-ref", "refs/remotes/origin/main", headSha);
      } else if (drift === "path-reviewers") {
        const settings = await f.cell().read("repo.settings.read", {}, principal),
          changed = await f.cell().run(
            {
              kind: "settings-update",
              reviewPathReviewers: ["data-migration packages/daemon/src/"],
              expectedVersion: settings.revision,
            },
            principal,
          );
        assert.equal(changed.outcome, "applied", JSON.stringify(changed));
      } else {
        assert.equal((await f.run({ kind: "task-release", taskId })).outcome, "applied");
      }
      const before = f.events().filter((event) => event.type === "documents_written").length;
      release.resolve();
      const receipt = await submitting;
      assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
      assert.equal(
        f.events().some((event) => event.type === "execution_submitted"),
        false,
      );
      assert.equal(f.events().filter((event) => event.type === "documents_written").length, before);
      if (drift !== "lease")
        assert.match(String(receipt.rejectionExplanation), /changed during submission preparation; retry/u);
      console.log(`[prepared-drift:${drift}] rejected=${receipt.code} document-events=0`);
    } finally {
      release.resolve();
      await submitting;
    }
  });
}

test("a mismatched lease refuses submit with zero Git children and document events", { timeout: 20_000 }, async (t) => {
  const { f } = await preparationFixture(t, "fetch"),
    trace = path.join(f.root, "submit-git.trace"),
    before = f.events().filter((event) => event.type === "documents_written").length;
  assert.match(readFileSync(trace, "utf8"), /built-in: git/u, "the observer has recorded actual Git processes");
  writeFileSync(trace, "");
  const receipt = await f
    .cell()
    .run(
      { kind: "task-submit", taskId, executionId },
      { ...owner, actor: { ...owner.actor, executor: { kind: "agent", id: "foreign-lease-holder" } } },
    );
  assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
  assert.equal(readFileSync(trace, "utf8").trim(), "");
  assert.equal(f.events().filter((event) => event.type === "documents_written").length, before);
  console.log(`[submit-preflight:lease] git=0 document-events=0 code=${receipt.code}`);
});
