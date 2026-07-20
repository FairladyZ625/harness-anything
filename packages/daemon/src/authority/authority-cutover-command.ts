// @slice-activation PLT-Boundary W2 daemon-owned authority cutover command host.
import type {
  AuthorityCutoverCommandAction,
  AuthorityCutoverCommandErrorCode,
  AuthorityCutoverCommandReport,
  AuthorityCutoverCommandResult,
  AuthorityCutoverControlService
} from "@harness-anything/application";

export function isAuthorityCutoverAction(action: { readonly kind: string }): boolean {
  return cutoverActionKinds.has(action.kind as AuthorityCutoverCommandAction["kind"]);
}

export async function runAuthorityCutoverControlCommand(input: {
  readonly action: AuthorityCutoverCommandAction;
  readonly control?: AuthorityCutoverControlService;
  readonly authenticated: boolean;
}): Promise<AuthorityCutoverCommandResult> {
  if (!input.authenticated) return cutoverCommandFailure(input.action.kind, "AuthMissing", "Authority cutover controls require an authenticated daemon principal.");
  if (!input.control) return cutoverCommandFailure(input.action.kind, "EngineNotEnabled", "Authority cutover controls require a production daemon started with --authority-manifest.");
  try {
    const report = await executeAuthorityCutoverAction(input.control, input.action);
    const rejected = isRejectedCutoverReport(report);
    return rejected
      ? { ok: false, command: input.action.kind, report, error: { code: "write_rejected", hint: cutoverRejectionMessage(report) } }
      : { ok: true, command: input.action.kind, report };
  } catch (error) {
    return cutoverCommandFailure(input.action.kind, "write_rejected", error instanceof Error ? error.message : String(error));
  }
}

async function executeAuthorityCutoverAction(control: AuthorityCutoverControlService, action: AuthorityCutoverCommandAction): Promise<AuthorityCutoverCommandReport> {
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

function isRejectedCutoverReport(report: AuthorityCutoverCommandReport): boolean {
  return (report.schema === "authority-cutover-drain-receipt/v1" && report.status === "BLOCKED_UNCLASSIFIED_OPERATIONS")
    || (report.schema === "authority-cutover-equality-receipt/v1" && report.status === "FINAL_SCAN_MISMATCH");
}

function cutoverRejectionMessage(report: AuthorityCutoverCommandReport): string {
  return report.schema === "authority-cutover-equality-receipt/v1"
    ? "Independent production final scans do not match; the cutover boundary remains closed."
    : "Authority drain has unclassified non-terminal operations; admission remains closed."
}

function cutoverCommandFailure(command: string, code: AuthorityCutoverCommandErrorCode, message: string): AuthorityCutoverCommandResult {
  return { ok: false, command: command as AuthorityCutoverCommandAction["kind"], error: { code, hint: message } };
}

const cutoverActionKinds = new Set<AuthorityCutoverCommandAction["kind"]>([
  "authority-cutover-status",
  "authority-cutover-drain",
  "authority-cutover-scan",
  "authority-cutover-confirm",
  "authority-cutover-boundary",
  "authority-cutover-freeze",
  "authority-cutover-re-enable"
]);
