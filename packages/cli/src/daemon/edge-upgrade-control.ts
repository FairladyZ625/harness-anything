import path from "node:path";
import {
  runEdgeUpgrade,
  type EdgeUpgradeOptions,
  type EdgeUpgradeReceipt,
} from "@harness-anything/daemon/internal/client/edge-upgrade";
import { firstCliCommandIndex } from "../cli/command-index.ts";
import { daemonFailure } from "./control-support.ts";

export interface ParsedEdgeUpgradeArgs {
  readonly toRef?: string;
  readonly offline: boolean;
  readonly rollback: boolean;
  readonly installRoot?: string;
  readonly rootDir?: string;
  readonly repoId?: string;
  readonly userRoot?: string;
  readonly daemonId?: string;
  readonly json: boolean;
}

export type ParseEdgeUpgradeResult =
  | { readonly ok: true; readonly args: ParsedEdgeUpgradeArgs }
  | { readonly ok: false; readonly code: string; readonly hint: string };

function takesFlagValue(token: string): boolean {
  switch (token) {
    case "--to":
    case "--install-root":
    case "--root":
    case "--repo":
    case "--user-root":
    case "--daemon-id":
      return true;
    default:
      return false;
  }
}

export function parseEdgeUpgradeArgs(argv: readonly string[]): ParseEdgeUpgradeResult {
  const at = firstCliCommandIndex(argv);
  const leading = at < 0 ? [] : argv.slice(0, at);
  const trailing = at < 0 ? argv : argv.slice(at + 2);
  const tokens = [...leading, ...trailing];
  const values = new Map<string, string>();
  let offline = false;
  let rollback = false;
  let json = false;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token === "--offline" || token === "--no-pull") {
      offline = true;
      continue;
    }
    if (token === "--rollback") {
      rollback = true;
      continue;
    }
    if (token === "--json") {
      json = true;
      continue;
    }
    if (takesFlagValue(token)) {
      const value = tokens[index + 1];
      if (!value || value.startsWith("--")) {
        return {
          ok: false,
          code: "missing_field",
          hint: `Flag ${token} requires a value. Use ha edge upgrade --help.`,
        };
      }
      if (values.has(token)) {
        return {
          ok: false,
          code: "duplicate_field",
          hint: `Flag ${token} may only be specified once.`,
        };
      }
      values.set(token, value);
      index += 1;
      continue;
    }
    return {
      ok: false,
      code: token.startsWith("-") ? "unknown_field" : "invalid_field",
      hint: `Unexpected argument ${token} for ha edge upgrade. Use ha edge upgrade --help.`,
    };
  }

  if (rollback && values.has("--to")) {
    return {
      ok: false,
      code: "invalid_field",
      hint: "Cannot combine --rollback with --to <ref>; choose one.",
    };
  }

  return {
    ok: true,
    args: {
      ...(values.has("--to") ? { toRef: values.get("--to")! } : {}),
      offline,
      rollback,
      ...(values.has("--install-root") ? { installRoot: path.resolve(values.get("--install-root")!) } : {}),
      ...(values.has("--root") ? { rootDir: path.resolve(values.get("--root")!) } : {}),
      ...(values.has("--repo") ? { repoId: values.get("--repo")! } : {}),
      ...(values.has("--user-root") ? { userRoot: path.resolve(values.get("--user-root")!) } : {}),
      ...(values.has("--daemon-id") ? { daemonId: values.get("--daemon-id")! } : {}),
      json,
    },
  };
}

