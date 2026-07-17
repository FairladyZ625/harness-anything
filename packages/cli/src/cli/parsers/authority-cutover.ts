import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };
type CutoverAction = Extract<ParsedCommand["action"], { readonly kind: `authority-cutover-${string}` }>;

const sha256Pattern = /^[a-f0-9]{64}$/u;

export function parseAuthorityCutoverArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "authority" || args[1] !== "cutover") return null;
  const subcommand = args[2];
  if (subcommand === "status") return cutoverParseSuccess(rootDir, json, { kind: "authority-cutover-status" });
  if (subcommand === "scan") return cutoverParseSuccess(rootDir, json, { kind: "authority-cutover-scan", profileId: "production-final-scan/v1" });
  if (subcommand === "drain") return parseDrain(args, rootDir, json);
  if (subcommand === "confirm") return parseConfirm(args, rootDir, json);
  if (subcommand === "boundary") return parseBoundary(args, rootDir, json);
  if (subcommand === "freeze") return parseFreeze(args, rootDir, json);
  if (subcommand === "re-enable") return parseReEnable(args, rootDir, json);
  return cutoverParseFailure("Use authority cutover status, drain, scan, confirm, boundary, freeze, or re-enable.");
}

function parseDrain(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const classifications: Array<Extract<CutoverAction, { readonly kind: "authority-cutover-drain" }>["classifications"][number]> = [];
  for (const raw of readRepeatedRawOption(args, "--classify")) {
    if (!raw) return cutoverParseFailure("Use --classify <op-id|disposition|recorded-tuple-digest|evidence-ref>.");
    const parts = raw.split("|");
    const [opId, disposition, recordedTupleDigest, evidenceRef] = parts;
    if (parts.length !== 4 || !opId || !evidenceRef || (disposition !== "retryable-not-committed" && disposition !== "indeterminate") || !recordedTupleDigest || !sha256Pattern.test(recordedTupleDigest)) {
      return cutoverParseFailure("Each --classify value must be op-id|retryable-not-committed-or-indeterminate|64-lowercase-hex-recorded-tuple-digest|evidence-ref.");
    }
    classifications.push({ opId, disposition, recordedTupleDigest, evidenceRef });
  }
  return cutoverParseSuccess(rootDir, json, { kind: "authority-cutover-drain", classifications });
}

function parseConfirm(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const firstScanId = readCutoverRequiredOption(args, "--first-scan");
  const secondScanId = readCutoverRequiredOption(args, "--second-scan");
  if (!firstScanId || !secondScanId) return cutoverParseFailure("authority cutover confirm requires --first-scan and --second-scan.");
  return cutoverParseSuccess(rootDir, json, { kind: "authority-cutover-confirm", firstScanId, secondScanId });
}

function parseBoundary(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const boundaryId = readCutoverRequiredOption(args, "--id");
  const equalityReceiptId = readCutoverRequiredOption(args, "--equality");
  const expectedSelectedSchemaTupleDigest = requiredDigest(args, "--expected-v2-tuple-digest");
  if (!boundaryId || !equalityReceiptId || !expectedSelectedSchemaTupleDigest) {
    return cutoverParseFailure("authority cutover boundary requires --id, --equality, and --expected-v2-tuple-digest <64-lowercase-hex>.");
  }
  return cutoverParseSuccess(rootDir, json, { kind: "authority-cutover-boundary", boundaryId, equalityReceiptId, expectedSelectedSchemaTupleDigest });
}

function parseFreeze(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const reason = readCutoverRequiredOption(args, "--reason");
  const expectedBoundaryReceiptDigest = requiredDigest(args, "--boundary-receipt-digest");
  if (!reason || !expectedBoundaryReceiptDigest) return cutoverParseFailure("authority cutover freeze requires --reason and --boundary-receipt-digest <64-lowercase-hex>.");
  return cutoverParseSuccess(rootDir, json, { kind: "authority-cutover-freeze", reason, expectedBoundaryReceiptDigest });
}

function parseReEnable(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const boundaryId = readCutoverRequiredOption(args, "--boundary");
  const expectedFreezeReceiptDigest = requiredDigest(args, "--freeze-receipt-digest");
  const equalityReceiptId = readCutoverRequiredOption(args, "--equality");
  const forwardFixRef = readCutoverRequiredOption(args, "--forward-fix");
  if (!boundaryId || !expectedFreezeReceiptDigest || !equalityReceiptId || !forwardFixRef) {
    return cutoverParseFailure("authority cutover re-enable requires --boundary, --freeze-receipt-digest <64-lowercase-hex>, --equality, and --forward-fix.");
  }
  return cutoverParseSuccess(rootDir, json, { kind: "authority-cutover-re-enable", boundaryId, expectedFreezeReceiptDigest, equalityReceiptId, forwardFixRef });
}

function readCutoverRequiredOption(args: ReadonlyArray<string>, name: string): string | undefined {
  const value = readOption(args, name);
  return value && !value.startsWith("--") ? value : undefined;
}

function requiredDigest(args: ReadonlyArray<string>, name: string): string | undefined {
  const value = readCutoverRequiredOption(args, name);
  return value && sha256Pattern.test(value) ? value : undefined;
}

function cutoverParseSuccess(rootDir: string, json: boolean, action: CutoverAction): ParseResult {
  return { ok: true, value: { rootDir, json, action } };
}

function cutoverParseFailure(message: string): ParseResult {
  return { ok: false, error: cliError(CliErrorCode.WriteRejected, message) };
}
