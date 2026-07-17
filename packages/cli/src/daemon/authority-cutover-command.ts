import type { AuthorityCutoverControlService } from "../../../application/src/index.ts";
import { cliError, CliErrorCode } from "../cli/error-codes.ts";
import type { CliResult, ParsedCommand } from "../cli/types.ts";

type AuthorityCutoverAction = Extract<ParsedCommand["action"], { readonly kind: `authority-cutover-${string}` }>;

export function isAuthorityCutoverAction(action: ParsedCommand["action"]): action is AuthorityCutoverAction {
  return action.kind.startsWith("authority-cutover-");
}

export async function runAuthorityCutoverControlCommand(input: {
  readonly action: AuthorityCutoverAction;
  readonly control?: AuthorityCutoverControlService;
  readonly authenticated: boolean;
}): Promise<CliResult> {
  if (!input.authenticated) return cutoverCommandFailure(input.action.kind, CliErrorCode.AuthMissing, "Authority cutover controls require an authenticated daemon principal.");
  if (!input.control) return cutoverCommandFailure(input.action.kind, CliErrorCode.EngineNotEnabled, "Authority cutover controls require a production daemon started with --authority-manifest.");
  try {
    const report = await executeAuthorityCutoverAction(input.control, input.action);
    const rejected = isRejectedCutoverReport(report);
    return {
      ok: !rejected,
      command: input.action.kind,
      report,
      ...(rejected ? { error: cliError(CliErrorCode.WriteRejected, cutoverRejectionMessage(report)) } : {})
    };
  } catch (error) {
    return cutoverCommandFailure(input.action.kind, CliErrorCode.WriteRejected, error instanceof Error ? error.message : String(error));
  }
}

async function executeAuthorityCutoverAction(control: AuthorityCutoverControlService, action: AuthorityCutoverAction): Promise<unknown> {
  if (action.kind === "authority-cutover-status") return control.status();
  if (action.kind === "authority-cutover-drain") return control.drain({ classifications: action.classifications });
  if (action.kind === "authority-cutover-scan") return control.scan({ profileId: action.profileId });
  if (action.kind === "authority-cutover-confirm") return control.confirmEquality({ firstScanId: action.firstScanId, secondScanId: action.secondScanId });
  if (action.kind === "authority-cutover-boundary") return control.activateBoundary({
    boundaryId: action.boundaryId,
    equalityReceiptId: action.equalityReceiptId,
    expectedSelectedSchemaTupleDigest: action.expectedSelectedSchemaTupleDigest
  });
  if (action.kind === "authority-cutover-freeze") return control.freeze({
    reason: action.reason,
    expectedBoundaryReceiptDigest: action.expectedBoundaryReceiptDigest
  });
  return control.reEnable({
    boundaryId: action.boundaryId,
    expectedFreezeReceiptDigest: action.expectedFreezeReceiptDigest,
    equalityReceiptId: action.equalityReceiptId,
    forwardFixRef: action.forwardFixRef
  });
}

function isRejectedCutoverReport(report: unknown): boolean {
  if (!report || typeof report !== "object") return false;
  const status = (report as { readonly status?: unknown }).status;
  return status === "BLOCKED_UNCLASSIFIED_OPERATIONS" || status === "FINAL_SCAN_MISMATCH";
}

function cutoverRejectionMessage(report: unknown): string {
  const status = (report as { readonly status?: unknown }).status;
  return status === "FINAL_SCAN_MISMATCH"
    ? "Independent production final scans do not match; the cutover boundary remains closed."
    : "Authority drain has unclassified non-terminal operations; admission remains closed."
}

function cutoverCommandFailure(command: string, code: typeof CliErrorCode.AuthMissing | typeof CliErrorCode.EngineNotEnabled | typeof CliErrorCode.WriteRejected, message: string): CliResult {
  return { ok: false, command, error: cliError(code, message) };
}