export function renderEdgeUpgradeReceipt(receipt: EdgeUpgradeReceipt): string {
  const fromShort = receipt.fromCommit ? receipt.fromCommit.slice(0, 12) : "unknown";
  const toShort = receipt.toCommit ? receipt.toCommit.slice(0, 12) : "none";
  const lines: string[] = [`edge-upgrade: ${receipt.outcome} (${fromShort} -> ${toShort})`];
  if (receipt.installRoot) lines.push(`  installRoot: ${receipt.installRoot}`);
  if (receipt.daemonBuildId) {
    lines.push(
      `  daemon: build=${receipt.daemonBuildId.slice(0, 12)} pid=${receipt.daemonPid ?? "unknown"} restarted=${receipt.daemonRestarted ? "yes" : "no"}`,
    );
  }
  if (receipt.syncedRepos.length > 0) {
    for (const repo of receipt.syncedRepos) {
      lines.push(
        `  sync: repo=${repo.repoId} revision=${repo.revision ?? "unknown"} lag=${repo.lagRevisions ?? 0} outcome=${repo.mirrorOutcome ?? "ok"}`,
      );
    }
  } else if (receipt.syncSkippedReason) {
    lines.push(`  sync: skipped (${receipt.syncSkippedReason})`);
  }
  if (receipt.rolledBack && !receipt.ok) {
    lines.push(`  rollback: restored ${fromShort} (syncOk=${receipt.rollbackSyncOk ? "yes" : "no"})`);
  }
  if (receipt.guiRestartRequired) {
    lines.push("  gui: quit any running GUI window and rerun `ha gui` to load the updated bundle.");
  }
  if (!receipt.ok && receipt.error) {
    lines.push(`  error: ${receipt.error.code}: ${receipt.error.hint}`);
  }
  if (receipt.nextAction) {
    lines.push(`  next: ${receipt.nextAction}`);
  }
  return lines.join("\n");
}

export async function runEdgeUpgradeControl(
  argv: readonly string[],
  userRoot: string,
  daemonId: string,
  invokingRoot: string,
  finish: (receipt: Record<string, unknown>, exitCode: number) => number,
  upgradeRunner: (options: EdgeUpgradeOptions) => Promise<EdgeUpgradeReceipt> = runEdgeUpgrade,
): Promise<number> {
  const parsed = parseEdgeUpgradeArgs(argv);
  if (!parsed.ok) {
    return finish(daemonFailure("edge-upgrade", parsed.code, parsed.hint), 2);
  }
  const args = parsed.args;
  const receipt = await upgradeRunner({
    ...(args.toRef ? { toRef: args.toRef } : {}),
    offline: args.offline,
    rollback: args.rollback,
    ...(args.installRoot ? { installRoot: args.installRoot } : {}),
    rootDir: args.rootDir ?? invokingRoot,
    ...(args.repoId ? { repoId: args.repoId } : {}),
    userRoot: args.userRoot ?? userRoot,
    daemonId: args.daemonId ?? daemonId,
    ...(args.json
      ? {}
      : {
          onProgress: (progress) => {
            console.error(`[edge-upgrade] ${progress.stage}: ${progress.message}`);
          },
        }),
  });
  if (args.json) {
    return finish(receipt as unknown as Record<string, unknown>, receipt.ok ? 0 : 1);
  }
  const rendered = renderEdgeUpgradeReceipt(receipt);
  if (receipt.ok) console.log(rendered);
  else console.error(rendered);
  return receipt.ok ? 0 : 1;
}

export async function dispatchClientLocalControl(
  argv: readonly string[],
  at: number,
  command: string | undefined,
  userRoot: string,
  daemonId: string,
  invokingRoot: string,
  renderReceipt: (receipt: Record<string, unknown>, json: boolean) => void,
  finish: (receipt: Record<string, unknown>, exitCode: number) => number,
): Promise<number | undefined> {
  if (argv[at] === "gui") {
    const { runGuiLaunch } = await import("../cli/gui-launch.ts");
    return runGuiLaunch(argv, {}, renderReceipt);
  }
  if (argv[at] === "fde") {
    const { runFdeLaunch } = await import("../cli/fde-launch.ts");
    return runFdeLaunch(argv, {}, renderReceipt);
  }
  if (argv[at] === "edge" && command === "upgrade") {
    return await runEdgeUpgradeControl(argv, userRoot, daemonId, invokingRoot, finish);
  }
  return undefined;
}
