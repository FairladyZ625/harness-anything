import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";

export const cli = path.resolve("packages/cli/src/index.ts");

export function run(root: string, env: NodeJS.ProcessEnv, args: readonly string[]): Record<string, unknown> {
  const result = runMaybe(root, env, args);
  assert.equal(result.status, 0, `${result.stderr}\n${JSON.stringify(result.receipt)}`);
  return result.receipt;
}
// Writes return at durable acceptance; a test that reads Git or the worktree waits for both followers explicitly.
export function published(
  root: string,
  env: NodeJS.ProcessEnv,
  receipt: Record<string, unknown>,
): Record<string, unknown> {
  const wait = ["--wait", "git_verified,worktree_visible", "--timeout-ms", "5000"];
  return run(root, env, ["receipt", "show", String(receipt.opId), ...wait]);
}
export function runMaybe(
  root: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): {
  readonly status: number | null;
  readonly pid: number | undefined;
  readonly receipt: Record<string, unknown>;
  readonly stderr: string;
} {
  const result = spawnSync(process.execPath, [cli, "--root", root, "--json", ...args], { encoding: "utf8", env });
  return {
    status: result.status,
    pid: result.pid,
    receipt: result.stdout.trim() ? (JSON.parse(result.stdout) as Record<string, unknown>) : {},
    stderr: result.stderr,
  };
}
export function runAsync(
  root: string,
  env: NodeJS.ProcessEnv,
  args: readonly string[],
): Promise<{
  readonly status: number | null;
  readonly pid: number | undefined;
  readonly receipt: Record<string, unknown>;
  readonly stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, "--root", root, "--json", ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) =>
      resolve({
        status,
        pid: child.pid,
        receipt: stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {},
        stderr,
      }),
    );
  });
}
