import { commandInterceptionNeedsFiles } from "./runtime-command-interception-files.ts";
import { isNonEmptyString } from "@harness-anything/kernel/internal/domain/contract-validation.ts";
import { commandInterceptionHook, type CommandInterceptions } from "./runtime-command-interceptions.ts";
import { isUtf8 } from "node:buffer";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { commandInterceptionIssues, consumeKnownError } from "@harness-anything/kernel";
import {
  resolveRuntimeMcpPolicy,
  type RuntimeIsolationState,
  type RuntimeMcpPolicy,
  type RuntimePermissionMode,
} from "../runtime-engine/runtime-permissions.ts";
import type {
  RuntimeInstanceKind,
  RuntimeInstanceConfig,
  RuntimeInstallationWitness,
  RuntimeAuthReadiness,
} from "./agent-runtime-instance-types.ts";
import { runExecutable } from "./agent-runtime-installation-discovery.ts";
import { providerConfigDirectory, tomlString } from "./agent-runtime-instance-storage.ts";
import {
  isRuntimeInstanceRecord,
  requiredRuntimeInstanceText,
  runtimeInstanceError,
  available,
  unavailable,
} from "./agent-runtime-instance-values.ts";
import {
  claudeWorkspaceWriteSandbox,
  codexToolEnvironmentConfig,
  runtimeKindForId,
  type RuntimeProviderDeclaration,
} from "../runtime-engine/runtime-inventory.ts";
import { assertRuntimeWebSearchSupported, runtimeWebSearchForConfig } from "./agent-runtime-web-search.ts";

// Platform-derived isolation environment. POSIX keeps HOME/TMPDIR/XDG_RUNTIME_DIR
// semantics; Windows derives the same guarantees from USERPROFILE/TEMP/APPDATA and
// must not inject XDG_RUNTIME_DIR. Pass-through stays an explicit allowlist of
// machine/user-neutral variables; host credentials never leak in.
// A launch scoped to one runtime session passes its own tempDirectory so one-off
// scratch never piles up in the instance-wide root; settlement reclaims it.
// Isolated AGY/AGY-ACP instances force file-based OAuth storage via SSH_CONNECTION so
// composite_token_storage.go skips OS Keychain calls under a Keychain-less isolated HOME.
const agyFileTokenStorageEnvironment: NodeJS.ProcessEnv = { SSH_CONNECTION: "127.0.0.1 0 127.0.0.1 22" };

export function isolatedEnvironment(
  source: NodeJS.ProcessEnv,
  stateRoot: string,
  kindId: RuntimeInstanceKind,
  platform: NodeJS.Platform,
  tempDirectory?: string,
): NodeJS.ProcessEnv {
  const home = path.join(stateRoot, "home"),
    tmp = tempDirectory ?? path.join(stateRoot, "tmp"),
    environment = runtimeKindForId(kindId).executable.configHomeEnvironment,
    kind = {
      ...(environment ? { [environment]: providerConfigDirectory(home, kindId) } : {}),
      ...(kindId === "agy" || kindId === "agy-acp" ? agyFileTokenStorageEnvironment : {}),
    };
  if (platform === "win32") {
    const result: NodeJS.ProcessEnv = {
      USERPROFILE: home,
      TEMP: tmp,
      TMP: tmp,
      APPDATA: path.join(home, "AppData", "Roaming"),
      LOCALAPPDATA: path.join(home, "AppData", "Local"),
      ...kind,
    };
    for (const key of ["PATH", "PATHEXT", "LANG", "LC_ALL", "SYSTEMROOT", "SYSTEMDRIVE", "COMSPEC"])
      if (source[key]) result[key] = source[key];
    return result;
  }
  const result: NodeJS.ProcessEnv = {
    HOME: home,
    TMPDIR: tmp,
    XDG_RUNTIME_DIR: path.join(stateRoot, "run"),
    ...kind,
  };
  for (const key of ["PATH", "LANG", "LC_ALL"]) if (source[key]) result[key] = source[key];
  return result;
}

const codexShellEnvironmentKey = "shell_environment_policy";

