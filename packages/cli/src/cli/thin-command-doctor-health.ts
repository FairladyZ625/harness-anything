import { existsSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { safePath } from "@harness-anything/daemon/internal/protocol/daemon-protocol.contract";
import { cliFailure } from "../cli-meta.ts";
import { cliDispatchError } from "../cli-render.ts";
import {
  daemonAutostartFailureCode,
  daemonResponseTimeoutCode,
  daemonTargetFailureCode,
  cliEntryFailureCode,
  runCommandThroughDaemon,
} from "../daemon/client.ts";
import { globalOption } from "./thin-command-flags.ts";
import { daemonRequestTimer } from "./timing.ts";
import type { ThinCommand } from "./thin-command-types.ts";

interface DoctorCheck {
  readonly id: string;
  readonly status: "ok" | "warn" | "fail" | "indeterminate";
  readonly summary: string;
  readonly count: number;
  readonly next: string;
}

export interface CliSourceReport {
  readonly source: "app" | "npm" | "unknown";
  readonly current: string;
  readonly other: string | null;
}

/** Locate the entry the user actually invoked and the other installed candidate. */
export function detectCliSource(env: NodeJS.ProcessEnv = process.env, argv = process.argv): CliSourceReport {
  const current = argv[1] ? resolvePath(argv[1]) : "unknown";
  const candidates = (env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, process.platform === "win32" ? "ha.cmd" : "ha"))
    .filter((candidate) => existsSync(candidate))
    .map(resolvePath)
    .filter((candidate, index, all) => all.indexOf(candidate) === index)
    .filter(
      (candidate) =>
        !(
          /Application Support[\\/]Harness Anything[\\/]bin/u.test(candidate) &&
          /\.app[\\/]Contents[\\/]Resources/u.test(current)
        ),
    );
  const other = candidates.find((candidate) => candidate !== current) ?? null;
  const app = /\.app[\\/]Contents[\\/]Resources[\\/]|Application Support[\\/]Harness Anything[\\/]bin/u.test(current);
  return { source: app ? "app" : current === "unknown" ? "unknown" : "npm", current, other };
}

/** Render the center-local health observation and preserve failed receipts. */
export async function runDoctorHealth(
  argv: readonly string[],
  emit: (receipt: Record<string, unknown>, json: boolean) => void,
): Promise<number> {
  const json = argv.includes("--json"),
    rootDir = safePath(globalOption(argv, "--root") ?? process.cwd()),
    command: ThinCommand = {
      rootDir,
      repoId: globalOption(argv, "--repo"),
      json,
      method: "repo.task.read",
      action: { kind: "doctor-health" },
    };
  let receipt: Record<string, unknown>;
  try {
    receipt = (await runCommandThroughDaemon(
      command,
      (phase) => emit(phase, json),
      undefined,
      daemonRequestTimer,
    )) as Record<string, unknown>;
  } catch (error) {
    const failure = cliDispatchError({
      error,
      directCode: daemonAutostartFailureCode(error) ?? daemonTargetFailureCode(error) ?? cliEntryFailureCode(error),
      timeoutCode: daemonResponseTimeoutCode(error),
    });
    emit(cliFailure("doctor", failure.code, failure.hint), json);
    return 1;
  }
  return renderDoctorHealth(receipt, json, emit);
}

export function renderDoctorHealth(
  receipt: Record<string, unknown>,
  json: boolean,
  emit: (receipt: Record<string, unknown>, json: boolean) => void,
): number {
  const cli = detectCliSource();
  if (receipt.outcome !== "applied" || receipt.ok === false) {
    emit({ ...receipt, cli }, json);
    return 1;
  }
  const checks = (Array.isArray(receipt.checks) ? receipt.checks : []).filter(isDoctorCheck),
    scope =
      typeof receipt.scope === "object" && receipt.scope !== null ? (receipt.scope as Record<string, unknown>) : {},
    failed = checks.some((check) => check.status === "fail");
  if (json) {
    console.log(JSON.stringify({ ...receipt, checks, cli, ok: receipt.outcome === "applied" && !failed }));
    return failed ? 1 : 0;
  }
  const replica = Object.hasOwn(receipt, "currentCut") ? receipt : null;
  const lines = [
    `  cli: ${cli.source} (${cli.current})${cli.other ? `; another ha: ${cli.other}` : ""}`,
    `doctor health: scope repoId=${String(scope.repoId ?? "?")} ` +
      `product ${String(scope.productBaseRef ?? "default branch")} tip=${String(scope.productBaseTip ?? "none")} ` +
      `ledger ${String(scope.ledgerBaseRef ?? "default branch")} tip=${String(scope.ledgerBaseTip ?? "none")}`,
    `${String(scope.note ?? "")}`,
    ...(replica
      ? [
          "  replica:",
          ...[
            "currentCut",
            "centerCut",
            "lag",
            "lastSuccessAt",
            "failureCode",
            "rebuildCount",
            "schemaGeneration",
            "authorizationShapeDigest",
          ].map((key) => `    ${key}: ${JSON.stringify(replica[key] ?? null)}`),
        ]
      : []),
    ...checks.map(
      (check) => `  [${check.status}] ${check.id} (${check.count}) — ${check.summary}\n    next: ${check.next}`,
    ),
  ];
  console.log(lines.join("\n"));
  return failed ? 1 : 0;
}

function resolvePath(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value.replace(/^~(?=[\\/])/u, os.homedir()));
  }
}

function isDoctorCheck(value: unknown): value is DoctorCheck {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    ["ok", "warn", "fail", "indeterminate"].includes(String(row.status)) &&
    typeof row.summary === "string" &&
    typeof row.count === "number" &&
    typeof row.next === "string"
  );
}
