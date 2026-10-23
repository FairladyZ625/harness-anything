// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { makeTaskEventReader } from "@harness-anything/kernel";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openFencedRepoCell } from "./repo-settings.fixture.ts";
import { resolveRepoBootstrap } from "../src/repo-bootstrap.ts";
import { openPersistentWriterEpoch } from "../src/writer-epoch.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

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
const agent = withPolicyGroup(
  {
    actor: {
      principal: { personId: "settings-entity-owner" },
      executor: { kind: "agent", id: "settings-entity-agent" },
    },
    source: "local" as const,
  },
  "admin",
);

/** A locale that is NOT the declared default, so "the default was written" cannot pass as success. */
const MACHINE_LOCALE = "zh-CN";
const MACHINE_LOCAL_DOCUMENT = {
  schema: "settings-local/v1",
  locale: MACHINE_LOCALE,
  gui: { connectTimeoutMs: 9_000, requestTimeoutMs: 45_000 },
};

/** A current-generation ledger carrying history but no settings event — the brain-os shape. */
async function openLedgerWithoutSettings(rootDir: string, repoId: string, authoredSettings?: string) {
  initRepo(rootDir);
  if (authoredSettings !== undefined) authorSettings(rootDir, authoredSettings);
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

/** A machine that already holds its own preferences: this is what the mint must never overwrite. */
function seedMachineLocalSettings(rootDir: string): string {
  const localPath = path.join(rootDir, ".harness", "settings.local.json");
  mkdirSync(path.dirname(localPath), { recursive: true });
  writeFileSync(localPath, `${JSON.stringify(MACHINE_LOCAL_DOCUMENT, null, 2)}\n`);
  return localPath;
}

function readLocalSettings(localPath: string): unknown {
  return JSON.parse(readFileSync(localPath, "utf8"));
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}

/** Point the authored harness.yaml at a value that differs from every declared default. */
function authorSettings(rootDir: string, settings: string): void {
  writeFileSync(
    path.join(rootDir, "harness", "harness.yaml"),
    `schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n${settings}`,
  );
  git(rootDir, "commit", "-qam", "authored settings");
}

const missingSettings = (caught: unknown): boolean => {
  assert.equal((caught as { readonly code?: string }).code, "settings_entity_missing", String(caught));
  const message = (caught as Error).message;
  // The command must be one a principal can actually run; `ha bootstrap` is a Keycloak operation and
  // no repository action by that name exists.
  assert.match(message, /ha settings update/u);
  assert.doesNotMatch(message, /bootstrap the repository/u);
  // A projection rebuild re-derives existing events; it cannot create the entity, so recommending it
  // would point an executor at a command the principal guard never sees.
  assert.doesNotMatch(message, /projection rebuild/u);
  // A missing entity is not a wait-for-the-projection state.
  assert.doesNotMatch(message, /retry/u);
  return true;
};

test("a ledger that never minted Settings reports a missing entity with the command that creates it", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-missing-"));
  let cell: OpenedCell | undefined;
  try {
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
    cell = await openLedgerWithoutSettings(
      rootDir,
      "settings-entity-locale",
      "  reviewReturnBudget: 7\n  defaultProfile: baseline\n",
    );
    const receipt = await cell.run(
      { kind: "settings-update", locale: MACHINE_LOCALE, idempotencyKey: "locale-mint" },
      owner,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    const read = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly reviewReturnBudget: number; readonly locale: string };
      readonly revision: number;
    };
    assert.equal(read.settings.reviewReturnBudget, 7, "Settings must be minted from the authored document");
    // Non-default on purpose: the defect this locks out was "the request is silently replaced by the
    // declared default", which a `en-US` assertion cannot distinguish.
    assert.equal(read.settings.locale, MACHINE_LOCALE, "the requested locale must be the one that lands");
    assert.ok(read.revision > 0, "the minted entity carries a write-path revision");
    assert.equal(
      await settingsEventCount(rootDir, "settings-entity-locale"),
      1,
      "exactly one settings_changed event is minted, not one per retry",
    );
    // Idempotence: the same locale update finds the entity and does not mint a second event.
    await cell.run({ kind: "settings-update", locale: "en-US", idempotencyKey: "locale-again" }, owner);
    assert.equal(await settingsEventCount(rootDir, "settings-entity-locale"), 1);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("minting Settings preserves an existing machine-local preferences file byte for byte", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-local-"));
  let cell: OpenedCell | undefined;
  try {
    // The machine's file exists before the repository is opened, exactly as on a real workstation.
    const localPath = seedMachineLocalSettings(rootDir),
      before = readFileSync(localPath, "utf8");
    cell = await openLedgerWithoutSettings(
      rootDir,
      "settings-entity-local",
      "  reviewReturnBudget: 7\n  defaultProfile: baseline\n",
    );
    const receipt = await cell.run(
      { kind: "settings-update", reviewReturnBudget: 5, idempotencyKey: "mint-keeps-local" },
      owner,
    );
    assert.equal(receipt.outcome, "applied", JSON.stringify(receipt));
    // Two canonical writes, both intended: the mint from the authored document (7), then the change
    // the caller asked for (5). The local file is the one thing that must see neither.
    assert.equal(
      await settingsEventCount(rootDir, "settings-entity-local"),
      2,
      "the mint and the requested repository change each append one settings_changed event",
    );
    const read = (await cell.read("repo.settings.read")) as {
      readonly settings: { readonly reviewReturnBudget: number };
    };
    assert.equal(read.settings.reviewReturnBudget, 5, "the requested value still lands on top of the mint");
    // The earlier cut derived local preferences from the repository value, so every local field
    // without a repository counterpart fell back to its declared default: zh-CN/9000/45000 became
    // en-US/2000/30000. "Unchanged" is the only acceptable outcome for a mint.
    assert.equal(
      readFileSync(localPath, "utf8"),
      before,
      `the mint must not rewrite ${path.basename(localPath)}; got ${readFileSync(localPath, "utf8")}`,
    );
    assert.deepEqual(readLocalSettings(localPath), MACHINE_LOCAL_DOCUMENT);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a rejected settings update leaves no settings event and no local preference change", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-rejected-"));
  let cell: OpenedCell | undefined;
  try {
    const localPath = seedMachineLocalSettings(rootDir),
      before = readFileSync(localPath, "utf8");
    cell = await openLedgerWithoutSettings(
      rootDir,
      "settings-entity-rejected",
      "  reviewReturnBudget: 7\n  defaultProfile: baseline\n",
    );
    // `ja-JP` is not a declared locale: the request is rejected by the compiler. It is sent by the
    // principal, so the refusal under test is the compile one, not the authority guard.
    const receipt = await cell.run(
      { kind: "settings-update", locale: "ja-JP", idempotencyKey: "rejected-no-side-effects" },
      owner,
    );
    assert.equal(receipt.outcome, "op_rejected", JSON.stringify(receipt));
    assert.equal(receipt.code, "invalid_command", JSON.stringify(receipt));
    // Rejection semantics require zero side effects: the earlier cut minted before judging, so this
    // "refused" command appended a settings_changed event and reset the machine's preferences.
    assert.equal(
      await settingsEventCount(rootDir, "settings-entity-rejected"),
      0,
      "a rejected settings update must not append a settings_changed event",
    );
    assert.equal(readFileSync(localPath, "utf8"), before, "a rejected settings update must not touch local settings");
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a malformed authored settings facet names itself instead of failing codelessly", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-invalid-"));
  let cell: OpenedCell | undefined;
  try {
    cell = await openLedgerWithoutSettings(rootDir, "settings-entity-invalid", "  reviewReturnBudget: not-a-number\n");
    // The authored facet is user input the daemon now reads on the write path; a parse failure there
    // must name the file and the field, not arrive as a codeless service_rejected.
    await assert.rejects(cell.read("repo.settings.read"), missingSettings);
    // `run` answers a rejected command as a receipt, not a throw: the code must still name the file
    // and the offending field instead of collapsing to `service_rejected`.
    const receipt = await cell.run({ kind: "settings-update", locale: "en-US", idempotencyKey: "invalid-doc" }, owner);
    assert.equal(receipt.code, "settings_document_invalid", JSON.stringify(receipt));
    assert.match(String(receipt.rejectionExplanation), /harness\.yaml/u);
    assert.match(String(receipt.rejectionExplanation), /reviewReturnBudget/u);
    assert.equal(
      await settingsEventCount(rootDir, "settings-entity-invalid"),
      0,
      "an unreadable authored document must not mint anything",
    );
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("a ledger that already accepted Settings is never re-initialized from the worktree copy", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-existing-"));
  let cell: OpenedCell | undefined;
  try {
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

test("projection rebuild cannot mint Settings on behalf of an agent executor", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "ha-settings-entity-rebuild-agent-"));
  let cell: OpenedCell | undefined;
  try {
    cell = await openLedgerWithoutSettings(rootDir, "settings-entity-rebuild-agent", "  reviewReturnBudget: 5\n");
    // The same agent is refused by the command that owns Settings writes...
    const refused = await cell.run(
      { kind: "settings-update", reviewReturnBudget: 3, idempotencyKey: "agent-mint" },
      agent,
    );
    assert.equal(refused.outcome, "op_rejected", JSON.stringify(refused));
    assert.equal(refused.code, "settings_write_requires_principal", JSON.stringify(refused));
    // ...so the rebuild it can run must not become the way around that refusal. `projection-rebuild`
    // is a `repo-write`/`contributor` action; minting there let an agent write repository Settings
    // without the principal guard ever being asked, and the receipt did not disclose the write.
    const rebuilt = await cell.run({ kind: "projection-rebuild" }, agent);
    assert.equal(rebuilt.outcome, "applied", JSON.stringify(rebuilt));
    assert.equal(
      await settingsEventCount(rootDir, "settings-entity-rebuild-agent"),
      0,
      "an agent-driven projection rebuild must not append a settings_changed event",
    );
    assert.doesNotMatch(
      String(rebuilt.effects ?? []),
      /settings-event/u,
      "the rebuild receipt must not claim a settings write it did not make",
    );
    await assert.rejects(cell.read("repo.settings.read"), missingSettings);
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("ha init still mints Settings as the owner's agent, because repo-bootstrap authorizes it", async () => {
  // The distinction the negative test above must not erase: `projection-rebuild` has no authority to
  // create Settings, but `ha init` does, and init legitimately runs as the owner's agent executor.
  // Treating "mint" as "always principal-only" turned every fresh `ha init` into a
  // settings_write_requires_principal failure (caught by repo-bootstrap-owner-person in CI).
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-settings-entity-init-agent-"))),
    repoId = workspaceId("settings-entity-init-agent"),
    stateRoot = path.join(rootDir, "writer-epochs"),
    authority = openPersistentWriterEpoch({ stateRoot, holderId: "settings-entity-init-agent" }),
    lease = authority.acquire(repoId);
  let cell: OpenedCell | undefined;
  try {
    const bootstrapping = withPolicyGroup(
      {
        actor: { principal: { personId: "person-owner" }, executor: { kind: "agent" as const, id: "owner-agent" } },
        source: "local" as const,
        authorizationBindingMode: "declared" as const,
      },
      "admin",
    );
    cell = await openFencedRepoCell({
      repoId,
      rootDir: canonicalRoot(rootDir),
      ownerId: "settings-entity-init-agent",
      bootstrap: {
        ...resolveRepoBootstrap(
          { rootDir, repoId: "settings-entity-init-agent", personId: "person-owner", displayName: "Owner" },
          {
            transportKind: "unix-socket",
            unixSocketOwnerBoundary: {
              ownerUid: process.getuid?.() ?? 0,
              source: "unix-socket-filesystem-owner-boundary",
            },
          } as unknown as DaemonAuthenticationContext,
        ),
        actor: bootstrapping.actor,
        keycloakAuthorization: bootstrapping.keycloakAuthorization,
      },
      defaultWriterEpochFence: {
        schema: "harness-writer-epoch-fence/v1",
        stateRoot,
        repoId,
        epoch: lease.epoch,
        holderId: lease.holderId,
      },
    });
    // Init published Settings as part of opening the repository, under repo-bootstrap's authority.
    assert.equal(
      await settingsEventCount(rootDir, "settings-entity-init-agent"),
      1,
      "ha init mints Settings once, as the owner's agent, under repo-bootstrap authorization",
    );
    const read = (await cell.read("repo.settings.read")) as { readonly settings: { readonly settingsId: string } };
    assert.equal(
      read.settings.settingsId,
      "repository",
      "the entity init minted is readable, not a missing-entity error",
    );
    // The same agent still cannot change those settings afterwards: creating a repository and changing
    // its constraints are different authorities.
    const refused = await cell.run(
      { kind: "settings-update", reviewReturnBudget: 3, idempotencyKey: "init-agent-cannot-update" },
      bootstrapping,
    );
    assert.equal(refused.code, "settings_write_requires_principal", JSON.stringify(refused));
  } finally {
    await cell?.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});
