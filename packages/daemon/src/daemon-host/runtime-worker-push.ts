import { canonicalPath } from "./canonical-path.ts";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { cmdShellInvocation } from "@harness-anything/storage";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { repositoryBaseRefAsync } from "./schedule-occurrence-workspace.ts";
import { assertNoIgnoredLedgerDelivery } from "./ignored-ledger-delivery.ts";
import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";

const execFileAsync = promisify(execFile),
  detailLimit = daemonRuntimePolicy.defaultValue.runtime.workerPushDetailLimit,
  // One formatted line per commit; a rebased worker branch carries every recreated commit again.
  workerHistoryLimit = daemonRuntimePolicy.defaultValue.runtime.workerHistoryLimitBytes,
  // Bound remote transfers even when publication continues outside the repository write queue.
  workerPushTimeoutMs = daemonRuntimePolicy.defaultValue.runtime.workerPushTimeoutMs;

export type WorkerPushResult =
  | { readonly attempted: false; readonly reason: "not-a-worker-worktree" | "not-task-branch" | "detached" }
  | {
      readonly attempted: true;
      readonly ok: true;
      readonly branch: string;
      readonly head: string;
      readonly pushedCommit: string;
    }
  | {
      readonly attempted: true;
      readonly ok: false;
      readonly branch: string | null;
      readonly head: string | null;
      readonly pushedCommit: string | null;
      readonly detail: string;
      /** Set only for rejections with a dedicated remediation path, not for ordinary push failures. */
      readonly code?: "push_workflow_scope_required" | "remote_ahead_of_frozen_cut" | "ignored_ledger_delivery";
    };

export type WorkerGitIdentity = {
  readonly name: string;
  readonly email: string;
};

/** The thrown error code for a failed push: the dedicated remediation code when one applies. */
export function workerPushFailureCode(
  pushed: WorkerPushResult,
): "push_workflow_scope_required" | "ignored_ledger_delivery" | "delivery_publish_failed" {
  return pushed.attempted &&
    !pushed.ok &&
    (pushed.code === "push_workflow_scope_required" || pushed.code === "ignored_ledger_delivery")
    ? pushed.code
    : "delivery_publish_failed";
}

/**
 * The identity a worker falls back to when the canonical repository declares no git identity.
 * The reserved `.invalid` TLD names no hosting provider: the repository's own configuration is
 * the authority, and this value only lets a checkout write a commit when that authority is absent.
 */
export function fallbackWorkerGitIdentity(personId: string): WorkerGitIdentity {
  return { name: personId, email: `${personId}@harness.invalid` };
}

/** A repository-diff delivery is a task branch with at least one commit above the baseline. A
 * caller that knows the branch's own cut (a squad child stacked on its Commander) passes it:
 * counting from the repository baseline would credit inherited Commander commits to the worker. */
export async function workerBranchHasDelivery(input: {
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly taskId: string;
  /** Exact commit or ref the branch was cut from; defaults to the repository delivery baseline. */
  readonly baseRef?: string;
}): Promise<boolean> {
  if (samePath(input.cwd, input.canonicalRoot)) return false;
  const env = gitEnvironment();
  try {
    const branch = (await readGitText(input.cwd, ["branch", "--show-current"], env)).trim(),
      baseRef = input.baseRef ?? (await repositoryBaseRefAsync(input.canonicalRoot));
    if (branch !== input.taskId || !baseRef) return false;
    return (await readGitText(input.cwd, ["rev-list", "--count", `${baseRef}..HEAD`], env)).trim() !== "0";
  } catch {
    return false;
  }
}

