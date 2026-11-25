import path from "node:path";
import { readPersonalAgendaAwaitsFromAsyncProjection } from "@harness-anything/application/internal/queries/agenda-awaits-read.ts";
import { readCollaboratorTaskPageFromAsyncProjection } from "@harness-anything/application/internal/queries/collaborator-reads.ts";
import { readClaimableTasks } from "@harness-anything/application/internal/queries/task-claimable-read.ts";
import {
  readCompletionDeliveryStatus,
  readTaskCompletion,
} from "@harness-anything/application/internal/queries/task-completion-read.ts";
import {
  taskListPayload,
  withWorkspacePackagePaths,
} from "@harness-anything/application/internal/queries/task-list-read.ts";
import { makeTaskQueryReadModel } from "@harness-anything/application/internal/queries/task-query-read.ts";
import { queryCodedError } from "@harness-anything/application/internal/queries/task-query-ports.ts";
import {
  mergeRepositoryLocalSettings,
  readEffectiveCloseoutGates,
  readRepositorySettings,
} from "@harness-anything/application/internal/queries/task-settings-read.ts";
import { taskShowFromProjection } from "@harness-anything/application/internal/queries/task-show-read.ts";
import {
  projectedTaskSettings,
  resolveTaskRootThreshold,
} from "@harness-anything/application/internal/queries/task-wip-settings.ts";
import { workTopologyFromAsyncProjection } from "@harness-anything/application/internal/queries/work-topology-read.ts";
import { workspaceSummaryFromProjectionRead } from "@harness-anything/application/internal/queries/workspace-summary-read.ts";
import {
  blockingOf,
  closeoutReadiness,
  localSettings,
  SETTINGS_ID,
  type AssignmentRelationLike,
  type TaskProjectionListQuery,
} from "@harness-anything/kernel";
import { consumeKnownError } from "@harness-anything/kernel/internal/error-consumption";
import { storageReadPolicy } from "@harness-anything/kernel/internal/domain/storage-read-policy.ts";
import { withPgProjectionReadSession } from "@harness-anything/storage/pg/read-only";
import { createPgTaskQueryReader, type PgTaskQueryReader } from "../../../storage/src/pg/pg-task-query-reader.ts";
import type { PgTaskQueryMethods } from "../../../storage/src/pg/pg-task-query-contract.ts";
import { createCloudDomainRoutes } from "./cloud-domain-routes.ts";

type ReadSession = Parameters<typeof withPgProjectionReadSession>[1];
type Projection = Parameters<Parameters<typeof withPgProjectionReadSession>[2]>[0];
type QueryContext = {
  readonly search: URLSearchParams;
  readonly personId: string;
  readonly claim: CloudTaskClaimGrant | null;
};
type Route = (projection: Projection, context: QueryContext) => Promise<unknown>;
type SyncRoute = (queries: PgTaskQueryMethods, context: QueryContext) => unknown;

export interface CloudTaskClaimGrant {
  readonly claimant: {
    readonly personId: string;
    readonly nodeId: string | null;
    readonly teamIds: readonly string[];
  };
  readonly authorizeRepository: () => Promise<{ readonly outcome: string; readonly reasonCode?: string }>;
  readonly authorizeTask: (taskId: string) => Promise<{ readonly outcome: string }>;
}

/** A node with no checkout. Layout discovery starts here and must not assume a task worktree exists. */
const STATELESS_ROOT = path.join(path.parse(process.cwd()).root, "harness-stateless-query");
const TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/u;

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
  [
    "task-claimable",
    async (projection, { claim }) => {
      if (claim === null) throw new QueryFault(503, "claim_authorization_unavailable");
      const row = await projection.getEntity("settings", SETTINGS_ID);
      const settings = mergeRepositoryLocalSettings(
        readRepositorySettings({ getEntity: () => row }),
        localSettings({}),
      );
      return readClaimableTasks({
        settings,
        now: new Date().toISOString(),
        page: (query) => projection.list(query),
        readAssignments: async () =>
          assignmentRelations(await projection.readRelationQuery({ relationType: "assigned-to" })),
        claimant: claim.claimant,
        authorizeRepository: claim.authorizeRepository,
        authorizeTask: claim.authorizeTask,
        codedError: queryCodedError,
      });
    },
  ],
]);

