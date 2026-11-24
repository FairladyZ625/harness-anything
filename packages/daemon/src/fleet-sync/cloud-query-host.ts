import { readPersonalAgendaAwaitsFromAsyncProjection } from "@harness-anything/application/internal/queries/agenda-awaits-read.ts";
import { readCollaboratorTaskPageFromAsyncProjection } from "@harness-anything/application/internal/queries/collaborator-reads.ts";
import { workTopologyFromAsyncProjection } from "@harness-anything/application/internal/queries/work-topology-read.ts";
import { workspaceSummaryFromProjectionRead } from "@harness-anything/application/internal/queries/workspace-summary-read.ts";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { withPgProjectionReadSession } from "@harness-anything/storage/pg/read-only";

type ReadSession = Parameters<typeof withPgProjectionReadSession>[1];
type Projection = Parameters<Parameters<typeof withPgProjectionReadSession>[2]>[0];
type QueryContext = {
  readonly search: URLSearchParams;
  readonly personId: string;
};
type Route = (projection: Projection, context: QueryContext) => Promise<unknown>;

export type CloudQueryAuthorizationResult =
  | { readonly outcome: "allowed"; readonly personId: string }
  | { readonly outcome: "unauthenticated" }
  | { readonly outcome: "denied" }
  | { readonly outcome: "unavailable" };

export interface CloudQueryAuthorizer {
  readonly authorizeRepositoryRead: (input: {
    readonly token: string;
    readonly repoId: string;
    readonly signal: AbortSignal;
  }) => Promise<CloudQueryAuthorizationResult>;
}

const routes = new Map<string, Route>([
  [
    "workspace-summary",
    async (projection) => workspaceSummaryFromProjectionRead(await projection.readWorkspaceSummary()),
  ],
  [
    "work-topology",
    (projection, { search }) => {
      const workRootTaskId = search.get("workRootTaskId");
      if (!workRootTaskId || workRootTaskId.length > 256 || workRootTaskId.includes("/"))
        throw new QueryFault(400, "invalid_work_root");
      return workTopologyFromAsyncProjection(projection, { workRootTaskId });
    },
  ],
  [
    "collaborator-board",
    (projection, { personId, search }) =>
      readCollaboratorTaskPageFromAsyncProjection(
        projection,
        { ...page(search), activePackagesOnly: true },
        { involvement: "mine", viewerPersonId: personId },
      ),
  ],
  [
    "agenda-awaits",
    (projection, { personId, search }) =>
      readPersonalAgendaAwaitsFromAsyncProjection(projection, { ...page(search), viewerPersonId: personId }),
  ],
]);

export interface CloudQueryHostOptions {
  readonly pool: Parameters<typeof withPgProjectionReadSession>[0];
  readonly authorizer: CloudQueryAuthorizer;
  /** Deployment-owned repository admission. Values determine the PG tenant, project, epoch and reader scope. */
  readonly repositories: ReadonlyMap<string, ReadSession["scope"]>;
  /** A replica sheds overload before OIDC and PG receive work. */
  readonly maxInFlight: number;
  readonly timeoutMs?: number;
  readonly onError?: (error: unknown) => void;
}

const INT32_CEILING = 0x7fff_ffff;
const READ_ONLY_HEADERS: ReadonlyArray<readonly [string, string]> = [["allow", "GET"]];
const OVERLOAD_HEADERS: ReadonlyArray<readonly [string, string]> = [["retry-after", "1"]];
const BEARER_CHALLENGE_HEADERS: ReadonlyArray<readonly [string, string]> = [["www-authenticate", "Bearer"]];

