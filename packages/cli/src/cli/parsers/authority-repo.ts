import { cliError, CliErrorCode } from "../error-codes.ts";
import { readOption, readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, ParsedCommand } from "../types.ts";

type ParseResult = { readonly ok: true; readonly value: ParsedCommand } | { readonly ok: false; readonly error: CliResult["error"] };
type AuthorityRepoAction = Extract<ParsedCommand["action"], { readonly kind: `authority-repo-${string}` }>;

export function parseAuthorityRepoArgs(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult | null {
  if (args[0] !== "authority" || args[1] !== "repo") return null;
  const subcommand = args[2];
  if (subcommand === "enroll") return parseEnroll(args, rootDir, json);
  if (subcommand === "resign") return parseResign(args, rootDir, json);
  return parseFailure("Use authority repo enroll or authority repo resign.");
}

function parseEnroll(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const repoId = authorityRequiredOption(args, "--repo-id");
  const repoRoot = authorityRequiredOption(args, "--repo-root");
  const manifestPath = authorityRequiredOption(args, "--manifest");
  const serviceStateRoot = authorityRequiredOption(args, "--service-state-root");
  const keyRegistryPath = authorityOptionalOption(args, "--key-registry");
  const namespaceTtlMs = authorityPositiveInteger(args, "--namespace-ttl-ms");
  const allowedExecutorAgentIds = repeated(args, "--allow-executor");
  if (!repoId || !repoRoot || !manifestPath || !serviceStateRoot || namespaceTtlMs === null) {
    return parseFailure("authority repo enroll requires --repo-id, --repo-root, --manifest, and --service-state-root; --namespace-ttl-ms must be a positive integer when supplied.");
  }
  return parseSuccess(rootDir, json, {
    kind: "authority-repo-enroll",
    repoId,
    repoRoot,
    manifestPath,
    serviceStateRoot,
    ...(keyRegistryPath ? { keyRegistryPath } : {}),
    ...(namespaceTtlMs !== undefined ? { namespaceTtlMs } : {}),
    allowedExecutorAgentIds: allowedExecutorAgentIds.length > 0 ? allowedExecutorAgentIds : ["codex"]
  });
}

function parseResign(args: ReadonlyArray<string>, rootDir: string, json: boolean): ParseResult {
  const repoId = authorityRequiredOption(args, "--repo-id");
  const manifestPath = authorityRequiredOption(args, "--manifest");
  const keyRegistryPath = authorityOptionalOption(args, "--key-registry");
  const switchRecordPath = authorityOptionalOption(args, "--switch-record");
  const namespaceTtlMs = authorityPositiveInteger(args, "--namespace-ttl-ms");
  if (!repoId || !manifestPath || namespaceTtlMs === null) {
    return parseFailure("authority repo resign requires --repo-id and --manifest; --namespace-ttl-ms must be a positive integer when supplied.");
  }
  return parseSuccess(rootDir, json, {
    kind: "authority-repo-resign",
    repoId,
    manifestPath,
    ...(keyRegistryPath ? { keyRegistryPath } : {}),
    ...(switchRecordPath ? { switchRecordPath } : {}),
    ...(namespaceTtlMs !== undefined ? { namespaceTtlMs } : {})
  });
}

function authorityRequiredOption(args: ReadonlyArray<string>, name: string): string | undefined {
  const value = authorityOptionalOption(args, name);
  return value;
}

function authorityOptionalOption(args: ReadonlyArray<string>, name: string): string | undefined {
  if (!args.includes(name)) return undefined;
  const value = readOption(args, name);
  return value && !value.startsWith("--") ? value : undefined;
}

function repeated(args: ReadonlyArray<string>, name: string): ReadonlyArray<string> {
  return readRepeatedRawOption(args, name).map((value) => value ?? "").filter((value) => value.length > 0 && !value.startsWith("--"));
}

function authorityPositiveInteger(args: ReadonlyArray<string>, name: string): number | undefined | null {
  if (!args.includes(name)) return undefined;
  const value = authorityOptionalOption(args, name);
  if (!value || !/^\d+$/u.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseSuccess(rootDir: string, json: boolean, action: AuthorityRepoAction): ParseResult {
  return { ok: true, value: { rootDir, json, action } };
}

function parseFailure(message: string): ParseResult {
  return { ok: false, error: cliError(CliErrorCode.WriteRejected, message) };
}