const syncRoutes = new Map<string, SyncRoute>([
  [
    "task-list",
    (queries, { search }) => {
      const { payload } = taskListPayload(
        {
          readTaskIndex: queries.readTaskIndex,
          readTaskChildCounts: queries.readTaskChildCounts,
          rootThreshold: resolveTaskRootThreshold(projectedTaskSettings(queries), {}).threshold,
        },
        listQuery(search),
        listAction(search),
        queryCodedError,
      );
      return withWorkspacePackagePaths(STATELESS_ROOT, payload);
    },
  ],
  [
    "tasks",
    (queries, { search }) =>
      makeTaskQueryReadModel({
        rootDir: STATELESS_ROOT,
        projection: queries,
        readPinnedEntities: (query) => queries.listPinnedEntities(query),
        ports: {},
        judgments: cloudTaskJudgments(queries),
      }).guiTasks(listQuery(search)),
  ],
  [
    "task-show",
    (queries, { search }) =>
      taskShowFromProjection(
        STATELESS_ROOT,
        queries,
        requiredTaskId(search),
        undefined,
        undefined,
        "include_done",
        {},
        {},
      ),
  ],
  [
    "task-completion",
    (queries, { search }) => readTaskCompletion(queries, requiredTaskId(search), STATELESS_ROOT, undefined, {}),
  ],
]);