// The worker identity has one authoritative source: the git config the canonical repository
// itself resolves (`git config user.name/user.email` at the canonical root, local values over
// global ones). Worker worktrees share that config, so a worker commit inherits it unless a
// stale worktree override says otherwise. The person fallback applies only when the repository
// declares nothing, and it names no hosting provider.
export async function readWorkerGitIdentity(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<WorkerGitIdentity | null> {
  // `--default ""` makes an unset key an ordinary empty answer instead of exit status 1, so "no
  // identity configured" is a value here and only a git that cannot run at all throws.
  const env = gitEnvironment(input.env),
    name = (await readGitText(input.cwd, ["config", "--get", "--default", "", "user.name"], env)).trim(),
    email = (await readGitText(input.cwd, ["config", "--get", "--default", "", "user.email"], env)).trim();
  return name && email ? { name, email } : null;
}

/** The identity a worker checkout must use: the repository's declaration, else the person fallback. */
export async function resolveWorkerGitIdentity(input: {
  readonly cwd: string;
  readonly personId?: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<WorkerGitIdentity | null> {
  return (
    (await readRepositoryGitIdentity({
      cwd: input.cwd,
      ...(input.env === undefined ? {} : { env: input.env }),
    })) ?? (input.personId === undefined ? null : fallbackWorkerGitIdentity(input.personId))
  );
}

/**
 * The repository's declaration, excluding the per-worktree layer: a linked worktree does not
 * inherit the canonical root's `config.worktree`, so resolving through it would make the push
 * expectation differ from what the worker checkout actually commits. Local wins over global over
 * system, exactly as git resolves each key without the worktree file.
 */
async function readRepositoryGitIdentity(input: {
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
}): Promise<WorkerGitIdentity | null> {
  const env = gitEnvironment(input.env),
    read = async (scope: "--local" | "--global" | "--system", key: string) =>
      (await readGitText(input.cwd, ["config", scope, "--get", "--default", "", key], env)).trim();
  let name = "",
    email = "";
  for (const scope of ["--local", "--global", "--system"] as const) {
    if (!name) name = await read(scope, "user.name");
    if (!email) email = await read(scope, "user.email");
    if (name && email) break;
  }
  return name && email ? { name, email } : null;
}

export async function configureWorkerGitIdentity(
  cwd: string,
  canonicalRoot: string,
  personId: string,
  environment?: NodeJS.ProcessEnv,
): Promise<void> {
  let checkout = path.resolve(cwd);
  while (!existsSync(path.join(checkout, ".git"))) {
    const parent = path.dirname(checkout);
    if (parent === checkout) return;
    checkout = parent;
  }
  const env = gitEnvironment(environment),
    sameRoot = samePath(checkout, canonicalRoot);
  // The worker checkout is daemon-owned, so any worktree override there is stale. A runtime that
  // operates in the canonical root itself is still the user's checkout: only the synthetic values
  // this daemon writes are removed there, and a user-declared per-worktree identity survives.
  await clearWorktreeIdentity(checkout, env, sameRoot);
  if (!sameRoot) await clearWorktreeIdentity(canonicalRoot, env, true);
  // For a runtime at the canonical root the checkout's effective identity includes a user-declared
  // worktree override; it must win over the person fallback, or the fallback write would replace it.
  const declared =
    (await readRepositoryGitIdentity({ cwd: canonicalRoot, env })) ??
    (sameRoot ? await readWorkerGitIdentity({ cwd: checkout, env }) : null);
  if (declared) return;
  const identity = fallbackWorkerGitIdentity(personId);
  await readGitText(checkout, ["config", "--local", "extensions.worktreeConfig", "true"], env);
  await readGitText(checkout, ["config", "--worktree", "user.name", identity.name], env);
  await readGitText(checkout, ["config", "--worktree", "user.email", identity.email], env);
}

async function clearWorktreeIdentity(
  checkout: string,
  env: NodeJS.ProcessEnv,
  onlyDaemonIdentity: boolean,
): Promise<void> {
  // Without the extension worktree config does not participate, so there is no override to remove
  // and enabling it would only create a new layer; the fallback path enables it when it writes.
  const enabled = (
    await readGitText(checkout, ["config", "--get", "--default", "", "extensions.worktreeConfig"], env)
  ).trim();
  if (enabled !== "true") return;
  const read = async (key: string) =>
    (await readGitText(checkout, ["config", "--worktree", "--get", "--default", "", key], env)).trim();
  const name = await read("user.name"),
    email = await read("user.email");
  if (!name && !email) return;
  if (onlyDaemonIdentity && !isDaemonWorkerIdentity(name, email)) return;
  for (const [key, value] of [
    ["user.name", name],
    ["user.email", email],
  ] as const)
    if (value) await readGitText(checkout, ["config", "--worktree", "--unset-all", key], env);
}

/** The two synthetic shapes this daemon has written into `config.worktree`. */
function isDaemonWorkerIdentity(name: string, email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at),
    domain = email.slice(at + 1);
  return name === local && (domain === "users.noreply.github.com" || domain === "harness.invalid");
}

/**
 * Publishes the branch Harness named after the dispatched task (dec_8B3FCCD256CAC5B0BF3CCEDE58 CH1):
 * a checkout on any other branch is somebody's own and stays local.
 */
export async function pushWorkerBranch(input: {
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly taskId: string;
  readonly submittedCommitSha?: string;
  /** Exact remote cut observed before the current assignment was checked; empty means absent. */
  readonly expectedRemoteCommit?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly identity?: WorkerGitIdentity;
  /** Dispatching person; supplies the fallback only when the canonical repository declares none. */
  readonly personId?: string;
  readonly timeoutMs?: number;
  /** Settlement sets false so a frozen cut can only advance a remote ref, never rewrite it. */
  readonly forceWithLease?: boolean;
  /** On a rejected settlement push, fetch once to identify a remote descendant of the frozen cut. */
  readonly classifyRemoteAhead?: boolean;
}): Promise<WorkerPushResult> {
  if (samePath(input.cwd, input.canonicalRoot)) return { attempted: false, reason: "not-a-worker-worktree" };
  const env = gitEnvironment(input.env);

  let branch: string;
  try {
    branch = (await readGitText(input.cwd, ["branch", "--show-current"], env)).trim();
  } catch (error) {
    return { attempted: true, ok: false, branch: null, head: null, pushedCommit: null, detail: errorDetail(error) };
  }
  if (!branch) return { attempted: false, reason: "detached" };
  if (branch !== input.taskId) return { attempted: false, reason: "not-task-branch" };

  let head: string;
  try {
    head = (await readGitText(input.cwd, ["rev-parse", "HEAD"], env)).trim();
  } catch (error) {
    return { attempted: true, ok: false, branch, head: null, pushedCommit: null, detail: errorDetail(error) };
  }
  const pushedCommit = input.submittedCommitSha ?? head;

  // Publication runs only when a worker identity is readable and every commit this push
  // publishes carries it: the commits above the published remote cut when that branch exists, the
  // whole range above the default branch when it does not. The repository's own config is the
  // authority; the dispatching person only fills in when that config declares nothing. Rewriting
  // authorship is a human decision, so a mismatch refuses the push instead of repairing it.
  const identity =
    input.identity ??
    (await resolveWorkerGitIdentity({
      cwd: input.canonicalRoot,
      ...(input.personId === undefined ? {} : { personId: input.personId }),
      env,
    }));
  if (!identity)
    return {
      attempted: true,
      ok: false,
      branch,
      head,
      pushedCommit,
      detail:
        `canonical repository ${input.canonicalRoot} resolves no git user.name/user.email, ` +
        "so the conventional worker identity cannot be verified",
    };
  // The worker's own commits are those reachable from the pushed commit but from neither the
  // published remote cut nor the default branch: a published cut already carried its own
  // admission, and after a rebase the default branch's merges are ancestors the worker did not
  // write. An empty expected cut means the remote branch is absent.
  const baseRef = await repositoryBaseRefAsync(input.canonicalRoot),
    mismatch = await firstCommitOutsideConventionalIdentity(
      input.cwd,
      [input.expectedRemoteCommit, baseRef].filter((ref): ref is string => !!ref),
      pushedCommit,
      identity,
      env,
    );
  if (mismatch) return { attempted: true, ok: false, branch, head, pushedCommit, detail: mismatch };

  if (baseRef)
    try {
      await assertNoIgnoredLedgerDelivery(input.cwd, baseRef, pushedCommit);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ignored_ledger_delivery")) throw error;
      return {
        attempted: true,
        ok: false,
        branch,
        head,
        pushedCommit,
        code: "ignored_ledger_delivery",
        detail: error.message,
      };
    }

  const timeoutMs = input.timeoutMs ?? workerPushTimeoutMs;
  try {
    const invocation = gitInvocation(
      input.cwd,
      [
        "push",
        ...(input.forceWithLease === false
          ? []
          : [
              input.expectedRemoteCommit === undefined
                ? "--force-with-lease"
                : `--force-with-lease=refs/heads/${branch}:${input.expectedRemoteCommit}`,
            ]),
        "origin",
        `${pushedCommit}:refs/heads/${branch}`,
      ],
      env,
    );
    await execFileAsync(invocation.command, invocation.args, {
      env,
      maxBuffer: detailLimit * 2,
      timeout: timeoutMs,
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
    return { attempted: true, ok: true, branch, head, pushedCommit };
  } catch (error) {
    // execFile marks the child killed only when it enforced the timeout itself.
    const timedOut = typeof error === "object" && error !== null && "killed" in error && error.killed === true;
    if (timedOut)
      return {
        attempted: true,
        ok: false,
        branch,
        head,
        pushedCommit,
        detail: `git push timed out after ${timeoutMs} ms`,
      };
    // The hosted credential is managed by the CEO, so a workflow-scope rejection has no worker-side
    // remedy: name the handoff push a CEO with local credentials can run instead of the raw refusal.
    const detail = errorDetail(error);
    if (input.classifyRemoteAhead) {
      try {
        const remoteCommit = await fetchRemoteTaskCommit(input.cwd, branch, env);
        if (remoteCommit !== pushedCommit && (await isAncestor(input.cwd, pushedCommit, remoteCommit, env)))
          return {
            attempted: true,
            ok: false,
            branch,
            head,
            pushedCommit,
            code: "remote_ahead_of_frozen_cut",
            detail:
              `Remote task branch is ahead of the frozen cut; re-submit ${branch}: ${pushedCommit} ` +
              `(remote @ ${remoteCommit})`,
          };
      } catch (verificationError) {
        return {
          attempted: true,
          ok: false,
          branch,
          head,
          pushedCommit,
          detail: `${detail}; remote-ahead status could not be verified: ${errorDetail(verificationError)}`,
        };
      }
    }
    return {
      attempted: true,
      ok: false,
      branch,
      head,
      pushedCommit,
      ...(detail.includes("refusing to allow") && detail.includes("workflow")
        ? {
            code: "push_workflow_scope_required" as const,
            detail:
              "GitHub rejected the push: the branch publishes .github/workflows changes and the hosted " +
              "credential lacks the workflow scope. The CEO can publish it with local credentials: " +
              `git -C ${input.cwd} push --force-with-lease origin ${pushedCommit}:refs/heads/${branch}. ` +
              `Git said: ${detail}`,
          }
        : { detail }),
    };
  }
}

/**
 * Publishes a task branch with a remote compare-and-swap cut. Runtime requests and terminal
 * settlement both use this entry point, so two requests for the same execution cannot silently
 * replace a newer branch tip.
 */
export async function pushTaskWorkerBranch(input: {
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly taskId: string;
  readonly submittedCommitSha?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly identity?: WorkerGitIdentity;
  /** Dispatching person; supplies the fallback only when the canonical repository declares none. */
  readonly personId?: string;
  readonly timeoutMs?: number;
  readonly forceWithLease?: boolean;
  readonly classifyRemoteAhead?: boolean;
}): Promise<WorkerPushResult> {
  let expectedRemoteCommit: string;
  try {
    expectedRemoteCommit = await readPublishedTaskCut(input.cwd, input.taskId, input.env);
  } catch (error) {
    // A git that cannot run at all is reported through the same delivery failure every caller
    // already handles, with the cause it printed; only an absent ref is an ordinary empty cut.
    return {
      attempted: true,
      ok: false,
      branch: input.taskId,
      head: null,
      pushedCommit: input.submittedCommitSha ?? null,
      detail: errorDetail(error),
    };
  }
  return pushWorkerBranch({ ...input, expectedRemoteCommit });
}

async function fetchRemoteTaskCommit(cwd: string, branch: string, env: NodeJS.ProcessEnv): Promise<string> {
  await readGitText(
    cwd,
    ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    env,
  );
  return (await readGitText(cwd, ["rev-parse", `refs/remotes/origin/${branch}^{commit}`], env)).trim();
}

async function isAncestor(cwd: string, ancestor: string, descendant: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  try {
    await readGitText(cwd, ["merge-base", "--is-ancestor", ancestor, descendant], env);
    return true;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === 1) return false;
    throw error;
  }
}

// The first commit reachable from `pushedCommit` but from none of `bounds` whose author or
// committer email is not the conventional identity, named with both of its emails; null when the
// whole range matches. Without a bound the worker's own commits cannot be delimited, so that also
// refuses.
async function firstCommitOutsideConventionalIdentity(
  cwd: string,
  bounds: readonly string[],
  pushedCommit: string,
  identity: WorkerGitIdentity,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  if (bounds.length === 0) return "worker commits cannot be bounded: the repository has no default branch";
  let log: string;
  try {
    // Newline-separated fields: git itself refuses newline characters inside an ident, so the
    // three-line records cannot fold into each other.
    log = await readGitText(
      cwd,
      ["log", "--format=%H%n%ae%n%ce", pushedCommit, "--not", ...bounds],
      env,
      workerHistoryLimit,
    );
  } catch (error) {
    return `worker commits cannot be bounded against ${bounds.join(", ")}: ${errorDetail(error)}`;
  }
  const fields = log.split("\n");
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const sha = fields[index]!,
      authorEmail = fields[index + 1]!,
      committerEmail = fields[index + 2]!;
    if (authorEmail !== identity.email || committerEmail !== identity.email)
      return (
        `commit ${sha} carries author <${authorEmail}> and committer ` +
        `<${committerEmail}>, not the conventional identity <${identity.email}>`
      );
  }
  return null;
}

function gitEnvironment(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...process.env, ...extra, GIT_TERMINAL_PROMPT: "0" };
}

async function readGitText(
  cwd: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  maxBuffer = detailLimit * 2,
): Promise<string> {
  const invocation = gitInvocation(cwd, args, env),
    result = await execFileAsync(invocation.command, invocation.args, {
      env,
      maxBuffer,
      timeout: workerPushTimeoutMs,
      windowsHide: true,
      ...(invocation.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    });
  return String(result.stdout);
}

function gitInvocation(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): { readonly command: string; readonly args: readonly string[]; readonly windowsVerbatimArguments?: boolean } {
  if (process.platform !== "win32") return { command: "git", args: ["-C", cwd, ...args] };
  return cmdShellInvocation("git", ["-C", cwd, ...args], environment);
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

// A local origin (a missing mirror, a bare checkout path) makes git echo this host's filesystem
// into push diagnostics, and those diagnostics are relayed to clients and agent prompts that must
// not receive the host layout. errorDetail is the single shaping point for remote-operation
// diagnostics, so the rule lives here; owned sentences that legitimately name rootDir are not
// routed through it. Every shape git prints is covered: POSIX (`/srv/…`), a drive letter with
// either separator (`C:\…`, `C:/…`), UNC (`\\server\share\…`) and `file:///…`. Git quotes a path
// that contains a space, so the quoted form is consumed through its closing quote instead of
// stopping at the first blank. The leading boundary characters keep URL path segments (preceded by
// `:` or a word character) out of the match, which is why `https://host/…` stays for the credential
// rules; a colon inside the path body is a drive separator, not a terminator, while a colon before
// the first slash (`https://`) is what stops a URL from matching at all.
const localPathStart = String.raw`(?:file:\/\/\/|[A-Za-z]:[\\/]|\\\\|\/)`,
  // A quote only opens a path when the path starts immediately; the closing quote must be on the
  // same line, so an unbalanced quote cannot swallow the rest of the diagnostic.
  quotedLocalPath = new RegExp(String.raw`(['"])${localPathStart}[^'"\n]*\1`, "gu"),
  unquotedLocalPath = new RegExp(String.raw`(^|[\s'"[(=])${localPathStart}[^\s'"` + "`" + String.raw`,;)\]<>|]+`, "gu");

function scrubLocalPaths(text: string): string {
  return text.replace(quotedLocalPath, "$1<local-path>$1").replace(unquotedLocalPath, "$1<local-path>");
}

function errorDetail(error: unknown): string {
  const value =
    typeof error === "object" && error !== null && "stderr" in error
      ? String((error as { readonly stderr?: unknown }).stderr ?? "")
      : error instanceof Error
        ? error.message
        : String(error);
  const scrubbed = scrubLocalPaths(String(scrubProviderValue(value)))
    .trim()
    .replace(/\s+/gu, " ");
  return scrubbed.slice(0, detailLimit) || "git push failed without diagnostics";
}

/**
 * The remote cut this node last published or continued, read from the ref `git push` itself
 * writes on success. Empty when this node has never seen the branch, which is exactly the
 * expectation for a first publication.
 *
 * The value that makes a compare-and-swap meaningful is the commit the push is built on, not a
 * tip sampled a moment earlier. Sampling the remote could only catch a push landing inside the
 * few seconds between the two calls, and it made the expectation whatever the remote held right
 * then — so it never protected against this node's checkout predating another node's push, which
 * is the case that loses work. This ref is written by the publishing push and by every fetch of
 * the branch, so it carries the cut this working copy actually knows, and a newer remote tip is
 * refused instead of overwritten.
 */
export async function readPublishedTaskCut(cwd: string, branch: string, extraEnv?: NodeJS.ProcessEnv): Promise<string> {
  // for-each-ref answers an absent ref with empty output and a successful status, so absence is a
  // value here; a git that cannot run at all still throws, as everywhere else in this module.
  return (
    await readGitText(
      cwd,
      ["for-each-ref", "--format=%(objectname)", `refs/remotes/origin/${branch}`],
      gitEnvironment(extraEnv),
    )
  ).trim();
}

/**
 * The center fetches only its configured origin and the task branch, into a request-private ref.
 * It checks the requested cut against the published tip; authorship was already verified where the
 * commit was made and pushed (the worker's own repository config), and the center's config can
 * legitimately differ from the edge clone's, so re-judging identity here would reject valid cuts.
 */
export async function fetchWorkerDelivery(rootDir: string, taskId: string, requestedCommit?: string): Promise<string> {
  const ref = `refs/harness/delivery/${randomUUID()}`,
    env = gitEnvironment();
  try {
    await readGitText(
      rootDir,
      ["fetch", "--no-tags", "--no-write-fetch-head", "origin", `refs/heads/${taskId}:${ref}`],
      env,
    );
    const commit = (await readGitText(rootDir, ["rev-parse", `${ref}^{commit}`], env)).trim();
    if (requestedCommit !== undefined && requestedCommit !== commit)
      throw new Error(`Requested delivery commit ${requestedCommit} does not match published task branch ${commit}.`);
    return commit;
  } finally {
    await readGitText(rootDir, ["update-ref", "-d", ref], env);
  }
}
