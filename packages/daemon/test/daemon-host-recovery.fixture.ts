import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

export const auth = {
  transportKind: "unix-socket",
  unixSocketOwnerBoundary: { ownerUid: process.getuid?.() ?? 0, source: "unix-socket-filesystem-owner-boundary" },
} as const;

export function rosterRepo(rootDir: string, repoId: string): void {
  mkdirSync(rootDir, { recursive: true });
  git(rootDir, "init", "--quiet");
  git(rootDir, "config", "user.name", "Host Recovery Test");
  git(rootDir, "config", "user.email", "host-recovery@example.invalid");
  git(rootDir, "config", "gc.auto", "0");
  git(rootDir, "commit", "--allow-empty", "--quiet", "-m", "fixture base");
  mkdirSync(path.join(rootDir, "harness"));
  writeFileSync(
    path.join(rootDir, "harness/harness.yaml"),
    `schema: harness-anything/v1\nname: ${repoId}\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n`,
  );
  const people = [
    {
      personId: "writer",
      displayName: "writer",
      roles: ["writer"],
      credentials: [
        { kind: "unix-socket-owner-boundary", issuer: `host:${hostname()}`, subject: String(process.getuid?.() ?? 0) },
      ],
    },
  ];
  const roles = [{ roleId: "writer", commandClasses: ["repo-read", "repo-write", "admin"] }];
  writeFileSync(
    path.join(rootDir, "harness/people.yaml"),
    `${JSON.stringify({ schema: "harness-people/v1", people, roles }, null, 2)}\n`,
  );
  git(rootDir, "add", "harness");
  git(rootDir, "commit", "--quiet", "-m", "add roster fixture");
}

function git(rootDir: string, ...args: readonly string[]): string {
  return execFileSync("git", ["-C", rootDir, ...args], { encoding: "utf8" }).trim();
}
