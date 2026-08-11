// fs / ps / git / display helpers for runtime-attestation.ts. Kept in a sibling
// module so the attestation orchestrator stays under the file-complexity gate
// and the helpers can be unit-tested in isolation where useful.

import { execFileSync } from "node:child_process";
import { type Dirent, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function latestMtimeIso(root: string, extensions: ReadonlySet<string>): string | null {
  if (!existsSync(root)) return null;
  let latestMs = 0;
  visitSourceFiles(root, (filePath) => {
    if (!extensions.has(path.extname(filePath))) return;
    try {
      const mtimeMs = statSync(filePath).mtimeMs;
      if (mtimeMs > latestMs) latestMs = mtimeMs;
    } catch {
      // Race with a concurrent writer; skip.
    }
  });
  return latestMs === 0 ? null : new Date(latestMs).toISOString();
}

export function hasFilesUnder(root: string, extensions: ReadonlySet<string>): boolean {
  if (!existsSync(root)) return false;
  let found = false;
  visitSourceFiles(root, (filePath) => {
    if (found || !extensions.has(path.extname(filePath))) return;
    found = true;
  });
  return found;
}

export function visitSourceFiles(root: string, visit: (filePath: string) => void): void {
  const pending: string[] = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: ReadonlyArray<Dirent>;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(absolutePath);
      } else if (entry.isFile()) {
        visit(absolutePath);
      }
    }
  }
}

export function readPsField(pid: number, platform: NodeJS.Platform, field: string): string | null {
  if (platform === "win32") return null;
  try {
    const output = execFileSync("ps", ["-o", field, "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
    return output.length === 0 ? null : output;
  } catch {
    return null;
  }
}

export function readPsLstartIso(pid: number, platform: NodeJS.Platform): string | null {
  const raw = readPsField(pid, platform, "lstart=");
  if (raw === null) return null;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function extractEntrypointFromCommand(command: string): string | null {
  const tokens = command.split(/\s+/u).filter(Boolean);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "node" || token === "node.exe" || /(?:^|\/)node(\.exe)?$/u.test(token)) {
      for (let j = i + 1; j < tokens.length; j++) {
        const candidate = tokens[j]!;
        if (candidate.startsWith("-")) continue;
        if (/\.(?:js|mjs|cjs|ts|mts|cts)$/u.test(candidate)) {
          return candidate;
        }
      }
    }
  }
  return null;
}

export function nullableGitOutput(rootDir: string, args: ReadonlyArray<string>): string | null {
  try {
    const output = execFileSync("git", ["-C", rootDir, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
    return output.length === 0 ? null : output;
  } catch {
    return null;
  }
}

export function gitStatusPorcelain(rootDir: string): string {
  try {
    return execFileSync("git", ["-C", rootDir, "status", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true
    }).trim();
  } catch {
    return "";
  }
}

export function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function realpathSafe(target: string): string {
  try {
    return path.resolve(realpathSync(target));
  } catch {
    return path.resolve(target);
  }
}

export function relativeOrAbsolute(root: string, target: string): string {
  const relative = path.relative(root, target);
  return relative && !relative.startsWith("..") ? relative.split(path.sep).join("/") : target;
}

export function displayHomePath(target: string): string {
  const home = os.homedir();
  if (target === home) return "~";
  if (target.startsWith(`${home}${path.sep}`)) {
    return `~${path.sep}${path.relative(home, target)}`;
  }
  return path.basename(target);
}

export function displaySocketEndpoint(endpoint: string, platform: NodeJS.Platform): string {
  if (platform === "win32") return path.basename(endpoint);
  return displayHomePath(endpoint);
}
