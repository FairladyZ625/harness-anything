import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertCurrentWriter, type WriterGeneration, type WriterGenerationToken } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId, type CanonicalRoot, type WorkspaceId } from "./protocol/daemon-protocol.contract.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";
import { runProcessText } from "./process-port.ts";

export interface RepoBootstrapRequest { readonly rootDir: string; readonly repoId: string; readonly personId: string; readonly displayName: string }
export interface RepoBootstrapInput { readonly rootDir: CanonicalRoot; readonly repoId: WorkspaceId; readonly personId: string; readonly displayName: string }
export function resolveRepoBootstrap(input: RepoBootstrapRequest): RepoBootstrapInput {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(input.personId)) throw coded("invalid_person_id", "person-id must start with a letter and use letters, numbers, hyphens, or underscores.");
  if (!input.displayName.trim() || /[\r\n]/u.test(input.displayName)) throw coded("invalid_display_name", "display-name must be one non-empty line.");
  return { ...input, rootDir: canonicalRoot(input.rootDir, true), repoId: workspaceId(input.repoId) };
}
function resolveBootstrapAuthoredBranch(rootDir: CanonicalRoot): string {
  mkdirSync(rootDir, { recursive: true }); git(rootDir, ["init", "--quiet"]);
  const remote = optionalGit(rootDir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]), current = optionalGit(rootDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const branch = remote?.replace(/^origin\//u, "") ?? current;
  if (!branch || !validBranch(branch)) throw coded("publication_indeterminate", "Bootstrap cannot bind a safe default authored branch before publication.");
  return branch;
}
export function bootstrapRepo(input: RepoBootstrapInput, auth: DaemonAuthenticationContext, activeWriter: WriterGeneration,
  writerToken: WriterGenerationToken, authoredBranch?: string): string {
  const uid = auth.unixSocketOwnerBoundary?.ownerUid;
  if (typeof uid !== "number") throw coded("bootstrap_identity_unavailable", "Bootstrap requires the local socket owner boundary.");
  assertCurrentWriter(activeWriter, writerToken, input.repoId);
  const rootDir = input.rootDir, boundBranch = authoredBranch ?? resolveBootstrapAuthoredBranch(rootDir), harnessDir = path.join(rootDir, "harness"), configPath = path.join(harnessDir, "harness.yaml"), peoplePath = path.join(harnessDir, "people.yaml");
  const initialized = existsSync(configPath) && existsSync(peoplePath);
  if (existsSync(configPath) !== existsSync(peoplePath)) throw coded("bootstrap_incomplete", "harness.yaml and people.yaml must either both exist or both be absent.");
  mkdirSync(rootDir, { recursive: true }); git(rootDir, ["init", "--quiet"]); checkoutAuthoredBranch(rootDir, boundBranch);
  if (!initialized) { mkdirSync(harnessDir, { recursive: true });
    writeFileSync(configPath, `schema: harness-anything/v1\nname: ${input.repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\nsettings:\n  defaultVertical: software/coding\n  defaultPreset: standard-task\n  defaultProfile: baseline\n  locale: en-US\n  taskScaffold: governance/task-scaffold.json\n`, "utf8");
    writeFileSync(peoplePath, `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: input.personId, displayName: input.displayName,
      roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${os.hostname()}`, subject: String(uid) }] }],
    roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }] }, null, 2)}\n`, "utf8"); }
  if (git(rootDir, ["status", "--porcelain", "--", "harness/harness.yaml", "harness/people.yaml"]).trim()) { git(rootDir, ["add", "--", "harness/harness.yaml", "harness/people.yaml"]);
    git(rootDir, ["-c", "user.name=Harness Bootstrap", "-c", "user.email=harness-bootstrap@local.invalid", "commit", "--quiet", "-m", "Initialize harness workspace"]); }
  return boundBranch;
}
function checkoutAuthoredBranch(rootDir: CanonicalRoot, authoredBranch: string): void {
  if (!validBranch(authoredBranch)) throw coded("publication_indeterminate", "Bootstrap authored branch is invalid.");
  if (optionalGit(rootDir, ["symbolic-ref", "--quiet", "--short", "HEAD"]) === authoredBranch) return;
  if (optionalGit(rootDir, ["rev-parse", "--verify", "--quiet", `refs/heads/${authoredBranch}`])) git(rootDir, ["checkout", "--quiet", authoredBranch]);
  else if (optionalGit(rootDir, ["rev-parse", "--verify", "--quiet", "HEAD"])) { git(rootDir, ["branch", authoredBranch, "HEAD"]); git(rootDir, ["checkout", "--quiet", authoredBranch]); }
  else git(rootDir, ["symbolic-ref", "HEAD", `refs/heads/${authoredBranch}`]);
}
function git(rootDir: CanonicalRoot, args: readonly string[]): string { return runProcessText("git", ["-C", rootDir, ...args]); }
function optionalGit(rootDir: CanonicalRoot, args: readonly string[]): string | null { try { const value = git(rootDir, args).trim(); return value || null; } catch (error) { consumeKnownError(error); return null; } }
function validBranch(value: string): boolean { return value.length > 0 && !value.startsWith("-") && !value.includes("..") && !/[~^:?*[\\\s]/u.test(value) && !value.endsWith("/") && !value.endsWith(".lock"); }
function coded(code: string, message: string): Error { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
function consumeKnownError(error: unknown): void { void error; }
