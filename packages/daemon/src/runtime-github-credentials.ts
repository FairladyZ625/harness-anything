import { existsSync } from "node:fs";
import path from "node:path";
import { runProcessExitAsync } from "./process-port.ts";
import { registerSecretValue } from "./secret-scrub.ts";

/**
 * The one launch-time injection point for the operator's GitHub credential. Every runtime child,
 * under enforced isolation or the operator environment, receives the same pair:
 *
 *   GH_TOKEN                    the operator's own token, read once per launch
 *   GIT_CONFIG_*                github.com's credential helper is `gh auth git-credential`
 *
 * `gh` prefers `GH_TOKEN` over stored credentials and answers it without reading the macOS
 * keychain, so the isolated HOME no longer needs its own `gh auth login` and the dialog that an
 * instance home without a keychain preference used to trigger never opens. The empty helper
 * assignment before the gh one is what clears a helper the child would otherwise resolve from its
 * own `.gitconfig` (the system `osxkeychain`, or a stale per-instance `gh` path); git treats an
 * empty value as "reset this helper list, then continue with the next value".
 *
 * GitLab is deliberately not part of this contract: `ha task push` keeps using the daemon-held
 * hosting credential, and only `github.com` is redirected here.
 */

/**
 * One sentence a dispatch receipt carries when the operator's GitHub login is unavailable. The
 * launch still happens: a worker that cannot publish is worse than one that reports why.
 */
export const githubCredentialUnavailableNotice =
  "The operator's GitHub credential is unavailable (gh is not signed in on this machine), so this worker cannot push, open a pull request, or read CI logs; the dispatch itself continues.";

const githubHost = "github.com",
  credentialHelperKey = `credential.https://${githubHost}.helper`,
  credentialHelperCommand = "!gh auth git-credential",
  tokenProbeTimeoutMs = 10_000;

/** The receipt notice for a launch that had no operator login; undefined when the token was applied. */
export type GithubCredentialNotice = string | undefined;

/**
 * Reads the operator's GitHub token once per launch, from the operator environment (the daemon's
 * own HOME), never from an isolated instance home. An inherited `GH_TOKEN`/`GITHUB_TOKEN` is used
 * as-is; otherwise `gh auth token` answers from the operator's own login.
 *
 * Both absences are ordinary answers here rather than exceptions: no `gh` on the operator PATH and
 * a signed-out `gh` both return null, and the caller turns that into a dispatch receipt notice.
 * Only a `gh` that exists but cannot be executed at all still throws — a real machine fault, not
 * the "operator never logged in" case this contract reports. The token only ever travels into the
 * child's environment: no file, log, event, or prompt receives it.
 */
export async function resolveOperatorGithubToken(
  operatorEnvironment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  exitCommand: typeof runProcessExitAsync = runProcessExitAsync,
): Promise<string | null> {
  const inherited = usableToken(operatorEnvironment.GH_TOKEN ?? operatorEnvironment.GITHUB_TOKEN);
  if (inherited) return inherited;
  const executable = executableOnPath(operatorEnvironment.PATH ?? "", "gh", platform);
  if (executable === null) return null;
  const result = await exitCommand(
    executable,
    ["auth", "token", "--hostname", githubHost],
    undefined,
    operatorEnvironment,
    undefined,
    undefined,
    { timeoutMs: tokenProbeTimeoutMs },
  );
  return result.exitCode === 0 ? usableToken(result.stdout) : null;
}

// The operator PATH decides which gh the daemon would run, so the same PATH decides whether the
// probe is worth spawning. Windows resolves through PATHEXT; POSIX names the command directly.
export function executableOnPath(searchPath: string, command: string, platform: NodeJS.Platform): string | null {
  const suffixes = platform === "win32" ? [".exe", ".cmd"] : [""];
  for (const directory of searchPath.split(path.delimiter).filter(Boolean))
    for (const suffix of suffixes) {
      const candidate = path.resolve(directory, `${command}${suffix}`);
      if (existsSync(candidate)) return candidate;
    }
  return null;
}

/**
 * The single injection point: applies the token and the github.com helper to the launch
 * environment in place and returns the notice a receipt carries (undefined when applied).
 * Existing `GIT_CONFIG_*` entries are preserved — the two new entries follow the contiguous
 * prefix git already reads, so an operator-supplied setting keeps its place.
 */
export function applyGithubLaunchCredential(
  environment: NodeJS.ProcessEnv,
  token: string | null,
): GithubCredentialNotice {
  if (token === null) return githubCredentialUnavailableNotice;
  registerSecretValue(token);
  const count = gitConfigEntryCount(environment);
  environment.GH_TOKEN = token;
  environment.GIT_CONFIG_COUNT = String(count + 2);
  environment[`GIT_CONFIG_KEY_${count}`] = credentialHelperKey;
  environment[`GIT_CONFIG_VALUE_${count}`] = "";
  environment[`GIT_CONFIG_KEY_${count + 1}`] = credentialHelperKey;
  environment[`GIT_CONFIG_VALUE_${count + 1}`] = credentialHelperCommand;
  return undefined;
}

/**
 * Attaches the missing-credential notice to a spawn receipt. The receipt is returned as-is when
 * the launch had a token, so a healthy dispatch carries no new field.
 */
export function withGithubCredentialWarnings<T extends Record<string, unknown>>(receipt: T, notice?: string): T {
  if (notice === undefined) return receipt;
  const warnings = Array.isArray(receipt.warnings) ? (receipt.warnings as readonly unknown[]) : [];
  return { ...receipt, warnings: [...warnings, notice] };
}

function usableToken(value: string | undefined): string | null {
  const token = value?.trim() ?? "";
  return token.length > 0 && !/\s/u.test(token) ? token : null;
}

// Counts the entries git will actually read. A declared `GIT_CONFIG_COUNT` whose key or value is
// missing makes git reject the whole environment, so only the contiguous prefix is kept and a
// malformed count contributes nothing.
function gitConfigEntryCount(environment: NodeJS.ProcessEnv): number {
  const declared = Number.parseInt(environment.GIT_CONFIG_COUNT ?? "", 10);
  if (!Number.isInteger(declared) || declared <= 0) return 0;
  let contiguous = 0;
  while (
    contiguous < declared &&
    environment[`GIT_CONFIG_KEY_${contiguous}`] !== undefined &&
    environment[`GIT_CONFIG_VALUE_${contiguous}`] !== undefined
  )
    contiguous += 1;
  return contiguous;
}
