import { execFileSync, spawn } from "node:child_process";
export const detachedProcessOptions = Object.freeze({ detached: true, stdio: "ignore" as const, windowsHide: true });
export function startDetachedProcess(command: string, args: readonly string[], env: NodeJS.ProcessEnv): void { const child = spawn(command, [...args], { ...detachedProcessOptions, env }); child.unref(); }
export function terminateProcess(pid: number): void { process.kill(pid, "SIGTERM"); }
export function runProcessText(command: string, args: readonly string[], cwd?: string, env?: NodeJS.ProcessEnv): string { return execFileSync(command, [...args], { cwd, ...(env ? { env } : {}), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
