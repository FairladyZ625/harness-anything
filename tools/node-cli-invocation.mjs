import { existsSync } from "node:fs";
import path from "node:path";

export function resolveNpmCliPath({
  env = process.env,
  execPath = process.execPath,
  fileExists = existsSync
} = {}) {
  const candidates = [
    env.npm_execpath,
    path.resolve(execPath, "..", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(execPath, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(execPath, "..", "..", "..", "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")
  ];
  const resolved = candidates.find((candidate) => typeof candidate === "string" && candidate.length > 0 && fileExists(candidate));
  if (resolved) return resolved;
  throw new Error("Unable to resolve npm-cli.js. Run this command through npm or install npm beside the active Node.js runtime.");
}

export function npmCliInvocation(args, options = {}) {
  const execPath = options.execPath ?? process.execPath;
  return {
    command: execPath,
    args: [resolveNpmCliPath({ ...options, execPath }), ...args]
  };
}

export function localNodeCliInvocation(rootDir, relativeCliPath, args = [], fileExists = existsSync) {
  const cliPath = path.resolve(rootDir, relativeCliPath);
  if (!fileExists(cliPath)) throw new Error(`Local JavaScript CLI is unavailable: ${relativeCliPath}`);
  return { command: process.execPath, args: [cliPath, ...args] };
}
