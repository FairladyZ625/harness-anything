import {
  /* @gate-identity check-sync-subprocess/sync-subprocess-001 */
  execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";
import type { RuntimeInstallationWitness, RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";

export const runtimeModelCatalogCache = new Map<
  string,
  { readonly models: readonly string[]; readonly defaultModel: string } | null
>();

export function discoverRuntimeInstallations(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => string;
    readonly platform?: NodeJS.Platform;
  } = {},
): readonly RuntimeInstallationWitness[] {
  const env = input.env ?? process.env,
    platform = input.platform ?? process.platform,
    observedAt = (input.now ?? (() => new Date().toISOString()))(),
    seen = new Set<string>(),
    result: RuntimeInstallationWitness[] = [],
    suffixes = platform === "win32" ? ["", ".cmd", ".exe"] : [""];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean))
    for (const kindId of ["claude", "codex", "agy"] as const)
      for (const suffix of suffixes) {
        const executableEntryPath = path.resolve(directory, `${kindId}${suffix}`),
          key = `${kindId}\0${executableEntryPath}`;
        try {
          accessSync(executableEntryPath, constants.X_OK);
          if (seen.has(key)) continue;
          const executablePath = realpathSync.native(executableEntryPath),
            version = runExecutableSync(platform, executablePath, ["--version"], {
              env: versionProbeEnvironment(env, platform),
              timeoutMs: 5_000,
              captureOutput: true,
            });
          if (!version) continue;
          seen.add(key);
          const installationId = `${kindId}_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
            catalog = discoverRuntimeModelCatalog({
              platform,
              executablePath,
              kindId,
              env,
              version,
            });
          result.push({
            installationId,
            kindId,
            executableEntryPath,
            executablePath,
            version,
            observedAt,
            ...(catalog ?? {}),
          });
        } catch (error) {
          consumeKnownError(error);
        }
      }
  return result.sort((a, b) => a.installationId.localeCompare(b.installationId));
}

export function discoverRuntimeModelCatalog(input: {
  readonly platform: NodeJS.Platform;
  readonly executablePath: string;
  readonly kindId: RuntimeInstanceKind;
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
}): {
  readonly models: readonly string[];
  readonly defaultModel: string;
} | null {
  const cacheKey = `${input.kindId}\0${input.executablePath}\0${input.version}`;
  if (runtimeModelCatalogCache.has(cacheKey)) return runtimeModelCatalogCache.get(cacheKey) ?? null;
  let models: string[] = [];
  try {
    const args =
        input.kindId === "codex" ? ["debug", "models", "--bundled"] : input.kindId === "agy" ? ["models"] : ["--help"],
      output = runExecutableSync(input.platform, input.executablePath, args, {
        env: input.env,
        timeoutMs: 8_000,
        captureOutput: true,
      });
    if (input.kindId === "codex") {
      const decoded = JSON.parse(output) as {
        readonly models?: readonly {
          readonly slug?: unknown;
          readonly id?: unknown;
        }[];
      };
      models = (decoded.models ?? [])
        .map((model) => (typeof model.slug === "string" ? model.slug : typeof model.id === "string" ? model.id : ""))
        .filter(Boolean);
    } else if (input.kindId === "agy")
      models = output
        .split(/\r?\n/u)
        .map((line) => (line.includes("\t") ? line.split("\t", 1)[0]!.trim() : ""))
        .filter((model) => /^[A-Za-z0-9][A-Za-z0-9._-]+$/u.test(model));
    else
      models = ["fable", "sonnet", "opus"].filter(
        (alias) => output.includes(`'${alias}'`) || output.includes(`"${alias}"`),
      );
  } catch (error) {
    consumeKnownError(error);
  }
  const unique = [...new Set(models)],
    catalog = unique[0] ? { models: unique, defaultModel: unique[0] } : null;
  runtimeModelCatalogCache.set(cacheKey, catalog);
  return catalog;
}

export function versionProbeEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? "",
    LANG: "C",
    LC_ALL: "C",
  };
  if (platform === "win32")
    for (const key of ["SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC", "PATHEXT", "TEMP", "TMP"])
      if (env[key]) result[key] = env[key];
  return result;
}

// Executes a witnessed runtime executable across platforms without `shell: true`:
// native executables spawn argv-direct, while Windows command shims (.cmd/.bat)
// run through an explicit cmd.exe argv with a fully controlled command line.
export function runExecutableSync(
  platform: NodeJS.Platform,
  executablePath: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly captureOutput: boolean;
  },
): string {
  const shim = platform === "win32" && /\.(?:cmd|bat)$/iu.test(executablePath);
  const stdout =
    /* @gate-identity check-sync-subprocess/sync-subprocess-002 */
    execFileSync(
    shim ? "cmd.exe" : executablePath,
    shim ? ["/d", "/s", "/c", `"${executablePath}" ${args.join(" ")}`] : [...args],
    {
      encoding: "utf8",
      env: options.env,
      stdio: ["ignore", options.captureOutput ? "pipe" : "ignore", "ignore"],
      timeout: options.timeoutMs,
      windowsHide: true,
      ...(shim ? { windowsVerbatimArguments: true } : {}),
    },
  );
  return options.captureOutput ? stdout.trim() : "";
}
