import { type SubmissionV1 } from "@harness-anything/kernel";
import type { HostingProvider } from "./hosting-provider.ts";
import { pushTaskWorkerBranch } from "./runtime-worker-push.ts";
import { scrubProviderValue } from "./dispatch-stream.ts";
import { isJsonObject } from "./protocol/json-rpc-types.ts";

type PullRequestInput = {
  readonly hosting: HostingProvider;
  /** Used only when creating a PR without an explicit title. */
  readonly taskTitle: string;
  /** Existing PR metadata changes only when explicitly supplied by the caller. */
  readonly title?: string;
  readonly submission: SubmissionV1;
  /** Repository-authored Markdown is passed through; settlement never replaces an existing body. */
  readonly body?: string;
};
/** The only task publication port: both explicit push and terminal settlement use it. */
export async function publishTaskWorkerBranch(
  input: Parameters<typeof pushTaskWorkerBranch>[0] & { readonly pullRequest?: PullRequestInput },
): Promise<{
  readonly push: Awaited<ReturnType<typeof pushTaskWorkerBranch>>;
  readonly pullRequest?: { readonly url: string };
}> {
  const push = await pushTaskWorkerBranch(input);
  if (!push.attempted || !push.ok || !input.pullRequest) return { push };
  try {
    if (push.pushedCommit !== input.pullRequest.submission.commitSha)
      throw new Error(
        `The pushed commit differs from the frozen submission; run ha task submit ${input.taskId} --amend first.`,
      );
    const url = await upsertPullRequest(push.branch, input.pullRequest, input.env);
    return { push, pullRequest: { url } };
  } catch (error) {
    const detail = String(scrubProviderValue(error instanceof Error ? error.message : String(error))).slice(0, 512);
    throw Object.assign(
      new Error(`Branch pushed; PR publication failed: ${detail} Retry: ha task push ${input.taskId}.`, {
        cause: error,
      }),
      { code: "delivery_publish_failed" },
    );
  }
}

async function upsertPullRequest(branch: string, input: PullRequestInput, env?: NodeJS.ProcessEnv): Promise<string> {
  const github = input.hosting.kind === "github",
    token = github
      ? (env?.GH_TOKEN ?? env?.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN)
      : (env?.GITLAB_TOKEN ?? process.env.GITLAB_TOKEN);
  if (!token)
    throw new Error(
      "PR publication requires the daemon-held hosting credential; retry ha task push after configuring it.",
    );
  const hosting = input.hosting,
    api =
      hosting.kind === "github"
        ? `${hosting.host === "github.com" ? "https://api.github.com" : `https://${hosting.host}/api/v3`}/repos/${hosting.repository}`
        : `${hosting.apiBaseUrl}/projects/${encodeURIComponent(hosting.projectPath)}`,
    // One budget covers the complete upsert, including duplicate-create reconciliation.
    signal = AbortSignal.timeout(30_000),
    headers = { Authorization: `Bearer ${token}`, Accept: "application/json", "Content-Type": "application/json" };
  const request = async (url: string, method = "GET", body?: Record<string, unknown>) => {
    const response = await fetch(url, {
      method,
      headers,
      signal,
      redirect: "error",
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok && !(method === "POST" && (response.status === 409 || response.status === 422)))
      throw new Error(`Hosting ${method} returned HTTP ${response.status} for task branch ${branch}.`);
    return { status: response.status, value: response.ok ? ((await response.json()) as unknown) : null };
  };
  const repository = (await request(api)).value;
  if (!isJsonObject(repository) || typeof repository.default_branch !== "string")
    throw new Error("Hosting repository response has no default branch.");
  const base = repository.default_branch,
    collection = `${api}/${github ? "pulls" : "merge_requests"}`,
    query = new URLSearchParams(
      github
        ? {
            state: "open",
            head: `${hosting.kind === "github" ? hosting.repository.split("/")[0] : ""}:${branch}`,
            per_page: "1",
          }
        : { state: "opened", source_branch: branch, per_page: "1" },
    );
  const find = async () => {
    const rows = (await request(`${collection}?${query}`)).value;
    if (!Array.isArray(rows)) throw new Error("Hosting pull request list is not an array.");
    return rows[0];
  };
  const update = async (existing: unknown) => {
    const number = isJsonObject(existing) ? existing[github ? "number" : "iid"] : undefined;
    if (typeof number !== "number") throw new Error("Hosting pull request has no number.");
    if (input.title === undefined && input.body === undefined) return existing;
    return (
      await request(`${collection}/${number}`, github ? "PATCH" : "PUT", {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { [github ? "body" : "description"]: input.body }),
      })
    ).value;
  };
  let existing = await find(),
    result: unknown;
  if (existing) result = await update(existing);
  else {
    const created = await request(collection, "POST", {
      title: input.title ?? input.taskTitle,
      ...(github ? { head: branch, base } : { source_branch: branch, target_branch: base }),
      [github ? "body" : "description"]: input.body ?? submittedBody(input.submission),
    });
    // Concurrent edge settlements can both observe absence. The hosting conflict is a value;
    // reconcile it against the branch identity, otherwise surface the original HTTP failure.
    if (created.status === 409 || created.status === 422) {
      existing = await find();
      if (!existing) throw new Error(`Hosting POST returned HTTP ${created.status} for task branch ${branch}.`);
      result = await update(existing);
    } else result = created.value;
  }
  const url = isJsonObject(result) ? result[github ? "html_url" : "web_url"] : undefined;
  if (typeof url !== "string") throw new Error("Hosting pull request response has no URL.");
  return url;
}

/** These are the framework's frozen closeout fields, not a repository PR template. */
function submittedBody(submission: SubmissionV1): string {
  return [submission.completionClaim, ...submission.verificationNotes, `Delivery commit: ${submission.commitSha}`].join(
    "\n\n",
  );
}
