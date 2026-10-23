// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openFencedRepoCell } from "./repo-settings.fixture.ts";

// Typed through the sanctioned fixture, never through packages/daemon/src/repo-cell directly:
// the import-boundary gate requires tests to obtain repositories from this fixture.
type OpenedCell = Awaited<ReturnType<typeof openFencedRepoCell>>;
import { initRepo } from "./doc-sync-slice-a.fixtures.ts";

// 2026-10-23 实测的 brain-os-frontend:台账是当前一代(revision 793),但 793 个事件里没有一条
// settings-event/v1,harness.yaml 也从未入账。设置读取因此报 projection_pending,提示去执行一个
// 根本不存在的仓库动作 `bootstrap`——而 witness 数据里它真正缺的是 settings 实体本身。
const owner = withPolicyGroup(
  {
    actor: { principal: { personId: "settings-entity-owner" }, executor: null },
    source: "local" as const,
  },
  "admin",
);

/** A current-generation ledger carrying history but no settings event — the brain-os shape. */
async function openLedgerWithoutSettings(rootDir: string, repoId: string) {
  const cell = await openFencedRepoCell({
    repoId: workspaceId(repoId),
    rootDir: canonicalRoot(rootDir),
    ownerId: `${repoId}-cell`,
  });
  assert.equal(
    await settingsEventCount(rootDir, repoId),
    0,
    "the fixture must start from a ledger that never minted Settings",
  );
  return cell;
}

async function settingsEventCount(rootDir: string, repoId: string): Promise<number> {
  const reader = makeTaskEventReader({ repoId: workspaceId(repoId), rootDir: canonicalRoot(rootDir) });
  try {
    return reader.read().events.filter((event) => event.schema === "settings-event/v1").length;
  } finally {
    await reader.drain();
  }
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

const missingSettings = (caught: unknown): boolean => {
  assert.equal((caught as { readonly code?: string }).code, "settings_entity_missing", String(caught));
  const message = (caught as Error).message;
  // The command must be one a principal can actually run; `ha bootstrap` is a Keycloak operation and
  // no repository action by that name exists.
  assert.match(message, /ha settings update/u);
  assert.doesNotMatch(message, /bootstrap the repository/u);
  // A missing entity is not a wait-for-the-projection state.
  assert.doesNotMatch(message, /retry/u);
  return true;
};

test("a ledger that never minted Settings reports a missing entity with the command that creates it", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-missing-"));
  let cell: OpenedCell | undefined;
  try {
    initRepo(rootDir);
    cell = await openLedgerWithoutSettings(rootDir, "settings-entity-missing");
    await assert.rejects(cell.read("repo.settings.read"), missingSettings);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a locale-only update mints Settings from the authored harness.yaml instead of deadlocking", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-locale-"));
  let cell: OpenedCell | undefined;
  try {
    initRepo(rootDir);
    // The authored document is the only declaration surface; it deliberately carries a value that
    // differs from the declared default so a fake "defaults" answer cannot pass this test.
    writeFileSync(
      path.join(rootDir, "harness", "harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  reviewReturnBudget: 7\n  defaultProfile: baseline\n",
    );
    git(rootDir, "commit", "-qam", "authored settings");
    cell = await openLedgerWithoutSettings(rootDir, "settings-entity-locale");
    const receipt = await cell.run({ kind: "settings-update", locale: "en-US", idempotencyKey: "locale-mint" }, owner);
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const read = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly reviewReturnBudget: number; readonly locale: string };
      readonly revision: number;
    };
    assert.equal(read.settings.reviewReturnBudget, 7, "Settings must be minted from the authored document");
    assert.equal(read.settings.locale, "en-US");
    assert.ok(read.revision > 0, "the minted entity carries a write-path revision");
    assert.equal(
      await settingsEventCount(rootDir, "settings-entity-locale"),
      1,
      "exactly one settings_changed event is minted, not one per retry",
    );
    // Idempotence: the same locale update finds the entity and does not mint a second event.
    await cell.run({ kind: "settings-update", locale: "zh-CN", idempotencyKey: "locale-again" }, owner);
    assert.equal(await settingsEventCount(rootDir, "settings-entity-locale"), 1);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("projection rebuild initializes a missing Settings entity from the authored document", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-rebuild-"));
  let cell: OpenedCell | undefined;
  try {
    initRepo(rootDir);
    writeFileSync(
      path.join(rootDir, "harness", "harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  reviewReturnBudget: 5\n",
    );
    git(rootDir, "commit", "-qam", "authored settings");
    cell = await openLedgerWithoutSettings(rootDir, "settings-entity-rebuild");
    const rebuilt = await cell.run({ kind: "projection-rebuild" }, owner);
    assert.equal(rebuilt.outcome, "applied", JSON.stringify(rebuilt));
    // The canonical write is what moved, not the async Git materialization: the CEO measured the
    // canonical revision stuck at 793 while settings stayed pending.
    assert.equal(
      await settingsEventCount(rootDir, "settings-entity-rebuild"),
      1,
      "the rebuild must append the initialization event instead of returning a no-op",
    );
    const read = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly reviewReturnBudget: number };
    };
    assert.equal(read.settings.reviewReturnBudget, 5);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a malformed authored settings facet names itself instead of failing codelessly", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-invalid-"));
  let cell: OpenedCell | undefined;
  try {
    initRepo(rootDir);
    writeFileSync(
      path.join(rootDir, "harness", "harness.yaml"),
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  reviewReturnBudget: not-a-number\n",
    );
    git(rootDir, "commit", "-qam", "malformed authored settings");
    cell = await openLedgerWithoutSettings(rootDir, "settings-entity-invalid");
    // The authored facet is user input the daemon now reads on the write path; a parse failure there
    // must name the file and the field, not arrive as a codeless service_rejected.
    await assert.rejects(cell.read("repo.settings.read"), missingSettings);
    // `run` answers a rejected command as a receipt, not a throw: the code must still name the file
    // and the offending field instead of collapsing to `service_rejected`.
    const receipt = await cell.run({ kind: "settings-update", locale: "en-US", idempotencyKey: "invalid-doc" }, owner);
    assert.equal(receipt.code, "settings_document_invalid", JSON.stringify(receipt));
    assert.match(String(receipt.rejectionExplanation), /harness\.yaml/u);
    assert.match(String(receipt.rejectionExplanation), /reviewReturnBudget/u);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a ledger that already accepted Settings is never re-initialized from the worktree copy", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-existing-"));
  let cell: OpenedCell | undefined;
  try {
    initRepo(rootDir);
    cell = await openLedgerWithoutSettings(rootDir, "settings-entity-existing");
    // Mint through the one entry, then diverge the authored file: an accepted entity outranks a
    // local edit, exactly as a stale vertical.json cannot un-declare accepted Kinds.
    assert.equal(
      (await cell.run({ kind: "settings-update", reviewReturnBudget: 4, idempotencyKey: "mint-4" }, owner)).outcome,
      "applied",
    );
    writeFileSync(
      path.join(rootDir, "harness", "harness.yaml"),
      readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8").replace(
        /reviewReturnBudget: 4/u,
        "reviewReturnBudget: 99",
      ),
    );
    assert.equal((await cell.run({ kind: "projection-rebuild" }, owner)).outcome, "applied");
    const read = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly reviewReturnBudget: number };
    };
    assert.equal(read.settings.reviewReturnBudget, 4, "the accepted entity wins over an uncommitted authored edit");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
