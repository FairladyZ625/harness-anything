import { createHash } from "node:crypto";
import { accessSync, constants, realpathSync } from "node:fs";
import path from "node:path";
import { consumeKnownError } from "../../kernel/src/index.ts";
import type { RuntimeInstallationWitness, RuntimeInstanceKind } from "./agent-runtime-instance-types.ts";
import { runProcessTextAsync } from "./process-port.ts";
import { runtimeKindForId, runtimeKinds, type RuntimeProviderDeclaration } from "./runtime-inventory.ts";

export const runtimeModelCatalogCache = new Map<
  string,
  Promise<{ readonly models: readonly string[]; readonly defaultModel: string } | null>
>();

export async function discoverRuntimeInstallations(
  input: {
    readonly env?: NodeJS.ProcessEnv;
    readonly now?: () => string;
    readonly platform?: NodeJS.Platform;
  } = {},
): Promise<readonly RuntimeInstallationWitness[]> {
  const env = input.env ?? process.env,
    platform = input.platform ?? process.platform,
    observedAt = (input.now ?? (() => new Date().toISOString()))(),
    seen = new Set<string>(),
    candidates: {
      readonly kindId: RuntimeInstanceKind;
      readonly executableEntryPath: string;
      readonly executablePath: string;
      readonly key: string;
    }[] = [],
    // Windows resolves commands through PATHEXT. An extensionless file is not
    // directly launchable by Node, so only inspect executable suffixes here;
    // test and real installations expose the command through a .cmd/.exe entry.
    suffixes = platform === "win32" ? [".cmd", ".exe"] : [""];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean))
    for (const { kindId, executable } of runtimeKinds)
      for (const suffix of suffixes) {
        const executableEntryPath = path.resolve(directory, `${executable.command}${suffix}`),
          key = `${kindId}\0${executableEntryPath}`;
        try {
          accessSync(executableEntryPath, constants.X_OK);
          if (seen.has(key)) continue;
          seen.add(key);
          const executablePath = realpathSync.native(executableEntryPath);
          candidates.push({ kindId, executableEntryPath, executablePath, key });
        } catch (error) {
          consumeKnownError(error);
        }
      }
  const discovered = await Promise.all(
      candidates.map(async ({ kindId, executableEntryPath, executablePath, key }) => {
        try {
          const version = await runExecutable(platform, executablePath, ["--version"], {
            env: versionProbeEnvironment(env, platform),
            timeoutMs: 5_000,
            captureOutput: true,
          });
          if (!version) return null;
          const installationId = `${kindId}_${createHash("sha256").update(key).digest("hex").slice(0, 24)}`,
            catalog = await discoverRuntimeModelCatalog({ platform, executablePath, kindId, env, version });
          return {
            installationId,
            kindId,
            executableEntryPath,
            executablePath,
            version,
            observedAt,
            ...(catalog ?? {}),
          } satisfies RuntimeInstallationWitness;
        } catch (error) {
          consumeKnownError(error);
          return null;
        }
      }),
    ),
    result = discovered.filter((entry): entry is Exclude<(typeof discovered)[number], null> => entry !== null);
  return result.sort((a, b) => a.installationId.localeCompare(b.installationId));
}

export function discoverRuntimeModelCatalog(input: {
  readonly platform: NodeJS.Platform;
  readonly executablePath: string;
  readonly kindId: RuntimeInstanceKind;
  readonly env: NodeJS.ProcessEnv;
  readonly version: string;
}): Promise<{
  readonly models: readonly string[];
  readonly defaultModel: string;
} | null> {
  const cacheKey = `${input.kindId}\0${input.executablePath}\0${input.version}`;
  const cached = runtimeModelCatalogCache.get(cacheKey);
  if (cached) return cached;
  const discovered = (async () => {
    let models: string[] = [];
    try {
      const declaration = runtimeKindForId(input.kindId);
      // A null probe is an explicit unavailable catalog, never an empty successful probe.
      if (declaration.executable.modelProbe === null) return null;
      const args = declaration.executable.modelProbe,
        output = await runExecutable(input.platform, input.executablePath, args, {
          env: input.env,
          timeoutMs: 8_000,
          captureOutput: true,
        });
      models = [...modelProbeParsers[declaration.executable.modelProbeFormat](output)];
    } catch (error) {
      consumeKnownError(error);
    }
    const unique = [...new Set(models)];
    return unique[0] ? { models: unique, defaultModel: unique[0] } : null;
  })();
  runtimeModelCatalogCache.set(cacheKey, discovered);
  return discovered;
}

