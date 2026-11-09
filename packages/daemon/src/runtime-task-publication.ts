import {
  SUBMISSION_FACTS_END,
  SUBMISSION_FACTS_START,
  type SubmissionV1,
  renderSubmissionFacts,
  replaceSubmissionFacts,
} from "@harness-anything/kernel";
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
  /** Authored body; the marked machine facts inside it are refreshed from the submission on publication. */
  readonly body?: string;
  /**
   * Re-renders the published body from the frozen cut, preserving prose passed in. The daemon
   * builds it with the same kernel renderer the worker CLI exposes; absent only for repositories
   * without Harness's PR template and gate manifest.
   */
  readonly renderBody?: (body: string | undefined) => string;
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
    if (url === null) throw new Error(`Hosting has no open pull request for task branch ${push.branch}.`);
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

async function upsertPullRequest(
  branch: string,
  input: PullRequestInput,
  env?: NodeJS.ProcessEnv,
  create = true,
): Promise<string | null> {
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
    const existingBody = isJsonObject(existing) ? existing[github ? "body" : "description"] : undefined,
      // The machine facts region is framework-owned: a reworked cut must not leave the previous
      // delivery's commit and production delta on the PR, while authored prose stays untouched.
      body = publishedBody(existingBody, input),
      patch = {
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(body === undefined || body === existingBody ? {} : { [github ? "body" : "description"]: body }),
      };
    if (Object.keys(patch).length === 0) return existing;
    return (await request(`${collection}/${number}`, github ? "PATCH" : "PUT", patch)).value;
  };
  let existing = await find(),
    result: unknown;
  if (existing) result = await update(existing);
  else if (!create) return null;
  else {
    const created = await request(collection, "POST", {
      title: input.title ?? input.taskTitle,
      ...(github ? { head: branch, base } : { source_branch: branch, target_branch: base }),
      [github ? "body" : "description"]: publishedBody(undefined, input) ?? submittedBody(input.submission),
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

/**
 * Refresh an existing open PR body from the frozen submission without pushing or creating a PR.
 * Submit uses this after it freezes a cut; the push path keeps `create = true` for first publication.
 */
export async function updateTaskPullRequestBody(
  input: PullRequestInput & { readonly branch: string; readonly env?: NodeJS.ProcessEnv },
): Promise<string | null> {
  return upsertPullRequest(input.branch, input, input.env, false);
}

/** Refresh only the marked machine facts; an edited or marker-less body keeps its authored text. */
function publishedBody(existingBody: unknown, input: PullRequestInput): string | undefined {
  const block = renderSubmissionFacts(input.submission),
    candidate = typeof input.body === "string" ? input.body : existingBody,
    authored = typeof candidate === "string" ? candidate : undefined,
    // A marker-less body can still carry the template's four authored sections; insert the one
    // machine region so the renderer preserves that prose while adding governance and facts. An
    // arbitrary marker-less body has no safe anchor, so the template render replaces it instead of
    // republishing protected prose that can never satisfy the governance lint.
    renderInput =
      input.renderBody === undefined || authored === undefined
        ? undefined
        : hasSubmissionFacts(authored)
          ? authored
          : markerizedTemplateBody(authored),
    rendered = input.renderBody ? input.renderBody(renderInput) : authored;
  return typeof rendered === "string" ? (replaceSubmissionFacts(rendered, block) ?? rendered) : undefined;
}

function hasSubmissionFacts(body: string): boolean {
  return body.includes(SUBMISSION_FACTS_START) && body.includes(SUBMISSION_FACTS_END);
}

const TEMPLATE_SECTIONS = ["Summary", "What Changed", "Verification", "Residual Risk"] as const;

/** Add the one machine region to a template-shaped body that predates the marker convention. */
function markerizedTemplateBody(body: string): string | undefined {
  if (body.includes(SUBMISSION_FACTS_START) || body.includes(SUBMISSION_FACTS_END)) return undefined;
  if (!TEMPLATE_SECTIONS.every((title) => new RegExp(`^##[ \\t]+${title}[ \\t]*$`, "mu").test(body))) return undefined;
  const heading = /^##[ \t]+What Changed[ \t]*$/mu.exec(body);
  if (!heading) return undefined;
  const after = body.slice(heading.index + heading[0].length),
    next = /^##[ \t]+/mu.exec(after),
    insertAt = heading.index + heading[0].length + (next?.index ?? after.length);
  return `${body.slice(0, insertAt)}\n${SUBMISSION_FACTS_START}\n${SUBMISSION_FACTS_END}\n${body.slice(insertAt)}`;
}

/** These are the framework's frozen closeout fields, not a repository PR template. */
function submittedBody(submission: SubmissionV1): string {
  return [submission.completionClaim, ...submission.verificationNotes, `Delivery commit: ${submission.commitSha}`].join(
    "\n\n",
  );
}