/** Independent Fetch handler for GET /v1/repositories/{repoId}/{route}. The caller owns the pool and listener. */
export function createCloudQueryHost(options: CloudQueryHostOptions): (request: Request) => Promise<Response> {
  const timeoutMs = options.timeoutMs ?? storageReadPolicy.defaultValue.deadlines.query;
  const minimumLimit = storageReadPolicy.defaultValue.minimumRows;
  if (
    !isWithinBounds(timeoutMs, minimumLimit, INT32_CEILING) ||
    !isWithinBounds(options.maxInFlight, minimumLimit, Number.MAX_SAFE_INTEGER)
  )
    throw new RangeError("Cloud query admission requires positive, bounded limits.");
  const repositories = new Map(options.repositories);
  let inFlight = 0;
  return async (request) => {
    const url = new URL(request.url);
    const match = /^\/v1\/repositories\/([A-Za-z0-9._-]{1,256})\/([a-z-]+)$/u.exec(url.pathname);
    const route = match && routes.get(match[2]!);
    if (!match || !route) return fault(404, "route_not_found");
    if (request.method !== "GET") return fault(405, "method_not_allowed", READ_ONLY_HEADERS);
    const repoId = match[1]!;
    const token = /^Bearer ([^\s,]+)$/iu.exec(request.headers.get("authorization") ?? "")?.[1];
    if (!token) return fault(401, "authentication_required", BEARER_CHALLENGE_HEADERS);
    if (inFlight >= options.maxInFlight) return fault(429, "query_overloaded", OVERLOAD_HEADERS);

    inFlight++;
    const signal = AbortSignal.any([request.signal, AbortSignal.timeout(timeoutMs)]);
    const deadlineAt = Date.now() + timeoutMs;
    const work = (async () => {
      try {
        signal.throwIfAborted();
        const personId = await authorizeRepository(options.authorizer, token, repoId, signal);
        const scope = repositories.get(repoId);
        if (!scope) throw new QueryFault(404, "repository_not_found");
        const value = await withPgProjectionReadSession(
          options.pool,
          { scope, repoId, signal, deadlineAt },
          (projection) => route(projection, { search: url.searchParams, personId }),
        );
        signal.throwIfAborted();
        return Response.json(value, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        if (signal.aborted) return aborted(request);
        if (error instanceof QueryFault) {
          return fault(error.status, error.code, error.status === 401 ? BEARER_CHALLENGE_HEADERS : []);
        }
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (code === "task_not_found") return fault(404, code);
        if (code === "57014") return fault(504, "query_timeout");
        if (code === "identity_unavailable" || code === "daemon_error") return fault(503, "identity_unavailable");
        options.onError?.(error);
        return fault(500, "query_failed");
      } finally {
        inFlight--;
      }
    })();
    // A timed-out request still owns its admission slot until any in-flight IO and rollback settle.
    if (signal.aborted) {
      void work.catch(consumeKnownError);
      return aborted(request);
    }
    const cancellation = Promise.withResolvers<Response>();
    const cancel = () => cancellation.resolve(aborted(request));
    signal.addEventListener("abort", cancel, { once: true });
    try {
      return await Promise.race([work, cancellation.promise]);
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
}

async function authorizeRepository(
  authorizer: CloudQueryAuthorizer,
  token: string,
  repoId: string,
  signal: AbortSignal,
): Promise<string> {
  const decision = await authorizer.authorizeRepositoryRead({ token, repoId, signal });
  if (decision.outcome === "unauthenticated") throw new QueryFault(401, "authentication_required");
  if (decision.outcome === "unavailable") throw new QueryFault(503, "identity_unavailable");
  if (decision.outcome !== "allowed") throw new QueryFault(403, "authorization_denied");
  if (!decision.personId || decision.personId.includes("/")) throw new QueryFault(401, "authentication_required");
  return decision.personId;
}

function isWithinBounds(value: number, minimum: number, maximum: number): boolean {
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function page(search: URLSearchParams) {
  const limitValue = search.get("limit"),
    limit = limitValue === null ? undefined : Number(limitValue),
    cursor = search.get("cursor") ?? undefined,
    { minimumRows, pageSizes } = storageReadPolicy.defaultValue;
  if (
    (limit !== undefined && !isWithinBounds(limit, minimumRows, pageSizes.standard)) ||
    (cursor !== undefined && (!cursor || cursor.length > pageSizes.summaries))
  )
    throw new QueryFault(400, "invalid_page");
  return { ...(limit === undefined ? {} : { limit }), ...(cursor === undefined ? {} : { cursor }) };
}

class QueryFault extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function aborted(request: Request): Response {
  return request.signal.aborted ? fault(499, "request_cancelled") : fault(504, "query_timeout");
}

function fault(status: number, code: string, extraHeaders: ReadonlyArray<readonly [string, string]> = []): Response {
  const headers = new Headers([
    ["cache-control", "no-store"],
    ...extraHeaders.map(([name, value]): [string, string] => [name, value]),
  ]);
  return Response.json({ error: { code } }, { status, headers });
}
