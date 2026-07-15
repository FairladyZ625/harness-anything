import {
  readDaemonRegistry,
  registerDaemonRepo,
  unregisterDaemonRepo,
  type DaemonRegistryRepo
} from "../../../../kernel/src/index.ts";
import { daemonUserRootForRepo } from "../../../../daemon/src/index.ts";
import { cliError, CliErrorCode } from "../../cli/error-codes.ts";
import { readOption } from "../../cli/parse-options.ts";

export interface DaemonRepoCommandInput {
  readonly rootDir: string;
  readonly args: ReadonlyArray<string>;
  readonly json: boolean;
}

export function runDaemonRepoCommand(input: DaemonRepoCommandInput): number {
  const action = input.args[2] ?? "list";
  if (action === "--help" || action === "-h" || input.args.includes("--help") || input.args.includes("-h")) {
    console.log(renderDaemonRepoHelp());
    return 0;
  }
  const userRoot = readOption(input.args, "--user-root") ?? daemonUserRootForRepo(input.rootDir, process.env);
  const options = {
    userRoot,
    createConvenienceLinks: !input.args.includes("--no-link")
  };
  try {
    if (action === "register") {
      const canonicalRoot = readOption(input.args, "--canonical-root") ?? readOption(input.args, "--root") ?? input.rootDir;
      const result = registerDaemonRepo({
        ...options,
        canonicalRoot,
        repoId: readOption(input.args, "--repo-id"),
        displayName: readOption(input.args, "--display-name")
      });
      emitDaemonRepoResult("daemon-repo-register", {
        registryPath: result.registryPath,
        changed: result.changed,
        repo: repoPayload(result.repo),
        warnings: result.warnings
      }, input.json);
      return 0;
    }
    if (action === "list") {
      const registry = readDaemonRegistry(options);
      emitDaemonRepoResult("daemon-repo-list", {
        repos: registry.repos.map(repoPayload),
        count: registry.repos.length
      }, input.json);
      return 0;
    }
    if (action === "unregister") {
      const repoId = readOption(input.args, "--repo-id");
      if (!repoId || repoId.startsWith("--")) throw new Error("Use --repo-id <value>.");
      const result = unregisterDaemonRepo(repoId, options);
      emitDaemonRepoResult("daemon-repo-unregister", {
        registryPath: result.registryPath,
        changed: result.changed,
        repo: repoPayload(result.repo),
        warnings: result.warnings
      }, input.json);
      return 0;
    }
    emitDaemonRepoError(`unknown daemon repo command: ${action}`, input.json);
    return 2;
  } catch (error) {
    emitDaemonRepoError(error instanceof Error ? error.message : String(error), input.json);
    return 1;
  }
}

function renderDaemonRepoHelp(): string {
  return [
    "Usage: harness-anything daemon repo <register|list|unregister> [options]",
    "Alias: ha daemon repo <subcommand> [options]",
    "",
    "Commands:",
    "  register --root DIR [--repo-id ID]  Register an initialized canonical harness repo.",
    "  list                               List registered repos from the user daemon registry.",
    "  unregister --repo-id ID            Disable a registered repo.",
    "",
    "Options:",
    "  --user-root DIR                    Override the daemon user root for tests or isolated profiles.",
    "  --no-link                          Do not create or remove ~/.harness/repos convenience links."
  ].join("\n");
}

function repoPayload(repo: DaemonRegistryRepo): Record<string, unknown> {
  return {
    repoId: repo.repoId,
    canonicalRoot: repo.canonicalRoot,
    displayName: repo.displayName,
    state: repo.state,
    registeredAt: repo.registeredAt
  };
}

function emitDaemonRepoResult(command: string, result: Record<string, unknown>, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, schema: "daemon-command/v1", command, ...result }));
    return;
  }
  const parts = [`ok`, `command=${command}`];
  const repo = result.repo;
  if (repo !== null && typeof repo === "object" && !Array.isArray(repo)) {
    const repoRecord = repo as Record<string, unknown>;
    parts.push(`repoId=${JSON.stringify(repoRecord.repoId)}`);
    parts.push(`state=${JSON.stringify(repoRecord.state)}`);
  }
  if (typeof result.count === "number") parts.push(`count=${result.count}`);
  if (typeof result.registryPath === "string") parts.push(`registry=${result.registryPath}`);
  if (Array.isArray(result.warnings) && result.warnings.length > 0) {
    parts.push(`warnings=${JSON.stringify(result.warnings)}`);
  }
  console.log(parts.join(" "));
}

function emitDaemonRepoError(message: string, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: false, schema: "daemon-command/v1", command: "daemon-repo", error: cliError(CliErrorCode.JournalUnavailable, message) }));
    return;
  }
  console.error(`error code=${CliErrorCode.JournalUnavailable} hint=${message}`);
}
