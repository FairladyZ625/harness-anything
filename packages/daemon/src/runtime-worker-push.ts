import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { repositoryBaseRef } from "./schedule-occurrence-workspace.ts";

const execFileAsync = promisify(execFile),
  detailLimit = 512,
  // One formatted line per commit; a rebased worker branch carries every recreated commit again.
  workerHistoryLimit = 1 << 20,
  // Settlement pushes inside the repository write queue, so a stalled remote or a credential dialog
  // nobody answers holds every write to the repo. A code-only worker branch pushes in seconds; this
  // is the bound the fleet edge gives its own network transfers.
  workerPushTimeoutMs = 60_000;

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
      readonly code?: "push_workflow_scope_required";
    };

export type WorkerGitIdentity = {
  readonly name: string;
  readonly email: string;
};

/** The thrown error code for a failed push: the dedicated remediation code when one applies. */
export function workerPushFailureCode(
  pushed: WorkerPushResult,
): "push_workflow_scope_required" | "delivery_publish_failed" {
  return (pushed.attempted && !pushed.ok ? pushed.code : undefined) ?? "delivery_publish_failed";
}

export function workerGitIdentityForPerson(personId: string): WorkerGitIdentity {
  return { name: personId, email: `${personId}@users.noreply.github.com` };
}

/** A repository-diff delivery is a task branch with at least one commit above the repository baseline. */
export async function workerBranchHasDelivery(input: {
  readonly cwd: string;
  readonly canonicalRoot: string;
  readonly taskId: string;
}): Promise<boolean> {
  if (samePath(input.cwd, input.canonicalRoot)) return false;
  const env = gitEnvironment();
  try {
    const branch = (await readGitText(input.cwd, ["branch", "--show-current"], env)).trim(),
      baseRef = repositoryBaseRef(input.canonicalRoot);
    if (branch !== input.taskId || !baseRef) return false;
    return (await readGitText(input.cwd, ["rev-list", "--count", `${baseRef}..HEAD`], env)).trim() !== "0";
  } catch {
    return false;
  }
}

// A squad worker delivers on the branch its checkout cut: `<commander branch>--squad-…` (the naming
// squad-worker-checkout.ts derives), which never equals the task id the witness above requires. Its
// delivery is commits on that branch beyond the commander branch it was cut from.
export async function squadWorkerBranchHasDelivery(input: { readonly cwd: string }): Promise<boolean> {
  const env = gitEnvironment();
  try {
    const branch = (await readGitText(input.cwd, ["branch", "--show-current"], env)).trim(),
      marker = branch.lastIndexOf("--squad-");
    if (marker <= 0) return false;
    const commander = branch.slice(0, marker);
    return (await readGitText(input.cwd, ["rev-list", "--count", `${commander}..HEAD`], env)).trim() !== "0";
  } catch {
    return false;
  }
}

// The conventional worker identity has exactly one source: the git config the canonical
// repository itself resolves (`git config user.name/user.email` at the canonical root, local
// values over global ones). Worker worktrees share that config, so this states explicitly the
// identity a worker would otherwise inherit implicitly, and no repo setting duplicates it.
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

export async function configureWorkerGitIdentity(cwd: string, personId: string): Promise<void> {
  let checkout = path.resolve(cwd);
  while (!existsSync(path.join(checkout, ".git"))) {
    const parent = path.dirname(checkout);
    if (parent === checkout) return;
    checkout = parent;
  }
  const identity = workerGitIdentityForPerson(personId),
    env = gitEnvironment();
  await readGitText(checkout, ["config", "--local", "extensions.worktreeConfig", "true"], env);
  await readGitText(checkout, ["config", "--worktree", "user.name", identity.name], env);
  await readGitText(checkout, ["config", "--worktree", "user.email", identity.email], env);
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
  readonly timeoutMs?: number;
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

  // Publication runs only when the conventional identity is readable and every commit this push
  // publishes carries it: the commits above the published remote cut when that branch exists, the
  // whole range above the default branch when it does not. Rewriting authorship is a human
  // decision, so a mismatch refuses the push instead of repairing it.
  const identity = input.identity ?? (await readWorkerGitIdentity({ cwd: input.canonicalRoot, env }));
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
  const mismatch = await firstCommitOutsideConventionalIdentity(
    input.cwd,
    [input.expectedRemoteCommit, repositoryBaseRef(input.canonicalRoot)].filter((ref): ref is string => !!ref),
    pushedCommit,
    identity,
    env,
  );
  if (mismatch) return { attempted: true, ok: false, branch, head, pushedCommit, detail: mismatch };

  const timeoutMs = input.timeoutMs ?? workerPushTimeoutMs;
  try {
    const invocation = gitInvocation(
      input.cwd,
      [
        "push",
        input.expectedRemoteCommit === undefined
          ? "--force-with-lease"
          : `--force-with-lease=refs/heads/${branch}:${input.expectedRemoteCommit}`,
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
  readonly timeoutMs?: number;
}): Promise<WorkerPushResult> {
  let expectedRemoteCommit: string;
  try {
    expectedRemoteCommit = await readWorkerRemoteCommit(input.canonicalRoot, input.taskId, input.env);
  } catch (error) {
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
  const command = ["git", "-C", cwd, ...args].map(quoteWindowsGitArgument).join(" ");
  return {
    command: environment.ComSpec ?? environment.COMSPEC ?? "cmd.exe",
    args: ["/d", "/s", "/c", command],
    windowsVerbatimArguments: true,
  };
}

function quoteWindowsGitArgument(value: string): string {
  return /^[^\s"&|<>^()]+$/u.test(value) ? value : `"${value.replaceAll('"', '\\"')}"`;
}

function samePath(left: string, right: string): boolean {
  return canonicalPath(left) === canonicalPath(right);
}

export function canonicalPath(value: string): string {
  try {
    return realpathSync.native(value).replaceAll("\\", "/").replace(/\/+$/u, "");
  } catch {
    return value.replaceAll("\\", "/").replace(/\/+$/u, "");
  }
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

/** Observe without updating tracking refs: later background fetches cannot relax this CAS. */
export async function readWorkerRemoteCommit(
  cwd: string,
  taskId: string,
  extraEnv?: NodeJS.ProcessEnv,
): Promise<string> {
  try {
    const line = await readGitText(
      cwd,
      ["ls-remote", "--refs", "origin", `refs/heads/${taskId}`],
      gitEnvironment(extraEnv),
    );
    return line.trim().split(/\s/u)[0] ?? "";
  } catch (error) {
    throw Object.assign(new Error(errorDetail(error)), { code: "delivery_publish_failed" });
  }
}

/** The center fetches only its configured origin and the task branch, into a request-private ref. */
export async function fetchWorkerDelivery(
  rootDir: string,
  taskId: string,
  requestedCommit?: string,
  expectedIdentity?: WorkerGitIdentity,
): Promise<string> {
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
    const identity = expectedIdentity ?? (await readWorkerGitIdentity({ cwd: rootDir, env }));
    if (!identity) throw new Error("The center repository resolves no conventional Git identity.");
    const baseRef = repositoryBaseRef(rootDir);
    const mismatch = await firstCommitOutsideConventionalIdentity(
      rootDir,
      baseRef ? [baseRef] : [],
      commit,
      identity,
      env,
    );
    if (mismatch) throw new Error(mismatch);
    return commit;
  } finally {
    await readGitText(rootDir, ["update-ref", "-d", ref], env);
  }
}