function codexAcpSessionConfig(raw: string | undefined, isolated: boolean): string {
  let parsed: unknown = {};
  if (raw !== undefined && raw.trim() !== "") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw runtimeInstanceError("invalid_runtime_launch", "CODEX_CONFIG must be a JSON object.");
    }
  }
  if (!isRuntimeInstanceRecord(parsed))
    throw runtimeInstanceError("invalid_runtime_launch", "CODEX_CONFIG must be a JSON object.");
  return JSON.stringify({
    ...parsed,
    ...(isolated ? { cli_auth_credentials_store: "file" } : {}),
    [codexShellEnvironmentKey]: codexToolEnvironmentConfig,
  });
}

export function launchEnvironment(
  config: RuntimeInstanceConfig,
  baseEnv: NodeJS.ProcessEnv,
  permissionMode?: RuntimePermissionMode,
  commandInterceptions: CommandInterceptions = [],
): NodeJS.ProcessEnv {
  const declaration = runtimeKindForId(config.kindId);
  return {
    ...baseEnv,
    ...(permissionMode ? declaration.launch.permissionEnvironment?.[permissionMode] : undefined),
    ...(config.kindId === "claude" && commandInterceptions.length ? { CLAUDE_CODE_SIMPLE: undefined } : {}),
    ...(config.kindId === "codex-acp"
      ? { CODEX_CONFIG: codexAcpSessionConfig(baseEnv.CODEX_CONFIG, config.isolationState === "enforced") }
      : {}),
  };
}

export const maxLinkedWorktreeGitMetadataBytes = 4096;

const ignorableGitMetadataErrorCodes = new Set([
  "EACCES",
  "EINVAL",
  "EISDIR",
  "ELOOP",
  "ENAMETOOLONG",
  "ENOENT",
  "ENOTDIR",
  "ENXIO",
  "EPERM",
]);

export interface LinkedWorktreeGitMetadataFs {
  readonly lstatSync: (
    path: string,
    options: { readonly throwIfNoEntry: false },
  ) =>
    | {
        readonly isDirectory: () => boolean;
        readonly isFile: () => boolean;
        readonly isSymbolicLink: () => boolean;
        readonly size: number;
      }
    | undefined;
  readonly statSync: (
    path: string,
    options: { readonly throwIfNoEntry: false },
  ) => { readonly isDirectory: () => boolean } | undefined;
  readonly readFileSync: (path: string) => Uint8Array;
  readonly realpathSync: (path: string) => string;
}

const defaultGitMetadataFs: LinkedWorktreeGitMetadataFs = {
  lstatSync,
  statSync,
  readFileSync,
  realpathSync: realpathSync.native,
};

function isIgnorableGitMetadataError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string" &&
    ignorableGitMetadataErrorCodes.has((error as { readonly code: string }).code)
  );
}

function boundedRegularFileSize(filePath: string, fs: LinkedWorktreeGitMetadataFs): number | null {
  if (!filePath || filePath.includes("\0")) return null;
  const entry = fs.lstatSync(filePath, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isFile() || entry.isSymbolicLink()) return null;
  return entry.size > 0 && entry.size <= maxLinkedWorktreeGitMetadataBytes ? entry.size : null;
}

function readBoundedSingleLineFile(filePath: string, fs: LinkedWorktreeGitMetadataFs): string | null {
  if (boundedRegularFileSize(filePath, fs) === null) return null;
  const bytes = Buffer.from(fs.readFileSync(filePath));
  if (
    bytes.byteLength === 0 ||
    bytes.byteLength > maxLinkedWorktreeGitMetadataBytes ||
    bytes.includes(0) ||
    !isUtf8(bytes)
  )
    return null;
  const line = bytes
    .toString("utf8")
    .replace(/\r?\n$/u, "")
    .trim();
  if (!line || /[\r\n\0]/u.test(line)) return null;
  return line;
}

function realDirectoryPath(directoryPath: string, fs: LinkedWorktreeGitMetadataFs): string | null {
  if (!directoryPath || directoryPath.includes("\0")) return null;
  if (fs.statSync(directoryPath, { throwIfNoEntry: false })?.isDirectory() !== true) return null;
  const resolved = fs.realpathSync(directoryPath);
  return fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory() === true ? resolved : null;
}

function realNonSymlinkDirectoryPath(directoryPath: string, fs: LinkedWorktreeGitMetadataFs): string | null {
  if (!directoryPath || directoryPath.includes("\0")) return null;
  const normalized = path.resolve(directoryPath),
    entry = fs.lstatSync(normalized, { throwIfNoEntry: false });
  if (entry === undefined || !entry.isDirectory() || entry.isSymbolicLink()) return null;
  const resolved = fs.realpathSync(normalized);
  return fs.statSync(resolved, { throwIfNoEntry: false })?.isDirectory() === true ? resolved : null;
}

