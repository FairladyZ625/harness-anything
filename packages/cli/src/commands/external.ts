import type { CommandRunner } from "../cli/runner-registry.ts";
import { runMigrationCommand } from "./core/migration.ts";
import { runGithubIssuesCommand } from "./github-issues.ts";

export const runExternalCommand: CommandRunner = (context, command) =>
  command.action.kind === "external-snapshot" && command.action.provider === "multica"
    ? runMigrationCommand(context, command)
    : runGithubIssuesCommand(context, command);
