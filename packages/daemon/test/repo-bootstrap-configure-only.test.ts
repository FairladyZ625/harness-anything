// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { bindWriterGenerationToken } from "../../kernel/src/index.ts";
import { bootstrapRepo, resolveRepoBootstrap, type RepoBootstrapReceipt, type RepoBootstrapRequest } from "../src/repo-bootstrap.ts";
import type { DaemonAuthenticationContext } from "../src/transport/auth-context.ts";

const repoId = "configure-only";
const auth = { transportKind: "unix-socket", unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" } } as unknown as DaemonAuthenticationContext;
const writer = { workspaceId: repoId, ownerId: "configure-only-test", generation: 0 };
function git(rootDir: string, ...args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim(); }
function init(rootDir: string, configureOnly: boolean): RepoBootstrapReceipt {
  const request: RepoBootstrapRequest = { rootDir, repoId, personId: "owner", displayName: "Owner", ...(configureOnly ? { configureOnly: true } : {}) };
  return bootstrapRepo(resolveRepoBootstrap(request, auth), writer, bindWriterGenerationToken(writer));
}

test("init --configure-only reapplies ledger maintenance without writing the workspace", () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-configure-only-")));
  try {
    git(rootDir, "init", "-q");
    assert.equal(init(rootDir, false).publication.ok, true);
    const ledgerRoot = path.join(rootDir, "harness"), head = git(ledgerRoot, "rev-parse", "HEAD");
    // Drop the pinned key so the reapply has something to do: an unconditional noop would pass the
    // no-write assertions below without ever proving that configuration is still applied.
    git(ledgerRoot, "config", "--unset", "maintenance.autoDetach");
    const reapplied = init(rootDir, true);
    assert.equal(reapplied.outcome, "applied");
    assert.match(reapplied.summary, /maintenance\.autoDetach=true/u);
    assert.equal(git(ledgerRoot, "config", "--get", "maintenance.autoDetach"), "true");
    assert.deepEqual([reapplied.created, reapplied.updated, reapplied.drifted, reapplied.commit, reapplied.publication.changedPaths], [[], [], [], null, []]);
    assert.equal(git(ledgerRoot, "rev-parse", "HEAD"), head);
    assert.equal(init(rootDir, true).outcome, "noop");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});

test("init --configure-only refuses a workspace that was never initialized", () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-configure-only-absent-")));
  try {
    git(rootDir, "init", "-q");
    assert.throws(() => init(rootDir, true), (error: Error & { code?: string }) => error.code === "workspace_not_initialized");
  } finally { rmSync(rootDir, { recursive: true, force: true }); }
});
