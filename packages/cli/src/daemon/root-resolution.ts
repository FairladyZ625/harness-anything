import path from "node:path";
import type { CommandFailureReceipt, CommandReceipt } from "../cli/receipt.ts";
import type { ParsedCommand } from "../cli/types.ts";
import { resolveCanonicalHarnessRootResolution } from "@harness-anything/daemon";
import { createHarnessRuntimeContext } from "@harness-anything/kernel";

export interface CliRootResolution {
  readonly requestedRoot: string;
  readonly root: string;
  readonly source: "explicit-override" | "local-cwd" | "git-common-dir" | "git-common-dir-unresolved";
  readonly isHarnessRepository: boolean;
  readonly linkedWorktree?: {
    readonly canonicalRoot: string;
    readonly isHarnessRepository: boolean;
  };
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
  const canonical = resolveCanonicalHarnessRootResolution(createHarnessRuntimeContext(requestedRoot, command.layoutOverrides));
  const root = canonical.root;
  const source = command.rootResolutionSource === "explicit-override"
    ? "explicit-override"
    : canonical.source === "git-common-dir-unresolved"
      ? "git-common-dir-unresolved"
      : path.resolve(root) === requestedRoot ? "local-cwd" : "git-common-dir";
  return {
    requestedRoot,
    root,
    source,
    isHarnessRepository: canonical.isHarnessRepository,
    ...(canonical.source === "git-common-dir" || canonical.source === "git-common-dir-unresolved"
      ? {
          linkedWorktree: {
            canonicalRoot: canonical.canonicalRoot,
            isHarnessRepository: canonical.source === "git-common-dir"
          }
        }
      : {})
  };
}

export function commandForRootResolution(command: ParsedCommand, resolution: CliRootResolution): ParsedCommand {
  return path.resolve(command.rootDir) === path.resolve(resolution.root)
    ? command
    : { ...command, rootDir: resolution.root };
}

export function rootResolutionUnavailableHint(resolution: CliRootResolution): string {
  if (resolution.linkedWorktree) {
    const canonicalRoot = resolution.linkedWorktree.canonicalRoot;
    const root = quoteRootArgument(canonicalRoot);
    const location = `Detected current directory ${JSON.stringify(resolution.requestedRoot)} inside a linked Git worktree; its canonical repository is ${JSON.stringify(canonicalRoot)}.`;
    if (!resolution.linkedWorktree.isHarnessRepository) {
      return `${location} The canonical repository is not an initialized harness repository because harness/harness.yaml was not found. Initialize the canonical repository with \`ha --root ${root} init\`, then register it with \`ha daemon repo register --root ${root}\`. To create a task there after initialization, run \`ha --root ${root} task create --title "<title>"\`.`;
    }
    return `${location} The canonical repository is an initialized harness repository, but it is not registered. Register the canonical repository with \`ha daemon repo register --root ${root}\`. To create a task there, run \`ha --root ${root} task create --title "<title>"\`.`;
  }
  const root = quoteRootArgument(resolution.root);
  const origin = resolution.source === "explicit-override" ? "The explicit --root override" : "The current directory";
  if (!resolution.isHarnessRepository) {
    return `${origin} ${JSON.stringify(resolution.requestedRoot)} is not an initialized harness repository because harness/harness.yaml was not found. Initialize it with \`ha --root ${root} init\`, then register it with \`ha daemon repo register --root ${root}\`. To create a task there after initialization, run \`ha --root ${root} task create --title "<title>"\`.`;
  }
  return `${origin} ${JSON.stringify(resolution.requestedRoot)} resolves to an initialized harness repository, but it is not registered. Register it with \`ha daemon repo register --root ${root}\`. To create a task there, run \`ha --root ${root} task create --title "<title>"\`.`;
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