type ModelProbeFormat = RuntimeProviderDeclaration["executable"]["modelProbeFormat"];

// Each CLI model-listing shape gets exactly one named parser; a new provider
// shape is a function here plus one catalog line, never a new code path.
const modelProbeParsers: Record<ModelProbeFormat, (output: string) => readonly string[]> = {
  "json-models": (output) => {
    const decoded = JSON.parse(output) as {
      readonly models?: readonly {
        readonly slug?: unknown;
        readonly id?: unknown;
      }[];
    };
    return (decoded.models ?? [])
      .map((model) => (typeof model.slug === "string" ? model.slug : typeof model.id === "string" ? model.id : ""))
      .filter(Boolean);
  },
  // devin `models list --format json` (3000.10.27, F-069741D0):
  // {families:[{slug,aliases,variants:[{model_uid}]}]} — the family slug is the
  // launch-level model token, so the catalog flattens families, not variants.
  "json-families": (output) => {
    const decoded = JSON.parse(output) as {
      readonly families?: readonly { readonly slug?: unknown }[];
    };
    return (decoded.families ?? [])
      .map((family) => family.slug)
      .filter((slug): slug is string => typeof slug === "string" && slug !== "");
  },
  "tabular-models": (output) =>
    output
      .split(/\r?\n/u)
      .map((line) => (line.includes("\t") ? line.split("\t", 1)[0]!.trim() : ""))
      .filter((model) => /^[A-Za-z0-9][A-Za-z0-9._-]+$/u.test(model)),
  "aliases-from-help": (output) =>
    ["fable", "sonnet", "opus"].filter((alias) => output.includes(`'${alias}'`) || output.includes(`"${alias}"`)),
};

/** Merges models observed on the ACP `session/new` response into the catalog
 * cache that CLI probes feed, so a protocol-advertised model set reaches the
 * same consumption surface as a probed one. Union-only: observed models never
 * remove probed or user-entered entries. */
export function observeRuntimeModels(input: {
  readonly kindId: RuntimeInstanceKind;
  readonly executablePath: string;
  readonly version: string;
  readonly models: readonly string[];
  readonly currentModel?: string;
}): void {
  const observed = [...new Set(input.models.filter((model) => model !== ""))];
  if (observed.length === 0) return;
  const cacheKey = `${input.kindId}\0${input.executablePath}\0${input.version}`,
    previous = runtimeModelCatalogCache.get(cacheKey),
    merged = (async () => {
      const base = previous ? await previous : null,
        models = [...new Set([...(base?.models ?? []), ...observed])],
        defaultModel = base?.defaultModel ?? input.currentModel ?? models[0]!;
      return { models, defaultModel };
    })();
  runtimeModelCatalogCache.set(cacheKey, merged);
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
export async function runExecutable(
  platform: NodeJS.Platform,
  executablePath: string,
  args: readonly string[],
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly timeoutMs: number;
    readonly captureOutput: boolean;
  },
): Promise<string> {
  const shim = (platform === "win32" || process.platform === "win32") && /\.(?:cmd|bat)$/iu.test(executablePath);
  const command =
    shim && process.platform === "win32" ? (process.env.ComSpec ?? process.env.COMSPEC ?? "cmd.exe") : "cmd.exe";
  const stdout = await runProcessTextAsync(
    shim ? command : executablePath,
    shim ? ["/d", "/s", "/c", `"${executablePath}" ${args.join(" ")}`] : [...args],
    undefined,
    options.env,
    undefined,
    undefined,
    { timeoutMs: options.timeoutMs, ...(shim ? { windowsVerbatimArguments: true } : {}) },
  );
  return options.captureOutput ? stdout.trim() : "";
}
