import { execFileSync } from "node:child_process";

export interface TaskCreatedBy {
  readonly name: string;
  readonly email: string;
}

export function resolveTaskCreatedBy(rootDir: string, explicit?: TaskCreatedBy): TaskCreatedBy | undefined {
  if (explicit) return normalizeTaskCreatedBy(explicit);
  const name = readGitConfig(rootDir, "user.name");
  const email = readGitConfig(rootDir, "user.email");
  if (!name || !email) return undefined;
  return { name, email };
}

function normalizeTaskCreatedBy(input: TaskCreatedBy): TaskCreatedBy | undefined {
  const name = cleanScalar(input.name);
  const email = cleanScalar(input.email);
  return name && email ? { name, email } : undefined;
}

function readGitConfig(rootDir: string, key: "user.name" | "user.email"): string | undefined {
  try {
    return cleanScalar(execFileSync("git", ["-C", rootDir, "config", "--get", key], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }));
  } catch {
    return undefined;
  }
}

function cleanScalar(value: string): string {
  return value.replace(/[\r\n]/gu, " ").trim();
}
