import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

const tracedSyscalls = [
  "write",
  "pwrite64",
  "fsync",
  "fdatasync",
  "rename",
  "renameat",
  "renameat2",
  "ftruncate",
  "unlink",
  "unlinkat",
];

export async function runUnderStrace({ command, args, tracePath, injection, cwd, env = process.env }) {
  const straceArgs = ["-f", "-qq", "-yy", "-s", "256", "-o", tracePath, "-e", `trace=${tracedSyscalls.join(",")}`];
  if (injection) straceArgs.push("-e", `inject=${injection}`);
  straceArgs.push("--", command, ...args);
  const result = await spawnCapture("strace", straceArgs, { cwd, env });
  return { ...result, trace: readFileSync(tracePath, "utf8") };
}

export function syscallOccurrences(trace, { pid, syscall, pathIncludes }) {
  const ordinals = new Map();
  const hits = [];
  for (const line of trace.split(/\r?\n/u)) {
    const parsed = parseTraceLine(line);
    if (parsed === null || parsed.syscall !== syscall) continue;
    if (pid !== undefined && parsed.pid !== null && parsed.pid !== pid) continue;
    const tracee = parsed.pid ?? "bare";
    const ordinal = (ordinals.get(tracee) ?? 0) + 1;
    ordinals.set(tracee, ordinal);
    if (pathIncludes === undefined || line.includes(pathIncludes)) hits.push({ tracee: parsed.pid, ordinal, line });
  }
  return hits;
}

function parseTraceLine(line) {
  const bracketed = line.match(/^\s*\[pid\s+(\d+)\]\s+([a-zA-Z0-9_]+)\(/u);
  if (bracketed) return { pid: Number(bracketed[1]), syscall: bracketed[2] };
  const numbered = line.match(/^\s*(\d+)\s+([a-zA-Z0-9_]+)\(/u);
  if (numbered) return { pid: Number(numbered[1]), syscall: numbered[2] };
  const bare = line.match(/^\s*([a-zA-Z0-9_]+)\(/u);
  return bare ? { pid: null, syscall: bare[1] } : null;
}

function spawnCapture(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}
