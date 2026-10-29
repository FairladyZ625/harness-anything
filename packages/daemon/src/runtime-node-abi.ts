import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { runtimeInstanceError } from "./agent-runtime-instance-config.ts";
import type { RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { runtimeKindForId } from "./runtime-inventory.ts";

const abiProbeTimeoutMs = 5_000;

/**
 * Point a launch at the Node build its provider package was compiled for.
 *
 * A provider whose entry is `#!/usr/bin/env node` does not run under the daemon's
 * interpreter: the shebang resolves whichever `node` is first on PATH. When its
 * bundled native addon was built for one ABI, a different PATH node dies in
 * NODE_MODULE_VERSION before the provider speaks its protocol (mcode 0.4.6: addon
 * ABI 137, Homebrew node 26 ABI 147). The catalog declares the required ABI; this
 * finds a matching node — the daemon's own interpreter first, then PATH — and puts
 * its directory first, so the shebang resolves to that build.
 *
 * No match is a named refusal, never a fallback to the PATH node: falling back
 * would re-commit the exact crash this exists to prevent, one layer further from
 * the cause. The same discipline as the local `ha` wrapper's pinned runtime.
 */
export async function withNodeAbiEnvironment(
  env: NodeJS.ProcessEnv,
  kindId: RuntimeInstanceKind,
  platform: NodeJS.Platform,
  options: { readonly hostExecutable?: string } = {},
): Promise<NodeJS.ProcessEnv> {
  const required = runtimeKindForId(kindId).executable.nodeAbi;
  if (required === undefined) return env;
  const observed: string[] = [];
  for (const candidate of nodeCandidates(env, platform, options.hostExecutable ?? process.execPath)) {
    const abi = await nodeAbi(candidate, env, platform);
    if (abi === required) return prependPath(env, path.dirname(candidate));
    observed.push(abi === null ? `${candidate} (no ABI answer)` : `${candidate} (ABI ${abi})`);
  }
  throw runtimeInstanceError(
    "runtime_node_abi_unavailable",
    `${kindId} ships native modules built for Node ABI ${required}, but no node on PATH reports that ABI` +
      (observed.length ? ` (found ${observed.join(", ")})` : " (no node executable was found)") +
      ". Refusing to launch with an incompatible interpreter.",
  );
}

function nodeCandidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, hostExecutable: string): string[] {
  const executableName = platform === "win32" ? "node.exe" : "node",
    pathEntries = (env.PATH ?? "").split(path.delimiter).filter(Boolean),
    candidates = [hostExecutable, ...pathEntries.map((directory) => path.join(directory, executableName))],
    seen = new Set<string>();
  return candidates.filter((candidate) => {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved) || !existsSync(resolved)) return false;
    seen.add(resolved);
    return true;
  });
}

/** The candidate's `process.versions.modules`, or null when it cannot answer. A probe
 * that never starts or fails is not a verdict about the launch — the caller drops that
 * candidate and reports it beside the ABI it was looking for. */
function nodeAbi(executablePath: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      executablePath,
      ["-p", "process.versions.modules"],
      {
        encoding: "utf8",
        timeout: abiProbeTimeoutMs,
        windowsHide: true,
        // The probe must not inherit NODE_OPTIONS or other interpreter-shaping variables
        // from the launch environment: only PATH (and the Windows system root DLL lookup)
        // is needed to report an ABI, and a caller's NODE_OPTIONS could rewrite the answer.
        env:
          platform === "win32"
            ? { PATH: env.PATH, SystemRoot: env.SystemRoot, SystemDrive: env.SystemDrive }
            : { PATH: env.PATH },
      },
      (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const abi = Number.parseInt(stdout.trim(), 10);
        resolve(Number.isSafeInteger(abi) ? abi : null);
      },
    );
  });
}

function prependPath(env: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  const entries = (env.PATH ?? "").split(path.delimiter).filter(Boolean);
  if (entries[0] === directory) return env;
  return { ...env, PATH: [directory, ...entries.filter((entry) => entry !== directory)].join(path.delimiter) };
}
