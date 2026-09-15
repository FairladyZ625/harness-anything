import { safePath } from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import { cliFailure } from "../cli-meta.ts";
import { cliDispatchError } from "../cli-render.ts";
import {
  daemonAutostartFailureCode,
  daemonResponseTimeoutCode,
  daemonTargetFailureCode,
  cliEntryFailureCode,
  runCommandThroughDaemon,
} from "../daemon/client.ts";
import { daemonBuildDrift, type DoctorCheck } from "../daemon/doctor-build-drift.ts";
import { globalOption } from "./thin-command-flags.ts";
import { daemonRequestTimer } from "./timing.ts";
import type { ThinCommand } from "./thin-command-types.ts";

/**
 * `ha doctor` (health mode): the daemon computes five repo checks; this module merges the
 * sixth — loaded/disk build drift — from `daemon.status`, renders, and maps any `fail`
 * check to exit 1. Warnings and indeterminate checks never fail the command.
 */
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
  const checks = mergeBuildDrift(await daemonBuildDrift(command), receipt.checks),
    scope =
      typeof receipt.scope === "object" && receipt.scope !== null ? (receipt.scope as Record<string, unknown>) : {},
    failed = checks.some((check) => check.status === "fail");
  if (json) {
    console.log(JSON.stringify({ ...receipt, checks, ok: receipt.outcome === "applied" && !failed }));
    return failed ? 1 : 0;
  }
  const lines = [
    `doctor health: scope repoId=${String(scope.repoId ?? command.repoId ?? "?")} ` +
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

function mergeBuildDrift(check: DoctorCheck | null, value: unknown): readonly DoctorCheck[] {
  const checks = (Array.isArray(value) ? value : []).filter(isDoctorCheck);
  if (check === null) return checks;
  return checks.some((entry) => entry.id === check.id)
    ? checks.map((entry) => (entry.id === check.id ? check : entry))
    : [...checks, check];
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
