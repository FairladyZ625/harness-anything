import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertCurrentWriter, type WriterGeneration, type WriterGenerationToken } from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId, type CanonicalRoot, type WorkspaceId } from "./protocol/daemon-protocol.contract.ts";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export interface RepoBootstrapRequest { readonly rootDir: string; readonly repoId: string; readonly personId: string; readonly displayName: string }
export interface RepoBootstrapInput { readonly rootDir: CanonicalRoot; readonly repoId: WorkspaceId; readonly personId: string; readonly displayName: string }
export function resolveRepoBootstrap(input: RepoBootstrapRequest): RepoBootstrapInput {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(input.personId)) throw coded("invalid_person_id", "person-id must start with a letter and use letters, numbers, hyphens, or underscores.");
  if (!input.displayName.trim() || /[\r\n]/u.test(input.displayName)) throw coded("invalid_display_name", "display-name must be one non-empty line.");
  return { ...input, rootDir: canonicalRoot(input.rootDir, true), repoId: workspaceId(input.repoId) };
}
export function bootstrapRepo(input: RepoBootstrapInput, auth: DaemonAuthenticationContext, activeWriter: WriterGeneration,
  writerToken: WriterGenerationToken): void {
  const uid = auth.unixSocketOwnerBoundary?.ownerUid;
  if (typeof uid !== "number") throw coded("bootstrap_identity_unavailable", "Bootstrap requires the local socket owner boundary.");
  assertCurrentWriter(activeWriter, writerToken, input.repoId);
  const rootDir = input.rootDir, harnessDir = path.join(rootDir, "harness"), configPath = path.join(harnessDir, "harness.yaml"), peoplePath = path.join(harnessDir, "people.yaml");
  const initialized = existsSync(configPath) && existsSync(peoplePath);
  if (existsSync(configPath) !== existsSync(peoplePath)) throw coded("bootstrap_incomplete", "harness.yaml and people.yaml must either both exist or both be absent.");
  mkdirSync(rootDir, { recursive: true }); git(rootDir, ["init", "--quiet"]);
  if (!initialized) { mkdirSync(harnessDir, { recursive: true });
    writeFileSync(configPath, `schema: harness-anything/v1\nname: ${input.repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`, "utf8");
    writeFileSync(peoplePath, `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: input.personId, displayName: input.displayName,
      roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${os.hostname()}`, subject: String(uid) }] }],
    roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }] }, null, 2)}\n`, "utf8"); }
  if (git(rootDir, ["status", "--porcelain", "--", "harness/harness.yaml", "harness/people.yaml"]).trim()) { git(rootDir, ["add", "--", "harness/harness.yaml", "harness/people.yaml"]);
    git(rootDir, ["-c", "user.name=Harness Bootstrap", "-c", "user.email=harness-bootstrap@local.invalid", "commit", "--quiet", "-m", "Initialize harness workspace"]); }
}
function git(rootDir: CanonicalRoot, args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function coded(code: string, message: string): Error { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
