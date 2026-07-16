import { Effect } from "effect";
import type { EngineError, ExternalRef, TaskSnapshot } from "../../../kernel/src/index.ts";
import { makeGithubCredentialResolver } from "./auth.ts";
import { decodeGithubIssue, decodeGithubIssueList } from "./codec.ts";
import { mapGithubIssue } from "./mapper.ts";
import { isEngineError, parseGithubIssueRef, parseGithubRepositoryRef } from "./ref.ts";
import { makeFetchGithubTransport } from "./transport.ts";
import type {
  GithubCredential,
  GithubCredentialResolver,
  GithubHttpResponse,
  GithubIssuesLifecycleEngine,
  GithubLabelMapping,
  GithubRepositoryRef,
  GithubTaskListFilter,
  GithubTransport,
  GithubTransportError
} from "./types.ts";

export interface GithubIssuesProviderOptions {
  readonly transport?: GithubTransport;
  readonly credentialResolver?: GithubCredentialResolver;
  readonly clock?: () => Date;
  readonly labelMapping?: GithubLabelMapping;
  readonly defaultRepository?: string;
}

const apiBaseUrl = "https://api.github.com";
const pageSize = 100;
const maxPages = 100;
const githubHeaders = {
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "harness-anything-github-issues/0.1"
} as const;

export const githubIssuesAdapterProviderMetadata = {
  id: "github",
  capabilities: ["task.read", "task.snapshot"],
  readonly: true,
  writable: false
} as const;

export function makeGithubIssuesLifecycleEngine(options: GithubIssuesProviderOptions = {}): GithubIssuesLifecycleEngine {
  const transport = options.transport ?? makeFetchGithubTransport();
  const credentials = options.credentialResolver ?? makeGithubCredentialResolver();
  const clock = options.clock ?? (() => new Date());

  return {
    name: "github",
    capabilities: Effect.succeed({ snapshots: true, listTasks: true, publishNote: false }),
    snapshot: (taskRef) => {
      if (taskRef.engine !== "github" || taskRef.ref === null) {
        return Effect.fail({
          _tag: "EngineOwnsStatus",
          engine: taskRef.engine,
          ref: taskRef.ref ?? ""
        } satisfies EngineError);
      }
      const parsed = parseGithubIssueRef(taskRef.ref);
      if (isEngineError(parsed)) return Effect.fail(parsed);
      return credentials.resolve().pipe(
        Effect.flatMap((credential) => requestIssue(transport, credential, parsed.owner, parsed.repo, parsed.number, parsed.normalized)),
        Effect.flatMap((response) => decodeSnapshotResponse(response, parsed.normalized, clock(), options.labelMapping))
      );
    },
    listTasks: (filter) => listGithubIssues({
      transport,
      credentials,
      clock,
      labelMapping: options.labelMapping,
      defaultRepository: options.defaultRepository,
      filter
    })
  };
}

function decodeSnapshotResponse(
  response: GithubHttpResponse,
  ref: ExternalRef,
  fetchedAt: Date,
  labelMapping?: GithubLabelMapping
): Effect.Effect<TaskSnapshot, EngineError> {
  const statusError = translateHttpStatus(response, ref, fetchedAt);
  if (statusError) return Effect.fail(statusError);
  const decoded = decodeGithubIssue(response.body);
  if (decoded.kind === "pull-request") return Effect.fail({ _tag: "RefNotFound", ref });
  if (decoded.kind === "error") return Effect.fail(decoded.error);
  const expectedNumber = Number(ref.slice(ref.lastIndexOf("#") + 1));
  if (decoded.issue.number !== expectedNumber || !responseUrlMatchesRef(decoded.issue.htmlUrl, ref)) {
    return Effect.fail({ _tag: "MalformedSnapshot", raw: "github_issue_invalid:ref_mismatch" });
  }
  return Effect.succeed(mapGithubIssue(decoded.issue, { ref, fetchedAt, labelMapping }));
}

function listGithubIssues(input: {
  readonly transport: GithubTransport;
  readonly credentials: GithubCredentialResolver;
  readonly clock: () => Date;
  readonly labelMapping?: GithubLabelMapping;
  readonly defaultRepository?: string;
  readonly filter: GithubTaskListFilter;
}): Effect.Effect<ReadonlyArray<TaskSnapshot>, EngineError> {
  if (input.filter.engine && input.filter.engine !== "github") {
    return Effect.fail({ _tag: "EngineNotEnabled", engine: input.filter.engine });
  }
  const repositoryText = input.filter.repository ?? input.defaultRepository;
  if (!repositoryText) return Effect.fail({ _tag: "RefNotFound", ref: "" });
  const repository = parseGithubRepositoryRef(repositoryText);
  if (isEngineError(repository)) return Effect.fail(repository);

  return input.credentials.resolve().pipe(
    Effect.flatMap((credential) => fetchIssuePages(input, credential, repository))
  );
}

