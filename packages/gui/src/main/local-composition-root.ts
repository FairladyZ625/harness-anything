import path from "node:path";
import {
  daemonProtocolError,
  isDaemonGuiActionMethod,
  isDaemonGuiReadMethod,
  type DaemonTaskSnapshotListResult,
  type DaemonStreamPayloadMap,
} from "../../../daemon/src/protocol/daemon-protocol.contract.ts";
import {
  parseDaemonGuiActionResponse,
  parseDaemonGuiReadResponse,
  parseDaemonGuiReadResult,
} from "../../../daemon/src/protocol/gui-result-validation.ts";
import {
  daemonIdFromEnv,
  daemonUserRoot,
  resolveLocalDaemonEndpoint,
} from "../../../daemon/src/client/local-daemon-target.ts";
import { defaultProjectionWaitMs } from "../../../daemon/src/projection-readiness-wait.ts";
import { validateProjectPath } from "../api/local-api.ts";
import { createGuiServiceBridgeForDaemon, type GuiServiceBridge, type ShippedGuiRoute } from "../api/service-bridge.ts";
import { streamDaemonFacetAt } from "./agent-runtime-stream-client.ts";
import type { FirstRunBootstrapInput } from "../api/first-run-contract.ts";
type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface DaemonClient {
  readonly resolveLocalDaemonTarget: (input: { readonly rootDir: string; readonly repoIdOverride?: string }) => {
    readonly repoId: string;
    readonly socketPath: string;
    readonly canonicalRoot: string;
    readonly userRoot: string;
    readonly daemonId: string;
  };
  readonly requestLocalDaemonJsonRpcForTarget: (
    target: { readonly socketPath: string },
    method: string,
    params: JsonObject,
    timeoutMs?: number,
    responseTimeoutMs?: number,
  ) => Promise<JsonObject>;
}
let client: Promise<DaemonClient> | undefined;
export function createLocalGuiServiceBridge(
  rootDir: string,
  _layoutOverrides?: { readonly authoredRoot?: string },
): GuiServiceBridge {
  const root = path.resolve(rootDir);
  validateProjectPath(root, ".");
  return createGuiServiceBridgeForDaemon(
    (route, payload) => request(root, route, payload),
    async (route, payload, emit) => {
      const daemon = await loadClient(),
        scoped = repoPayload(payload),
        target = daemon.resolveLocalDaemonTarget({ rootDir: root, repoIdOverride: scoped.repoId });
      // A stream that exhausts its reconnect budget reaches the renderer through the same frame
      // channel a failed open already uses, so a lost pane says so instead of going quietly blank.
      return streamDaemonFacetAt({
        socketPath: target.socketPath,
        repoId: target.repoId,
        method: route.rpcMethod as keyof DaemonStreamPayloadMap,
        payload: scoped.payload as DaemonStreamPayloadMap[keyof DaemonStreamPayloadMap],
        onValue: emit,
        onClosed: (failure) =>
          emit({
            ok: false,
            code: failure.code,
            hint: `daemon stream lost after ${failure.attempts} reconnect attempts (${failure.lastError}); reopen the panel or restart the daemon.`,
          }),
      });
    },
  );
}
export async function bootstrapLocalRepository(input: FirstRunBootstrapInput): Promise<JsonObject> {
  const target = globalTarget();
  try {
    const daemon = await loadClient();
    const invoke = () =>
      daemon.requestLocalDaemonJsonRpcForTarget(
        target,
        "daemon.repo.bootstrap",
        input as unknown as JsonObject,
        CONNECT_TIMEOUT_MS,
        75_000,
      );
    return await invoke();
  } catch (error) {
    return failure("init", "Repository setup failed", error);
  }
}
async function request(rootDir: string, route: ShippedGuiRoute, payload: unknown): Promise<JsonObject> {
  try {
    const daemon = await loadClient(),
      scoped = route.requiresRepo ? repoPayload(payload) : null;
    const target = scoped
      ? daemon.resolveLocalDaemonTarget({ rootDir, repoIdOverride: scoped.repoId })
      : globalTarget();
    const daemonPayload = scoped?.payload ?? ((payload ?? {}) as JsonObject);
    const body: JsonObject = route.inputSchemaId === "gui.empty/v1" ? {} : { payload: daemonPayload },
      params: JsonObject = route.requiresRepo ? { repo: { repoId: scoped!.repoId }, ...body } : body;
    const parse = (result: JsonObject) => {
      const parsed = (isDaemonGuiActionMethod(route.rpcMethod)
        ? parseDaemonGuiActionResponse(route.rpcMethod, result)
        : route.rpcMethod === "daemon.gui.control.receipt"
          ? parseDaemonGuiReadResult(route.rpcMethod, result)
          : isDaemonGuiReadMethod(route.rpcMethod)
            ? parseDaemonGuiReadResponse(route.rpcMethod, result)
            : result) as unknown as JsonObject;
      if (route.rpcMethod === "repo.tasks.list")
        reportInvalidTaskSnapshotRows(parsed as unknown as DaemonTaskSnapshotListResult);
      return parsed;
    };
    const invoke = () =>
      daemon.requestLocalDaemonJsonRpcForTarget(
        target,
        route.rpcMethod,
        params,
        CONNECT_TIMEOUT_MS,
        requestTimeoutMs(route, daemonPayload),
      );
    return parse(await invoke());
  } catch (error) {
    return failure(route.rpcMethod, "Local daemon request failed", error);
  }
}
// The transport's own connect deadline is 75ms, tuned for the CLI which retries around it. The GUI
// never retries, and a daemon mid-write on its single event loop easily misses 75ms, so every
// contention blip used to read as "daemon unreachable". Match the CLI streaming path's 2s.
const CONNECT_TIMEOUT_MS = 2_000;
// Socket errors that mean no daemon is listening (missing socket file, nobody accepting).
const SOCKET_ABSENT_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EACCES"]);
// Only a socket-level miss means the daemon is absent; a slow or rejected answer came from a live
// daemon and must keep its own code, otherwise every failure prints the attach-only advice.
function failure(method: string, prefix: string, error: unknown): JsonObject {
  const message = error instanceof Error ? error.message : String(error),
    raw =
      error instanceof Error && typeof (error as { code?: unknown }).code === "string"
        ? (error as { code: string }).code
        : null,
    code =
      message === "daemon_unavailable" || (raw !== null && SOCKET_ABSENT_CODES.has(raw))
        ? "daemon_unavailable"
        : (raw ?? "daemon_request_failed");
  const hint =
    code === "daemon_unavailable"
      ? [
          `${prefix}. Cause: ${message}`,
          "The GUI is attach-only and never starts or restarts the daemon.",
          "Run `ha gui` from an operator shell to acquire the daemon through the CLI, then retry.",
        ].join(" ")
      : `${prefix}. Cause: ${message}`;
  return daemonProtocolError(method, code, hint) as unknown as JsonObject;
}