export interface CloudQueryHostOptions {
  readonly pool: Parameters<typeof withPgProjectionReadSession>[0];
  readonly authorizer: CloudQueryAuthorizer;
  /** Deployment-owned repository admission. Values determine the PG tenant, project, epoch and reader scope. */
  readonly repositories: ReadonlyMap<string, ReadSession["scope"]>;
  /** Optional reader factory for embedded PG/PGlite or test hosts without a TCP connection string. */
  readonly openQueryReader?: (input: {
    readonly repoId: string;
    readonly scope: ReadSession["scope"];
  }) => PgTaskQueryReader;
  /** Task-start authority. Absent means claimable reads fail closed; repository-read is not task-start. */
  readonly authorizeTaskClaim?: (input: {
    readonly token: string;
    readonly repoId: string;
    readonly personId: string;
    readonly signal: AbortSignal;
  }) => Promise<CloudTaskClaimGrant>;
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
  const readers = new Map<string, PgTaskQueryReader>();
  const readerRoutes = createCloudDomainRoutes((status, code) => new QueryFault(status, code));
  let inFlight = 0;
  return async (request) => {
    const url = new URL(request.url);
    const match = /^\/v1\/repositories\/([A-Za-z0-9._-]{1,256})\/([a-z-]+)$/u.exec(url.pathname);
    const routeName = match?.[2];
    const route = routeName === undefined ? undefined : routes.get(routeName);
    const syncRoute = routeName === undefined ? undefined : syncRoutes.get(routeName);
    const readerRoute = routeName === undefined ? undefined : readerRoutes.get(routeName);
    if (!match || (route === undefined && syncRoute === undefined && readerRoute === undefined))
      return fault(404, "route_not_found");
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
        const claimableRoute = routeName === "task-claimable";
        if (claimableRoute && !options.authorizeTaskClaim) throw new QueryFault(503, "claim_authorization_unavailable");
        const claim =
          claimableRoute && options.authorizeTaskClaim
            ? await options.authorizeTaskClaim({ token, repoId, personId, signal })
            : null;
        const context = { search: url.searchParams, personId, claim };
        const value = readerRoute
          ? readerRoute(taskReader(readers, options.pool, repoId, scope, options.openQueryReader), {
              repoId,
              statelessRoot: STATELESS_ROOT,
              search: url.searchParams,
              personId,
            })
          : syncRoute
            ? taskReader(readers, options.pool, repoId, scope, options.openQueryReader).withSession(
                (queries: PgTaskQueryMethods) => syncRoute(queries, context),
              )
            : await withPgProjectionReadSession(
                options.pool,
                { scope, repoId, signal, deadlineAt },
                (projection: Projection) => route!(projection, context),
              );
        signal.throwIfAborted();
        return Response.json(value, { headers: { "cache-control": "no-store" } });
      } catch (error) {
        if (signal.aborted) return aborted(request);
        if (error instanceof QueryFault) {
          return fault(error.status, error.code, error.status === 401 ? BEARER_CHALLENGE_HEADERS : []);
        }
        const code = error instanceof Error && "code" in error ? error.code : undefined;
        if (
          code === "task_not_found" ||
          code === "settings_entity_missing" ||
          code === "document_not_found" ||
          code === "squad_run_not_found" ||
          code === "entity_not_found"
        )
          return fault(404, code);
        if (code === "task_ambiguous_id" || code === "content_changed") return fault(409, code);
        if (
          code === "invalid_command" ||
          code === "invalid_task_id" ||
          code === "invalid_squad_run_id" ||
          code === "invalid_request"
        )
          return fault(400, code);
        if (code === "authorization_denied") return fault(403, code);
        if (
          code === "projection_pending" ||
          code === "claim_authorization_unavailable" ||
          code === "query_store_unavailable" ||
          code === "replica_unavailable"
        )
          return fault(503, code);
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

function taskReader(
  readers: Map<string, PgTaskQueryReader>,
  pool: { readonly options?: { readonly connectionString?: unknown } },
  repoId: string,
  scope: ReadSession["scope"],
  openQueryReader?: CloudQueryHostOptions["openQueryReader"],
): PgTaskQueryReader {
  const cached = readers.get(repoId);
  if (cached) return cached;
  if (openQueryReader) {
    const reader = openQueryReader({ repoId, scope });
    readers.set(repoId, reader);
    return reader;
  }
  const connectionString = pool.options?.connectionString;
  if (typeof connectionString !== "string" || connectionString.length === 0)
    throw new QueryFault(503, "query_store_unavailable");
  const reader = createPgTaskQueryReader({ connectionString, scope, repoId });
  readers.set(repoId, reader);
  return reader;
}

function cloudTaskJudgments(queries: PgTaskQueryMethods) {
  return {
    closeout: (
      snapshot: Parameters<typeof closeoutReadiness>[0],
      availability: Parameters<typeof closeoutReadiness>[1],
      _gates: Parameters<typeof closeoutReadiness>[2],
      _delivery: Parameters<typeof closeoutReadiness>[3],
      rootDir?: string,
    ) =>
      closeoutReadiness(
        snapshot,
        availability,
        readEffectiveCloseoutGates(queries, snapshot),
        readCompletionDeliveryStatus(queries, snapshot, rootDir),
      ),
    blocking: blockingOf,
  };
}

function listQuery(search: URLSearchParams): TaskProjectionListQuery {
  const status = optionalText(search, "status");
  const updatedAfter = optionalText(search, "updatedAfter");
  const updatedBefore = optionalText(search, "updatedBefore");
  const parent = search.get("parentTaskId");
  return {
    ...page(search),
    ...(status === undefined ? {} : { status }),
    ...(updatedAfter === undefined ? {} : { updatedAfter }),
    ...(updatedBefore === undefined ? {} : { updatedBefore }),
    ...(parent !== null && TASK_ID.test(parent) ? { parentTaskId: parent } : {}),
  } as TaskProjectionListQuery;
}

function listAction(search: URLSearchParams) {
  const parent = search.get("parentTaskId");
  const depth = search.get("depth");
  return {
    ...(depth === null ? {} : { depth }),
    ...(parent !== null && TASK_ID.test(parent) ? { parentTaskId: parent } : {}),
    ...namedText(search, "workKind"),
    ...namedText(search, "riskTier"),
    ...namedText(search, "urgency"),
    ...namedText(search, "search"),
  };
}

function optionalText(search: URLSearchParams, key: string): string | undefined {
  const value = search.get(key);
  if (value === null) return undefined;
  if (value.length === 0 || value.length > 256) throw new QueryFault(400, "invalid_command");
  return value;
}

function namedText(search: URLSearchParams, key: string): Record<string, string> {
  const value = optionalText(search, key);
  return value === undefined ? {} : { [key]: value };
}

function requiredTaskId(search: URLSearchParams): string {
  const taskId = search.get("taskId");
  if (taskId === null || !TASK_ID.test(taskId)) throw new QueryFault(400, "invalid_task_id");
  return taskId;
}

function assignmentRelations(page: {
  readonly rows: readonly AssignmentRelationLike[];
}): readonly AssignmentRelationLike[] {
  return page.rows.filter(
    (row) =>
      row.relationType === "assigned-to" &&
      typeof row.sourceRef === "string" &&
      typeof row.targetRef === "string" &&
      typeof row.rationale === "string",
  );
}

function fault(status: number, code: string, extraHeaders: ReadonlyArray<readonly [string, string]> = []): Response {
  const headers = new Headers([
    ["cache-control", "no-store"],
    ...extraHeaders.map(([name, value]): [string, string] => [name, value]),
  ]);
  return Response.json({ error: { code } }, { status, headers });
}