function fetchIssuePages(
  input: {
    readonly transport: GithubTransport;
    readonly clock: () => Date;
    readonly labelMapping?: GithubLabelMapping;
    readonly filter: GithubTaskListFilter;
  },
  credential: GithubCredential,
  repository: GithubRepositoryRef
): Effect.Effect<ReadonlyArray<TaskSnapshot>, EngineError> {
  return Effect.gen(function* () {
    const snapshots: TaskSnapshot[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const response = yield* requestIssueList(input.transport, credential, repository, input.filter, page);
      const statusError = translateHttpStatus(response, repository.normalized, input.clock());
      if (statusError) return yield* Effect.fail(statusError);
      const decoded = decodeGithubIssueList(response.body);
      if (decoded.kind === "error") return yield* Effect.fail(decoded.error);
      const fetchedAt = input.clock();
      for (const issue of decoded.issues) {
        const ref = `${repository.normalized}#${issue.number}`;
        if (!responseUrlMatchesRef(issue.htmlUrl, ref)) {
          return yield* Effect.fail({
            _tag: "MalformedSnapshot",
            raw: "github_issue_list_invalid:ref_mismatch"
          } satisfies EngineError);
        }
        const snapshot = mapGithubIssue(issue, { ref, fetchedAt, labelMapping: input.labelMapping });
        if (input.filter.rawStatus && snapshot.rawStatus !== input.filter.rawStatus) continue;
        snapshots.push(snapshot);
      }
      if (!hasNextPage(response.headers.link)) return snapshots;
    }
    return yield* Effect.fail({
      _tag: "MalformedSnapshot",
      raw: "github_issue_list_invalid:pagination_limit"
    } satisfies EngineError);
  });
}

function requestIssue(
  transport: GithubTransport,
  credential: GithubCredential,
  owner: string,
  repo: string,
  number: number,
  ref: string
): Effect.Effect<GithubHttpResponse, EngineError> {
  const url = `${apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${number}`;
  return request(transport, credential, url, ref);
}

function requestIssueList(
  transport: GithubTransport,
  credential: GithubCredential,
  repository: GithubRepositoryRef,
  filter: GithubTaskListFilter,
  page: number
): Effect.Effect<GithubHttpResponse, EngineError> {
  const query = new URLSearchParams({ per_page: String(pageSize), page: String(page) });
  const state = filter.rawStatus?.split(":", 1)[0];
  if (state === "open" || state === "closed") query.set("state", state);
  if (filter.label) query.set("labels", filter.label);
  const url = `${apiBaseUrl}/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/issues?${query.toString()}`;
  return request(transport, credential, url, repository.normalized);
}

function request(
  transport: GithubTransport,
  credential: GithubCredential,
  url: string,
  ref: string
): Effect.Effect<GithubHttpResponse, EngineError> {
  return transport.request({
    method: "GET",
    url,
    headers: { ...githubHeaders, Authorization: `Bearer ${credential.token}` }
  }).pipe(Effect.mapError((error) => translateTransportError(error, ref)));
}

function translateTransportError(error: GithubTransportError, _ref: string): EngineError {
  switch (error._tag) {
    case "GithubTransportTimeout":
      return { _tag: "Timeout", ms: error.ms };
    case "GithubInvalidJson":
      return { _tag: "MalformedSnapshot", raw: "github_response_invalid:json" };
    case "GithubNetworkFailure":
      return { _tag: "EngineUnreachable", engine: "github", cause: { kind: "network" } };
  }
}

function translateHttpStatus(response: GithubHttpResponse, ref: string, now: Date): EngineError | undefined {
  if (response.status >= 200 && response.status < 300) return undefined;
  if (response.status === 429 || (response.status === 403 && response.headers["x-ratelimit-remaining"] === "0")) {
    const retryAfterMs = parseRetryAfter(response.headers, now);
    return {
      _tag: "RateLimited",
      engine: "github",
      ...(retryAfterMs === undefined ? {} : { retryAfterMs })
    };
  }
  if (response.status === 401 || response.status === 403) return { _tag: "AuthMissing", engine: "github" };
  if (response.status === 404) return { _tag: "RefNotFound", ref };
  if (response.status >= 500) {
    return { _tag: "EngineUnreachable", engine: "github", cause: { kind: "http", status: response.status } };
  }
  return { _tag: "AdapterUnavailable", engine: "github", cause: { kind: "http", status: response.status } };
}

function parseRetryAfter(headers: Readonly<Record<string, string>>, now: Date): number | undefined {
  const retryAfter = Number(headers["retry-after"]);
  if (Number.isFinite(retryAfter) && retryAfter >= 0) return retryAfter * 1_000;
  const reset = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset >= 0) return Math.max(0, reset * 1_000 - now.getTime());
  return undefined;
}

function hasNextPage(link: string | undefined): boolean {
  return link?.split(",").some((part) => /;\s*rel="next"\s*$/u.test(part.trim())) ?? false;
}

function responseUrlMatchesRef(url: string, expectedRef: string): boolean {
  const parsed = parseGithubIssueRef(url);
  return !isEngineError(parsed) && parsed.normalized === expectedRef;
}
