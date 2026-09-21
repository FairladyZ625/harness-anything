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
  if (receipt.outcome !== "applied" || receipt.ok === false) {
    emit(receipt, json);
    return 1;
  }
  const checks = (Array.isArray(receipt.checks) ? receipt.checks : []).filter(isDoctorCheck),
    scope =
      typeof receipt.scope === "object" && receipt.scope !== null ? (receipt.scope as Record<string, unknown>) : {},
    failed = checks.some((check) => check.status === "fail");
  if (json) {
    console.log(JSON.stringify({ ...receipt, checks, ok: receipt.outcome === "applied" && !failed }));
    return failed ? 1 : 0;
  }
  const lines = [
    `doctor health: scope repoId=${String(scope.repoId ?? "?")} ` +
      `product origin/main tip=${String(scope.productOriginMainTip ?? "none")} ` +
      `ledger origin/main tip=${String(scope.ledgerOriginMainTip ?? "none")}`,
    `${String(scope.note ?? "")}`,
    ...checks.map(
      (check) => `  [${check.status}] ${check.id} (${check.count}) — ${check.summary}\n    next: ${check.next}`,
    ),
  ];
  console.log(lines.join("\n"));
  return failed ? 1 : 0;
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