function realBoundedRegularFilePath(filePath: string, fs: LinkedWorktreeGitMetadataFs): string | null {
  if (boundedRegularFileSize(filePath, fs) === null) return null;
  const resolved = fs.realpathSync(filePath);
  return boundedRegularFileSize(resolved, fs) === null ? null : resolved;
}

function isPathWithinOrEqual(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isGitCommonDirectory(directoryPath: string, fs: LinkedWorktreeGitMetadataFs): boolean {
  return (
    path.basename(directoryPath) === ".git" &&
    fs.lstatSync(path.join(directoryPath, ".git"), { throwIfNoEntry: false }) === undefined &&
    boundedRegularFileSize(path.join(directoryPath, "HEAD"), fs) !== null &&
    realNonSymlinkDirectoryPath(path.join(directoryPath, "objects"), fs) !== null &&
    realNonSymlinkDirectoryPath(path.join(directoryPath, "refs"), fs) !== null &&
    realNonSymlinkDirectoryPath(path.join(directoryPath, "worktrees"), fs) !== null
  );
}

function findEnclosingGitRoot(realCwd: string, fs: LinkedWorktreeGitMetadataFs): string | null {
  let cursor = path.dirname(realCwd);
  for (;;) {
    if (fs.lstatSync(path.join(cursor, ".git"), { throwIfNoEntry: false }) !== undefined) return cursor;
    const parent = path.dirname(cursor);
    if (parent === cursor) return null;
    cursor = parent;
  }
}

function uniqueNonEmptyPaths(paths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  for (const candidate of paths) {
    const trimmed = candidate.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * Resolve external metadata directories (`gitdir` and `commondir`) for a linked Git worktree
 * so Codex `workspace-write` can write `index.lock`, refs, and objects without opening the
 * canonical parent worktree. When `repoRoot` is supplied, `commondir` must match `<repoRoot>/.git`
 * and `gitdir` must live directly under `<commondir>/worktrees/<name>`; without `repoRoot`,
 * `commondir` must still be a pure `.git` directory whose parent repository directly encloses `cwd`.
 * Non-git directories, single-checkout `.git/` directories inside `cwd`, oversized (> 4096B) or
 * unreadable metadata files, and out-of-bounds pointers fail closed to `[]`.
 */
export function resolveLinkedWorktreeGitRoots(
  cwd: string,
  repoRoot?: string,
  fs: LinkedWorktreeGitMetadataFs = defaultGitMetadataFs,
): readonly string[] {
  if (!cwd || cwd.includes("\0") || !path.isAbsolute(cwd)) return [];
  if (repoRoot !== undefined && (!repoRoot || repoRoot.includes("\0") || !path.isAbsolute(repoRoot))) return [];
  try {
    const realCwd = realDirectoryPath(cwd, fs);
    if (!realCwd) return [];
    let trustedCommonDir: string | null = null;
    if (repoRoot !== undefined) {
      const realRepoRoot = realDirectoryPath(repoRoot, fs);
      if (!realRepoRoot || realRepoRoot === realCwd) return [];
      trustedCommonDir = realNonSymlinkDirectoryPath(path.join(realRepoRoot, ".git"), fs);
      if (
        !trustedCommonDir ||
        path.dirname(trustedCommonDir) !== realRepoRoot ||
        !isGitCommonDirectory(trustedCommonDir, fs)
      )
        return [];
    }
    const realDotGit = realBoundedRegularFilePath(path.join(realCwd, ".git"), fs);
    if (!realDotGit || path.dirname(realDotGit) !== realCwd) return [];
    const dotGitLine = readBoundedSingleLineFile(realDotGit, fs);
    if (!dotGitLine) return [];
    const gitdirPointer = /^gitdir:\s*(.+)$/u.exec(dotGitLine)?.[1]?.trim();
    if (!gitdirPointer) return [];
    const realGitDir = realNonSymlinkDirectoryPath(path.resolve(realCwd, gitdirPointer), fs);
    if (!realGitDir || boundedRegularFileSize(path.join(realGitDir, "HEAD"), fs) === null) return [];
    const commonPointer = readBoundedSingleLineFile(path.join(realGitDir, "commondir"), fs);
    if (!commonPointer) return [];
    const realCommonDir = realNonSymlinkDirectoryPath(path.resolve(realGitDir, commonPointer), fs);
    if (!realCommonDir || !isGitCommonDirectory(realCommonDir, fs)) return [];
    if (trustedCommonDir !== null) {
      if (realCommonDir !== trustedCommonDir) return [];
    } else {
      const ownerRepoRoot = path.dirname(realCommonDir);
      if (
        ownerRepoRoot === realCommonDir ||
        realCwd === ownerRepoRoot ||
        findEnclosingGitRoot(realCwd, fs) !== ownerRepoRoot
      )
        return [];
    }
    if (isPathWithinOrEqual(realCommonDir, realCwd) || isPathWithinOrEqual(realGitDir, realCwd)) return [];
    // A real linked worktree's administrative directory always lives directly under
    // `<commondir>/worktrees/<name>` and records a `gitdir` backlink to `<cwd>/.git`.
    const realWorktreesDir = realNonSymlinkDirectoryPath(path.join(realCommonDir, "worktrees"), fs);
    if (!realWorktreesDir || path.dirname(realGitDir) !== realWorktreesDir) return [];
    const backlinkPointer = readBoundedSingleLineFile(path.join(realGitDir, "gitdir"), fs);
    if (!backlinkPointer) return [];
    const realBacklink = realBoundedRegularFilePath(path.resolve(realGitDir, backlinkPointer), fs);
    if (realBacklink !== realDotGit) return [];
    const roots: string[] = [];
    for (const candidate of [realGitDir, realCommonDir]) {
      if (!isPathWithinOrEqual(realCwd, candidate) && !roots.includes(candidate)) roots.push(candidate);
    }
    return roots;
  } catch (error) {
    if (!isIgnorableGitMetadataError(error)) throw error;
    return [];
  }
}

export function launchArgs(
  config: RuntimeInstanceConfig,
  model: string,
  prompt: string,
  providerSessionId?: string,
  effort: string | null = null,
  permissionMode: RuntimePermissionMode | undefined = undefined,
  fast = false,
  callbackRelayPath?: string,
  platform: NodeJS.Platform = process.platform,
  commandInterceptions: CommandInterceptions = [],
  commandInterceptionArgs: readonly string[] = [],
  mcpPolicy: RuntimeMcpPolicy | undefined = undefined,
  writableRoots: readonly string[] = [],
): string[] {
  // Never trust a literal caller: a persisted tier is re-validated here as well as on the
  // write path, so a hand-edited instance file cannot enable hosted search on a provider
  // that does not honor it.
  assertRuntimeWebSearchSupported(config);
  const effectiveMcpPolicy = resolveRuntimeMcpPolicy({
    kindId: config.kindId,
    dispatchMcpPolicy: mcpPolicy,
    instanceMcpPolicy: config.mcpPolicy,
  });
  if (
    config.kindId === "claude" &&
    permissionMode === "workspace-write" &&
    platform !== "darwin" &&
    platform !== "linux"
  )
    throw runtimeInstanceError(
      "claude_workspace_sandbox_unavailable",
      "Claude workspace-write requires its native Bash sandbox, available on macOS and Linux/WSL2. " +
        "Choose a supported execution host or a different runtime/permission mode; unsandboxed execution is not allowed.",
    );
  const declaration = runtimeKindForId(config.kindId),
    launch: RuntimeProviderDeclaration["launch"] = declaration.launch,
    callbackProfileParent =
      permissionMode === "workspace-write" ? ":workspace" : permissionMode === "read-only" ? ":read-only" : undefined,
    permission = permissionMode
      ? ((providerSessionId ? launch.resumePermissionArgs : undefined)?.[permissionMode] ??
        launch.permissionArgs[permissionMode])
      : [],
    codexWritableRoots =
      config.kindId === "codex" && permissionMode === "workspace-write" ? uniqueNonEmptyPaths(writableRoots) : [];
  if (commandInterceptions.length && declaration.capabilities.commandInterception !== "supported")
    throw runtimeInstanceError(
      "runtime_command_interception_unsupported",
      `${declaration.displayName} does not support HA command interception. Rules: ${commandInterceptions.map(({ id }) => id).join(", ")}. Select a supported runtime.`,
    );
  const commandIssues = commandInterceptionIssues(commandInterceptions);
  if (commandIssues.length) throw runtimeInstanceError("runtime_approved_command_invalid", commandIssues.join("; "));
  const approvedRules = commandInterceptions.filter(
    (rule): rule is Extract<CommandInterceptions[number], { readonly approvedCommand: string }> =>
      "approvedCommand" in rule,
  );
  if (approvedRules.length && config.kindId !== "claude")
    throw runtimeInstanceError(
      "runtime_approved_command_unsupported",
      "Reviewed exact commands are only supported by Claude Code permissions.allow.",
    );
  if (approvedRules.length && permissionMode !== "workspace-write")
    throw runtimeInstanceError(
      "runtime_approved_command_permission_mode",
      "Reviewed exact commands require Claude workspace-write; select that mode or remove the command declaration.",
    );
  if (commandInterceptions.length && commandInterceptionNeedsFiles(config.kindId) && !commandInterceptionArgs.length)
    throw runtimeInstanceError(
      "runtime_command_interception_unprepared",
      "Native command interception requires the runtime instance launch preparer.",
    );
  const patternRules = commandInterceptions.filter(
      (rule): rule is Extract<CommandInterceptions[number], { readonly pattern: string }> => "pattern" in rule,
    ),
    hook = patternRules.length ? commandInterceptionHook(patternRules) : null,
    approvedCommands = approvedRules.map((rule) => `Bash(${rule.approvedCommand})`),
    hookSettings = hook
      ? { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hook }] }] }
      : undefined;
  const args = launch.argumentTemplate.flatMap((token) => {
    if (token === "$claude-settings")
      return [
        JSON.stringify({
          attribution: { commit: "", pr: "", sessionUrl: false },
          ...(approvedCommands.length ? { permissions: { allow: approvedCommands } } : {}),
          ...(hookSettings ? { hooks: hookSettings, disableAllHooks: false } : {}),
          ...(permissionMode === "workspace-write"
            ? {
                sandbox: {
                  ...claudeWorkspaceWriteSandbox,
                  ...(callbackRelayPath
                    ? {
                        network: {
                          ...claudeWorkspaceWriteSandbox.network,
                          allowUnixSockets: [callbackRelayPath],
                        },
                      }
                    : {}),
                },
              }
            : {}),
        }),
      ];
    if (token === "$model") return [model];
    if (token === "$prompt") return [prompt];
    // A CLI --sandbox override selects Codex's legacy policy and discards named profiles.
    // The callback profile replaces that block for both fresh and resumed launches.
    if (token === "$permission") {
      if (config.kindId === "codex" && callbackRelayPath && callbackProfileParent) return [];
      return codexWritableRoots.length > 0
        ? [
            ...permission,
            "--config",
            `sandbox_workspace_write.writable_roots=[${codexWritableRoots.map(tomlString).join(",")}]`,
          ]
        : permission;
    }
    if (token === "$callback-relay-socket")
      // Exact socket rules require Codex's managed proxy; an empty domain allowlist
      // keeps ordinary network access denied rather than enabling direct networking.
      return config.kindId === "codex" && callbackRelayPath && callbackProfileParent
        ? [
            "--config",
            'default_permissions="harness-callback-relay"',
            "--config",
            `permissions.harness-callback-relay.extends=${tomlString(callbackProfileParent)}`,
            ...(permissionMode === "workspace-write"
              ? [
                  "--config",
                  `permissions.harness-callback-relay.filesystem={${[
                    '":slash_tmp"="deny"',
                    '":tmpdir"="deny"',
                    ...codexWritableRoots.map((root) => `${tomlString(root)}="write"`),
                  ].join(",")}}`,
                ]
              : []),
            "--config",
            "features.network_proxy=true",
            "--config",
            `permissions.harness-callback-relay.network={enabled=true,domains={},unix_sockets={${tomlString(callbackRelayPath)}="allow"}}`,
          ]
        : [];
    if (token === "$resume-command" || token === "$resume") {
      // A resume token with no flag to expand would silently launch a fresh session on a
      // resume request, so the mismatch fails the launch instead.
      if (launch.resumeFlag === undefined)
        throw new Error(`${declaration.kindId} argumentTemplate carries ${token} without a launch.resumeFlag`);
      if (token === "$resume-command") return providerSessionId ? [launch.resumeFlag] : [];
      return providerSessionId ? [launch.resumeFlag, providerSessionId] : [];
    }
    if (token === "$session") return providerSessionId ? [providerSessionId] : [];
    if (token === "$effort-flag") return effort ? ["--effort", effort === "minimal" ? "low" : effort] : [];
    if (token === "$effort-config") return effort ? ["--config", `model_reasoning_effort=${tomlString(effort)}`] : [];
    // Claude --bare disables settings hooks, including --settings. Keep it only on
    // launches with no project interception rather than silently dropping the policy.
    if (token === "$api-auth")
      return config.auth.mode === "api-key" && !hook && !approvedCommands.length ? (launch.apiKeyArgs ?? []) : [];
    if (token === "$fast") return fast ? (launch.fastArgs ?? []) : [];
    if (token === "$mcp-policy") {
      if (config.kindId === "codex")
        return effectiveMcpPolicy === "disabled" && config.isolationState === "operator-environment"
          ? ["--ignore-user-config"]
          : [];
      if (config.kindId === "claude") return effectiveMcpPolicy === "disabled" ? ["--strict-mcp-config"] : [];
      return [];
    }
    if (token === "$web-search") {
      const mode = runtimeWebSearchForConfig(config);
      // Always emit the effective tier, including `disabled`: an inherited Codex config
      // that says live must not be able to upgrade a dispatch implicitly.
      return mode === null ? [] : ["--config", `web_search=${tomlString(mode)}`];
    }
    return [token];
  });
  if (config.kindId === "codex" && hook)
    args.push(
      "--config",
      "features.hooks=true",
      "--config",
      `hooks.PreToolUse=[{matcher="Bash",hooks=[{type="command",command=${tomlString(hook)}}]}]`,
      "--dangerously-bypass-hook-trust",
    );
  if (config.kindId === "codebuddy" && hookSettings)
    args.push("--settings", JSON.stringify({ hooks: hookSettings, disableAllHooks: false }));
  args.unshift(...commandInterceptionArgs);
  return args;
}

