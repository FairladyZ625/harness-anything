// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fixture, taskId, executionId } from "./task-completion-review.fixture.ts";

for (const ownerUpdate of [false, true]) {
  test(
    `runtime archive preserves ${ownerUpdate ? "owner-amended" : "original"} same-name task artifacts`,
    { timeout: 30_000 },
    async () => {
      const f = await fixture(false, true, true, false, false, { autoSubmit: false });
      try {
        const names = ["bundle.json", "report.md", "delivery-diff.md"],
          oldBody = (name: string) => (name.endsWith(".json") ? '{"version":"worker"}\n' : "# Worker evidence\n"),
          newBody = (name: string) => (name.endsWith(".json") ? '{"version":"owner"}\n' : "# Owner evidence\n"),
          logical = (name: string) => `${f.packagePath}/artifacts/${name}`,
          authored = (root: string, name: string) => path.join(root, "harness", logical(name)),
          git = (...args: string[]) => execFileSync("git", ["-C", f.root, ...args], { encoding: "utf8" }).trim(),
          checkout = git("worktree", "list", "--porcelain")
            .split("\n")
            .filter((line) => line.startsWith("worktree "))
            .map((line) => line.slice(9))
            .find((root) => path.resolve(root) !== path.resolve(f.root))!;
        assert.ok(checkout);
        for (const name of names) {
          mkdirSync(path.dirname(authored(f.root, name)), { recursive: true });
          writeFileSync(authored(f.root, name), oldBody(name));
          mkdirSync(path.dirname(authored(checkout, name)), { recursive: true });
          writeFileSync(authored(checkout, name), oldBody(name));
        }
        const firstSync = await f.run({ kind: "doc-submit", taskId });
        assert.equal(firstSync.outcome, "applied", JSON.stringify(firstSync));
        await f.submit();
        if (ownerUpdate) {
          for (const name of names) writeFileSync(authored(f.root, name), newBody(name));
          const ownerSync = await f.runPrincipal({ kind: "doc-submit", taskId });
          assert.equal(ownerSync.outcome, "applied", JSON.stringify(ownerSync));
          for (const name of names) {
            const shown = await f.run({ kind: "doc-show", path: logical(name), raw: true });
            assert.equal(shown.evidence, newBody(name));
          }
        }
        await f.install();
        if (ownerUpdate) {
          const amended = await f.runPrincipal({
            kind: "task-submit",
            taskId,
            executionId,
            amend: true,
            asOwner: true,
          });
          assert.equal(amended.outcome, "applied", JSON.stringify(amended));
        }
        const dispatch = f
          .events()
          .filter((event) => event.type === "runtime_dispatch_requested")
          .at(-1);
        assert.ok(dispatch?.type === "runtime_dispatch_requested");
        const { dispatchId, runtimeSessionId } = dispatch.payload;
        await f.settleReview(dispatchId, runtimeSessionId, "Reviewer finished reading artifacts.");
        const archive = f
          .events()
          .find(
            (event) =>
              event.type === "documents_written" &&
              event.payload.changes.some(
                (change) => change.path === `${f.packagePath}/artifacts/dispatches/${dispatchId}.json`,
              ),
          );
        assert.ok(archive?.type === "documents_written", "real runtime settlement must publish an archive");
        const visible = await f.run({
          kind: "receipt-show",
          opId: archive.opId,
          waitFor: ["git_verified", "worktree_visible"],
          timeoutMs: 5000,
        });
        assert.equal(visible.outcome, "applied", JSON.stringify(visible));
        for (const name of names) {
          const expected = ownerUpdate ? newBody(name) : oldBody(name),
            shown = await f.run({ kind: "doc-show", path: logical(name), raw: true });
          assert.equal(shown.evidence, expected, `canonical ${name}`);
          assert.equal(readFileSync(authored(f.root, name), "utf8"), expected, `disk ${name}`);
          assert.equal(readFileSync(authored(checkout, name), "utf8"), oldBody(name), `stale worker ${name}`);
          assert.equal(
            archive.payload.changes.some((change) => change.path === logical(name)),
            false,
          );
        }
      } finally {
        await f.close();
      }
    },
  );
}
