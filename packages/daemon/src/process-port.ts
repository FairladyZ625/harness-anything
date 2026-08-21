import { execFile, execFileSync, spawn } from "node:child_process";
import { closeDaemonOutputFd, openDaemonOutputFd } from "./lifecycle-log.ts";
export const detachedProcessOptions = Object.freeze({ detached: true, stdio: "ignore" as const, windowsHide: true });
export function startDetachedProcess(command: string, args: readonly string[], env: NodeJS.ProcessEnv, outputPath?: string): void { const outputFd = outputPath ? openDaemonOutputFd(outputPath) : null;
  try { const child = spawn(command, [...args], { ...detachedProcessOptions, ...(outputFd === null ? {} : { stdio: ["ignore", outputFd, outputFd] }), env }); child.once("spawn", () => { if (outputFd !== null) closeDaemonOutputFd(outputFd); }); child.once("error", () => { if (outputFd !== null) closeDaemonOutputFd(outputFd); }); child.unref(); }
  catch (error) { if (outputFd !== null) closeDaemonOutputFd(outputFd); throw error; } }
// Fire-and-forget spawn cannot tell the caller why the child never came up; this
// variant resolves once the process exists and rejects with the OS error (ENOENT,
// EACCES, ...) so autostart callers can classify launcher-level failures.
export function startDetachedProcessChecked(command: string, args: readonly string[], env: NodeJS.ProcessEnv, outputPath?: string): Promise<void> {
  return new Promise((resolve, reject) => { const outputFd = outputPath ? openDaemonOutputFd(outputPath) : null; let child: ReturnType<typeof spawn>;
    try { child = spawn(command, [...args], { ...detachedProcessOptions, ...(outputFd === null ? {} : { stdio: ["ignore", outputFd, outputFd] }), env }); }
    catch (error) { if (outputFd !== null) closeDaemonOutputFd(outputFd); throw error; }
    const closeParentFd = () => { if (outputFd !== null) closeDaemonOutputFd(outputFd); }; const onSpawn = () => { child.removeListener("error", onError); closeParentFd(); child.unref(); resolve(); }; const onError = (error: Error) => { closeParentFd(); reject(error); }; child.once("spawn", onSpawn); child.once("error", onError); });
}
export function terminateProcess(pid: number): void { process.kill(pid, "SIGTERM"); }
// Long synchronous stretches (workspace replay, batch migration) cannot run
// signal handlers; yielding one macrotask turn between bounded segments lets a
// pending SIGTERM reach its handler at the next safe point.
export function yieldToEventLoop(): Promise<void> { return new Promise((resolve) => setImmediate(resolve)); }
export function runProcessText(command: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): string { return execFileSync(command, [...args], { cwd, ...(env ? { env } : {}), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
export function runProcessTextAsync(command: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(command, [...args], { cwd, ...(env ? { env } : {}), encoding: "utf8", windowsHide: true }, (error, stdout, stderr) => {
      if (error) { Object.assign(error, { stdout, stderr }); reject(error); return; }
      resolve(stdout);
    });
    child.stdin?.end();
  });
}
export function makeGitReadinessSource() { return { run: (rootDir: string, args: readonly string[], allowNoMatch = false) => { try { return { ok: true, stdout: runProcessText("git", args, rootDir).trim() }; } catch (error) { const status = typeof error === "object" && error && "status" in error ? Number(error.status) : null; return { ok: allowNoMatch && status === 1, stdout: "" }; } } }; }