export async function providerSubscriptionReadiness(
  input: {
    readonly installation: RuntimeInstallationWitness;
    readonly env: NodeJS.ProcessEnv;
    readonly isolationState: RuntimeIsolationState;
  },
  platform: NodeJS.Platform,
): Promise<RuntimeAuthReadiness> {
  const hint =
    input.isolationState === "operator-environment"
      ? "Provider subscription authentication is unavailable in the operator environment."
      : "Provider subscription authentication is unavailable in this instance state root.";
  try {
    const declaration = runtimeKindForId(input.installation.kindId),
      probe = declaration.auth.subscriptionProbe;
    if (typeof probe === "object" && "kind" in probe) {
      const home = input.env.HOME ?? input.env.USERPROFILE;
      if (!home)
        return unavailable("runtime_auth_probe_failed", "Provider authentication probe could not determine readiness.");
      const directory = providerConfigDirectory(home, input.installation.kindId);
      if (probe.kind === "json-credential-map") {
        const authFile = declaration.executable.authFile;
        if (!authFile) return unavailable("runtime_auth_probe_failed", "No credential file is declared.");
        const dataHome = input.env[probe.directoryEnvironment],
          file = path.join(dataHome ? path.join(dataHome, probe.directoryName) : directory, authFile),
          content = input.env[probe.contentEnvironment];
        if (!content && !existsSync(file)) return unavailable("runtime_subscription_required", hint);
        const credentials: unknown = JSON.parse(content || readFileSync(file, "utf8"));
        if (!isPlainRecord(credentials))
          return unavailable("runtime_auth_probe_failed", "The credential map could not be read.");
        // Validate the native provider-map format at its file-reading boundary.
        const present = Object.values(credentials).some(
          (value) =>
            isPlainRecord(value) &&
            ((value.type === "api" && isNonEmptyString(value.key)) ||
              (value.type === "wellknown" && isNonEmptyString(value.key) && isNonEmptyString(value.token)) ||
              (value.type === "oauth" &&
                typeof value.expires === "number" &&
                value.expires >= 0 &&
                (isNonEmptyString(value.refresh) || (isNonEmptyString(value.access) && value.expires > Date.now())))),
        );
        return present ? available("metadata") : unavailable("runtime_subscription_required", hint);
      }
      if (probe.kind === "file-key") {
        const authFile = declaration.executable.authFile,
          key = "acpCredentialKey" in declaration.auth ? declaration.auth.acpCredentialKey : undefined;
        if (!authFile || !key)
          return unavailable(
            "runtime_auth_probe_failed",
            "Provider authentication probe could not determine readiness.",
          );
        const file = path.join(directory, authFile);
        // Existence of the file plus a non-empty declared key is the whole check;
        // the secret value itself is never read out, logged, or forwarded.
        return existsSync(file) &&
          new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*"[^"]+"`, "mu").test(readFileSync(file, "utf8"))
          ? available()
          : unavailable("runtime_subscription_required", hint);
      }
      return jsonAuthStateReadiness(path.join(directory, probe.file), probe, hint);
    }
    await runExecutable(platform, input.installation.executablePath, probe, {
      env: input.env,
      timeoutMs: declaration.auth.subscriptionProbeTimeoutMs,
      captureOutput: false,
    });
    return available();
  } catch (error) {
    consumeKnownError(error);
    // A probe the harness itself terminated (deadline or cancellation signal) never delivered
    // the provider's verdict: an exit during forced shutdown is an infrastructure failure, not
    // an authentication verdict. Only a run the provider completed and rejected itself counts.
    const terminated =
      typeof error === "object" &&
      error !== null &&
      ((error as { readonly killed?: unknown }).killed === true ||
        (error as { readonly signal?: unknown }).signal != null);
    return !terminated &&
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      Number.isInteger((error as { status: unknown }).status)
      ? unavailable("runtime_subscription_required", hint)
      : unavailable(
          "runtime_auth_probe_failed",
          terminated
            ? "Provider authentication probe was terminated before it could report readiness."
            : "Provider authentication probe could not determine readiness.",
        );
  }
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

