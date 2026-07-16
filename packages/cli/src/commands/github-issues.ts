import { Effect } from "effect";
import type {
  EngineError,
  TaskSnapshot
} from "../../../kernel/src/index.ts";
import {
  createGithubIssuesReadProvider,
  type GithubIssuesLifecycleEngine,
  type GithubIssuesProviderOptions
} from "../composition/adapter-registry.ts";
import type { CommandRunner } from "../cli/runner-registry.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";

export type GithubIssuesReadAction = Extract<ParsedCommand["action"], {
  readonly kind: "snapshot-github" | "list-github";
}>;

export interface GithubIssuesReadDependencies {
  readonly createProvider?: (options?: GithubIssuesProviderOptions) => GithubIssuesLifecycleEngine;
}

export const runGithubIssuesCommand: CommandRunner = (_context, command) => {
  return runGithubIssuesReadAction(command.action as GithubIssuesReadAction);
};

export function runGithubIssuesReadAction(
  action: GithubIssuesReadAction,
  dependencies: GithubIssuesReadDependencies = {}
): Effect.Effect<CliResult, EngineError> {
  const createProvider = dependencies.createProvider ?? createGithubIssuesReadProvider;
  if (action.kind === "snapshot-github") {
    return createProvider().snapshot({ engine: "github", ref: action.ref }).pipe(
      Effect.map((snapshot) => snapshotResult(snapshot))
    );
  }

  return createProvider({ defaultRepository: action.repository }).listTasks({
    engine: "github",
    repository: action.repository,
    rawStatus: action.rawStatus,
    label: action.label
  }).pipe(Effect.map((snapshots) => listResult(snapshots)));
}

function snapshotResult(snapshot: TaskSnapshot): CliResult {
  return {
    ok: true,
    command: "snapshot-github",
    report: {
      schema: "github-issue-snapshot-report/v1",
      snapshot
    }
  };
}

function listResult(snapshots: ReadonlyArray<TaskSnapshot>): CliResult {
  return {
    ok: true,
    command: "list-github",
    rows: snapshots.length,
    report: {
      schema: "github-issue-list-report/v1",
      snapshots
    }
  };
}
