import path from "node:path";
import type { CommandFailureReceipt, CommandReceipt } from "../cli/receipt.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { resolveCanonicalHarnessRoot } from "@harness-anything/daemon";
import { createHarnessRuntimeContext } from "@harness-anything/kernel";

export interface CliRootResolution {
  readonly requestedRoot: string;
  readonly root: string;
  readonly source: "explicit-override" | "local-cwd" | "git-common-dir";
}

export class CliRootResolutionError extends Error {
  readonly resolution: CliRootResolution;

  constructor(resolution: CliRootResolution, cause: unknown) {
    super("could not resolve a registered harness repo root", { cause });
    this.name = "CliRootResolutionError";
    this.resolution = resolution;
  }
}

export function resolveCommandRoot(command: ParsedCommand): CliRootResolution {
  const requestedRoot = path.resolve(command.rootDir);
  const root = resolveCanonicalHarnessRoot(createHarnessRuntimeContext(requestedRoot, command.layoutOverrides));
  const source = command.rootResolutionSource === "explicit-override"
    ? "explicit-override"
    : path.resolve(root) === requestedRoot ? "local-cwd" : "git-common-dir";
  return { requestedRoot, root, source };
}

export function commandForRootResolution(command: ParsedCommand, resolution: CliRootResolution): ParsedCommand {
  return path.resolve(command.rootDir) === path.resolve(resolution.root)
    ? command
    : { ...command, rootDir: resolution.root };
}

export function rootResolutionUnavailableHint(resolution: CliRootResolution): string {
  if (resolution.source === "git-common-dir") {
    return `Could not resolve a registered harness repo root: git common-dir candidate ${JSON.stringify(resolution.root)} is not registered. Pass --root <canonical-root>, or register that candidate with 'ha daemon repo register --repo-id <id> --root ${quoteRootArgument(resolution.root)}'.`;
  }
  const origin = resolution.source === "explicit-override" ? "the explicit --root override" : "the current directory";
  return `Could not resolve a registered harness repo root from ${origin} ${JSON.stringify(resolution.requestedRoot)}. Pass --root <canonical-root>, or register it with 'ha daemon repo register --repo-id <id> --root ${quoteRootArgument(resolution.requestedRoot)}'.`;
}

export function withRootResolution<T extends CommandReceipt | CommandFailureReceipt>(receipt: T, resolution: CliRootResolution): T {
  return {
    ...receipt,
    details: {
      ...(receipt.details ?? {}),
      rootResolution: { root: resolution.root, source: resolution.source }
    }
  };
}

function quoteRootArgument(value: string): string {
  return /^[A-Za-z0-9_./:@%+=,-]+$/u.test(value) ? value : `'${value.replaceAll("'", `'"'"'`)}'`;
}