type JsonAuthStateProbe = Extract<
  RuntimeProviderDeclaration["auth"]["subscriptionProbe"],
  { readonly kind: "json-auth-state" }
>;

/**
 * Read the provider's own login-state document. A CLI that exits 0 on `--version`
 * whether or not anyone is signed in cannot answer readiness; its auth-state file
 * records both the status and the expiry, so a stale login is distinguishable from
 * a fresh one and from no login at all. Missing file = never signed in; malformed
 * file = the probe could not determine anything (not a credential verdict).
 */
function jsonAuthStateReadiness(file: string, probe: JsonAuthStateProbe, hint: string): RuntimeAuthReadiness {
  // A missing document is the one state this can decide locally: nobody ever signed in.
  // A read or parse failure (permissions, a half-written file) is left to throw into the
  // caller's existing boundary, which reports it as "the probe could not determine
  // readiness" — a read failure must not masquerade as a credential verdict.
  if (!existsSync(file)) return unavailable("runtime_subscription_required", hint);
  const state: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof state !== "object" || state === null || Array.isArray(state))
    return unavailable("runtime_auth_probe_failed", "Provider authentication state is not an object.");
  const record = state as Record<string, unknown>,
    expiresAt = record[probe.expiresAtField];
  if (record[probe.statusField] !== probe.readyStatus) return unavailable("runtime_subscription_required", hint);
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt))
    return unavailable("runtime_auth_probe_failed", "Provider authentication state has no expiry.");
  return expiresAt <= Date.now()
    ? unavailable(
        "runtime_subscription_expired",
        "Provider subscription sign-in has expired; run the instance login to sign in again.",
      )
    : available();
}

export const credentialUnavailableHint = "The configured runtime API credential is unavailable.";

export function credentialHint(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "runtime_credential_unavailable" &&
    error instanceof Error &&
    error.message
    ? error.message
    : credentialUnavailableHint;
}

export function secureRuntimeBaseUrl(value: unknown, options: { readonly allowInsecureHttp?: boolean } = {}): string {
  const text = requiredRuntimeInstanceText(value, "baseUrl");
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    throw runtimeInstanceError("invalid_base_url", "baseUrl must be an absolute HTTPS URL.");
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && ["127.0.0.1", "::1", "localhost"].includes(parsed.hostname)) &&
      !(parsed.protocol === "http:" && options.allowInsecureHttp === true && isPrivateIpv4(parsed.hostname)))
  )
    throw runtimeInstanceError(
      "invalid_base_url",
      [
        "baseUrl must use HTTPS or loopback HTTP; private HTTP requires explicit ",
        "allowInsecureHttp, and credentials, query, and fragments are forbidden.",
      ].join(""),
    );
  return parsed.toString();
}

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = octets;
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}
