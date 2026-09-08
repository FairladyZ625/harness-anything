// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindWriterGenerationToken } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import {
  bootstrapRepo,
  resolveRepoBootstrap,
  type RepoBootstrapReceipt,
  type RepoBootstrapRequest,
} from "../src/repo-bootstrap.ts";
import { openRepoCell } from "../src/repo-cell.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

const repoId = "configure-only";
const auth = {
  transportKind: "unix-socket",
  unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" },
} as unknown as DaemonAuthenticationContext;
const writer = { workspaceId: repoId, ownerId: "configure-only-test", generation: 0 };
function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
function init(rootDir: string, configureOnly: boolean): RepoBootstrapReceipt {
  const request: RepoBootstrapRequest = {
    rootDir,
    repoId,
    personId: "owner",
    displayName: "Owner",
    ...(configureOnly ? { configureOnly: true } : {}),
  };
  return bootstrapRepo(resolveRepoBootstrap(request, auth), writer, bindWriterGenerationToken(writer));
}

test("init --configure-only reapplies ledger maintenance without writing the workspace", async () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-configure-only-")));
  try {
    git(rootDir, "init", "-q");
    assert.equal(init(rootDir, false).publication.ok, true);
    const ledgerRoot = path.join(rootDir, "harness"),
      head = git(ledgerRoot, "rev-parse", "HEAD");
    const unprojected = await openRepoCell({
      rootDir: canonicalRoot(rootDir),
      repoId: workspaceId(repoId),
      ownerId: "configure-only-test",
    });
    await assert.rejects(
      unprojected.read("repo.settings.read"),
      (error: Error & { code?: string }) => error.code === "projection_pending",
    );
    await unprojected.close();
    // Drop the pinned key so the reapply has something to do: an unconditional noop would pass the
    // no-write assertions below without ever proving that configuration is still applied.
    git(ledgerRoot, "config", "--unset", "maintenance.autoDetach");
    const reapplied = init(rootDir, true);
    assert.equal(reapplied.outcome, "applied");
    assert.match(reapplied.summary, /maintenance\.autoDetach=true/u);
    assert.equal(git(ledgerRoot, "config", "--get", "maintenance.autoDetach"), "true");
    assert.deepEqual(
      [reapplied.created, reapplied.updated, reapplied.drifted, reapplied.commit, reapplied.publication.changedPaths],
      [[], [], [], null, []],
    );
    assert.equal(git(ledgerRoot, "rev-parse", "HEAD"), head);
    assert.equal(init(rootDir, true).outcome, "noop");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init --configure-only refuses a workspace that was never initialized", () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-configure-only-absent-")));
  try {
    git(rootDir, "init", "-q");
    assert.throws(
      () => init(rootDir, true),
      (error: Error & { code?: string }) => error.code === "workspace_not_initialized",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("bootstrap resolves zero-argument identity at the daemon boundary", () => {
  const parent = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-bootstrap-defaults-"))),
    rootDir = path.join(parent, "Fixture Repo");
  try {
    mkdirSync(rootDir);
    git(rootDir, "init", "-q");
    git(rootDir, "config", "user.name", "Fixture Owner");
    const resolved = resolveRepoBootstrap({ rootDir }, auth);
    assert.equal(resolved.repoId, "fixture-repo");
    assert.equal(resolved.actor.principal.personId, "person-fixture-owner");
    const people = resolved.machineDocuments.find(({ path: target }) => target === "harness/people.yaml");
    const roster = JSON.parse(people?.body ?? "{}").people as Array<{ displayName: string }>;
    assert.equal(roster[0]?.displayName, "Fixture Owner");
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("bootstrap reports an actionable identity error without git user.name", () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-bootstrap-missing-name-")));
  try {
    git(rootDir, "init", "-q");
    const previousGlobal = process.env.GIT_CONFIG_GLOBAL,
      previousSystem = process.env.GIT_CONFIG_SYSTEM;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    try {
      assert.throws(
        () => resolveRepoBootstrap({ rootDir }, auth),
        (error: Error & { code?: string }) =>
          error.code === "bootstrap_identity_unavailable" && /git user\.name/u.test(error.message),
      );
    } finally {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
      if (previousSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
      else process.env.GIT_CONFIG_SYSTEM = previousSystem;
    }
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
