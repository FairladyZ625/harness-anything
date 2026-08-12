import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DaemonAuthenticationContext } from "./transport/auth-context.ts";

export interface RepoBootstrapInput { readonly rootDir: string; readonly repoId: string; readonly personId: string; readonly displayName: string }

export function bootstrapRepo(input: RepoBootstrapInput, auth: DaemonAuthenticationContext): string {
  const uid = auth.unixSocketOwnerBoundary?.ownerUid;
  if (typeof uid !== "number") throw bootstrapCodedError("bootstrap_identity_unavailable", "Bootstrap requires the local socket owner boundary.");
  if (!/^[a-z][a-z0-9-]{0,62}$/u.test(input.repoId)) throw bootstrapCodedError("invalid_repo_id", "repo-id must use lowercase letters, numbers, and hyphens.");
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,62}$/u.test(input.personId)) throw bootstrapCodedError("invalid_person_id", "person-id must start with a letter and use letters, numbers, hyphens, or underscores.");
  if (!input.displayName.trim() || /[\r\n]/u.test(input.displayName)) throw bootstrapCodedError("invalid_display_name", "display-name must be one non-empty line.");
  const requestedRoot = path.resolve(input.rootDir); mkdirSync(requestedRoot, { recursive: true }); const rootDir = realpathSync.native(requestedRoot);
  const harnessDir = path.join(rootDir, "harness"), configPath = path.join(harnessDir, "harness.yaml"), peoplePath = path.join(harnessDir, "people.yaml");
  const initialized = existsSync(configPath) && existsSync(peoplePath);
  if (existsSync(configPath) !== existsSync(peoplePath)) throw bootstrapCodedError("bootstrap_incomplete", "harness.yaml and people.yaml must either both exist or both be absent.");
  git(rootDir, ["init", "--quiet"]);
  if (!initialized) {
    mkdirSync(harnessDir, { recursive: true });
    writeFileSync(configPath, `schema: harness-anything/v1\nname: ${input.repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`, "utf8");
    writeFileSync(peoplePath, `${JSON.stringify({ schema: "harness-people/v1", people: [{ personId: input.personId, displayName: input.displayName,
      roles: ["owner"], credentials: [{ kind: "unix-socket-owner-boundary", issuer: `host:${os.hostname()}`, subject: String(uid) }] }],
    roles: [{ roleId: "owner", commandClasses: ["admin", "repo-write", "repo-read", "arbiter"] }] }, null, 2)}\n`, "utf8");
  }
  if (git(rootDir, ["status", "--porcelain", "--", "harness/harness.yaml", "harness/people.yaml"]).trim()) {
    git(rootDir, ["add", "--", "harness/harness.yaml", "harness/people.yaml"]);
    git(rootDir, ["-c", "user.name=Harness Bootstrap", "-c", "user.email=harness-bootstrap@local.invalid", "commit", "--quiet", "-m", "Initialize harness workspace"]);
  }
  return rootDir;
}
function git(rootDir: string, args: readonly string[]): string { return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
function bootstrapCodedError(code: string, message: string): Error { const error = new Error(message) as Error & { code: string }; error.code = code; return error; }
