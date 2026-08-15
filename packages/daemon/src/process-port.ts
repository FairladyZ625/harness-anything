import { execFileSync, spawn } from "node:child_process";
export const detachedProcessOptions = Object.freeze({ detached: true, stdio: "ignore" as const, windowsHide: true });
export function startDetachedProcess(command: string, args: readonly string[], env: NodeJS.ProcessEnv): void { const child = spawn(command, [...args], { ...detachedProcessOptions, env }); child.unref(); }
// Fire-and-forget spawn cannot tell the caller why the child never came up; this
// variant resolves once the process exists and rejects with the OS error (ENOENT,
// EACCES, ...) so autostart callers can classify launcher-level failures.
export function startDetachedProcessChecked(command: string, args: readonly string[], env: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((resolve, reject) => { const child = spawn(command, [...args], { ...detachedProcessOptions, env }); const onSpawn = () => { child.removeListener("error", onError); child.unref(); resolve(); }; const onError = (error: Error) => reject(error); child.once("spawn", onSpawn); child.once("error", onError); });
}
export function terminateProcess(pid: number): void { process.kill(pid, "SIGTERM"); }
export function runProcessText(command: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): string { return execFileSync(command, [...args], { cwd, ...(env ? { env } : {}), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
export function makeGitReadinessSource() { return { run: (rootDir: string, args: readonly string[], allowNoMatch = false) => { try { return { ok: true, stdout: runProcessText("git", args, rootDir).trim() }; } catch (error) { const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null; return { ok: allowNoMatch && status === 1, stdout: "" }; } } }; }