export function reportInvalidTaskSnapshotRows(
  result: Pick<DaemonTaskSnapshotListResult, "invalidRows">,
  warn: (message: string) => void = (message) => console.warn(message),
): void {
  for (const invalid of result.invalidRows)
    warn(
      [
        "[repo.tasks.list] isolated invalid task snapshot row",
        `rowIndex=${invalid.rowIndex}`,
        `taskId=${invalid.taskId}`,
        `field=${invalid.field}:`,
        invalid.message,
      ].join(" "),
    );
}
// The registry has no transport timeouts; keep the existing provider-tooling deadlines here.
function requestTimeoutMs(route: ShippedGuiRoute, payload: JsonObject): number {
  // Repository writes publish through the coordinator and may include SQLite/WAL plus authored-file
  // materialization. Timing them out at the short read deadline leaves an ambiguous durable write.
  if (route.commandClass === "repo-write") return 20_000;
  if (
    route.guiBridgeMethod === "createRuntimeInstance" ||
    route.guiBridgeMethod === "listRuntimeInstances" ||
    (route.guiBridgeMethod === "showRuntimeInstance" && payload.probe === true)
  )
    return 20_000;
  if (["showRuntimeInstance", "updateRuntimeInstance", "deleteRuntimeInstance"].includes(route.guiBridgeMethod))
    return 2_000;
  if (["signInRuntimeInstance", "signOutRuntimeInstance"].includes(route.guiBridgeMethod)) return 1_000;
  // Reads share the daemon with the single-writer queue; sustained ledger writes hold the
  // workspace for seconds at a time, so any deadline that undercuts a normal write window
  // turns ordinary contention into a visible GUI error (200ms and 2s both did, live).
  // The daemon may legitimately hold a read for its projection catch-up budget, so the GUI deadline
  // is that budget: anything shorter reports an honest catch-up as a failure (200ms, 2s and 10s all
  // did, live; 泽宇 2026-09-01/02 三次亲裁调高). Connection-level failures still surface within
  // CONNECT_TIMEOUT_MS through the socket connect path.
  return defaultProjectionWaitMs;
}
function repoPayload(value: unknown): { readonly repoId: string; readonly payload: JsonObject } {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Repository GUI request requires repoId.");
  const { repoId, ...payload } = value as Record<string, JsonValue>;
  if (typeof repoId !== "string" || !/^[a-z][a-z0-9-]{0,62}$/u.test(repoId))
    throw new Error("Repository GUI request has an invalid repoId.");
  return { repoId, payload };
}
function globalTarget() {
  const userRoot = daemonUserRoot(),
    daemonId = daemonIdFromEnv();
  return { socketPath: resolveLocalDaemonEndpoint({ userRoot, daemonId }), userRoot, daemonId };
}
async function loadClient(): Promise<DaemonClient> {
  client ??= import("../../../daemon/src/client/local-json-rpc-client.ts") as Promise<DaemonClient>;
  return client;
}
