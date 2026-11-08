import { daemonProtocolError, isDaemonGuiActionMethod, isDaemonGuiReadMethod } from "@harness-anything/daemon/client";
import type { DaemonTaskSnapshotListResult, DaemonStreamPayloadMap } from "@harness-anything/daemon/protocol";
import {
  parseDaemonGuiActionResponse,
  parseDaemonGuiReadResponse,
  parseDaemonGuiReadResult,
} from "@harness-anything/daemon/client";
import { guiDaemonReadOnly, guiDaemonUserRoot, guiGlobalDaemonTarget } from "./gui-daemon-target.ts";
import { createGuiServiceBridgeForDaemon, type GuiServiceBridge, type ShippedGuiRoute } from "../api/service-bridge.ts";
import { streamDaemonFacetAt } from "./agent-runtime-stream-client.ts";
import type { FirstRunBootstrapInput } from "../api/first-run-contract.ts";
import { defaultRegistryReader, resolveRepoScopedTarget } from "./repo-scoped-target.ts";
import { DEFAULT_GUI_CONNECT_TIMEOUT_MS, guiRequestTimeouts, type GuiRequestTimeouts } from "./gui-local-settings.ts";
type JsonObject = { readonly [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonObject | ReadonlyArray<JsonValue>;
interface DaemonClient {
  readonly resolveLocalDaemonTargetFromRepos: (
    input: { readonly rootDir: string; readonly repoIdOverride?: string; readonly userRoot?: string },
    repos: ReturnType<typeof defaultRegistryReader>["repos"],
  ) => {
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
// 没有 layout 覆写入口:GUI 的每一次读写都走 daemon JSON-RPC,authored root 由 daemon 按
// 目标仓库自己的 harness.yaml 解析(非默认 authoredRoot 也因此照常可读)。GUI 侧再开一个
// 覆写参数只会让人以为它能改别人的 authored root。
// 根目录不归主进程持有:每条仓库级请求用自己的 repoId 解析它,窗口内换项目后下一次请求
// 就是新项目。启动时捕获的 HARNESS_GUI_ROOT 会让旧根在换项目后继续被校验(issue #4267)。
export function createLocalGuiServiceBridge(): GuiServiceBridge {
  return createGuiServiceBridgeForDaemon(
    (route, payload) => request(route, payload),
    async (route, payload, emit) => {
      const daemon = await loadClient(),
        scoped = repoPayload(payload),
        target = repoTarget(daemon, scoped.repoId);
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
  if (guiDaemonReadOnly()) return readOnlyFailure("daemon.repo.bootstrap");
  const target = globalTarget();
  try {
    const daemon = await loadClient();
    const invoke = () =>
      daemon.requestLocalDaemonJsonRpcForTarget(
        target,
        "daemon.repo.bootstrap",
        input as unknown as JsonObject,
        guiRequestTimeouts(input.rootDir).connectTimeoutMs,
        BOOTSTRAP_TIMEOUT_MS,
      );
    return await invoke();
  } catch (error) {
    return failure("init", "Repository setup failed", error);
  }
}
async function request(route: ShippedGuiRoute, payload: unknown): Promise<JsonObject> {
  try {
    const daemon = await loadClient(),
      scoped =
        route.requiresRepo ||
        (route.rpcMethod.startsWith("daemon.runtimeInstance.") &&
          payload !== null &&
          typeof payload === "object" &&
          "repoId" in payload)
          ? repoPayload(payload)
          : null;
    if (guiDaemonReadOnly() && route.commandClass !== "repo-read")
      return failure(
        route.rpcMethod,
        "GUI read-only daemon attachment rejects write operations",
        Object.assign(new Error("gui_read_only"), { code: "gui_read_only" }),
      );
    const scopedTarget = scoped ? repoTarget(daemon, scoped.repoId) : null,
      target = scopedTarget ?? globalTarget();
    const daemonPayload = scoped?.payload ?? ((payload ?? {}) as JsonObject);
    const body: JsonObject = route.inputSchemaId === "gui.empty/v1" ? {} : { payload: daemonPayload },
      params: JsonObject = scoped ? { repo: { repoId: scoped.repoId }, ...body } : body;
    const parse = (result: JsonObject) => {
      const parsed = (isDaemonGuiActionMethod(route.rpcMethod)
        ? parseDaemonGuiActionResponse(route.rpcMethod, result)
        : route.rpcMethod === "daemon.gui.control.receipt"
          ? parseDaemonGuiReadResult(route.rpcMethod, result)
          : isDaemonGuiReadMethod(route.rpcMethod)
            ? parseDaemonGuiReadResponse(route.rpcMethod, result)
            : result) as unknown as JsonObject;
      if (route.rpcMethod === "repo.tasks.list" && parsed.ok === true)
        reportInvalidTaskSnapshotRows(parsed as unknown as DaemonTaskSnapshotListResult);
      return parsed;
    };
    // Repository-scoped reads take their deadlines from the repository that answered, so a
    // window switch also switches the settings file. Global reads have no repository and use
    // the declared defaults.
    const timeouts = guiRequestTimeouts(scopedTarget?.canonicalRoot ?? null),
      invoke = () =>
        daemon.requestLocalDaemonJsonRpcForTarget(
          target,
          route.rpcMethod,
          params,
          timeouts.connectTimeoutMs,
          requestTimeoutMs(route, daemonPayload, timeouts),
        );
    return parse(await invoke());
  } catch (error) {
    return failure(route.rpcMethod, "Local daemon request failed", error);
  }
}
// The transport's own connect deadline is 75ms, tuned for the CLI which retries around it. The GUI
// never retries, and a daemon mid-write on its single event loop easily misses 75ms, so every
// contention blip used to read as "daemon unreachable" — raised to 2s (泽宇 2026-09-01/02) and now the
// local setting gui.connectTimeoutMs. The admin channel has no repository root to read settings
// from, so it keeps the declared default.
// Socket errors that mean no daemon is listening (missing socket file, nobody accepting).
const SOCKET_ABSENT_CODES = new Set(["ENOENT", "ECONNREFUSED", "ENOTSOCK", "EACCES"]);
// Only a socket-level miss means the daemon is absent; a slow or rejected answer came from a live
// daemon and must keep its own code, otherwise every failure prints the attach-only advice.
function failure(method: string, prefix: string, error: unknown): JsonObject {
  const message = error instanceof Error ? error.message : String(error);
  if (isClientContractFailure(error)) {
    // The transport answered; this validation ran inside the GUI bundle. Reporting it as a daemon
    // request failure sent operators to restart the daemon while the actual stale side was the GUI.
    const hint =
      `The GUI rejected the daemon answer during client-side contract validation, so the request did not fail in the daemon. ` +
      `Cause: ${message} The running GUI bundle may predate the daemon: rebuild it with ` +
      "`npm run build -w @harness-anything/gui` and restart Electron (a running window keeps its old bundle).";
    const receipt = daemonProtocolError(method, "gui_result_contract_mismatch", hint);
    return { ...receipt, error: { ...receipt.error, hint } } as unknown as JsonObject;
  }
  const rawCode = error instanceof Error ? (error as { readonly code?: unknown }).code : undefined,
    raw = typeof rawCode === "string" ? rawCode : null,
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
      : code === "daemon_method_unavailable" || code === "method_not_found"
        ? [
            `${prefix}. Cause: ${message}`,
            "The GUI and attached local daemon expose different RPC method sets.",
            "Restart the resident daemon from an operator shell, or run `ha gui` to use the canonical GUI build.",
          ].join(" ")
        : `${prefix}. Cause: ${message}`;
  const receipt = daemonProtocolError(method, code, hint);
  return { ...receipt, error: { ...receipt.error, hint } } as unknown as JsonObject;
}
function isClientContractFailure(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.name === "DaemonProtocolContractError" &&
    (error as { readonly code?: unknown }).code === "invalid_result"
  );
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
// The registry has no transport timeouts; the specialized deadlines below have never been tuned and
// stay named constants with their reasons. The default read deadline is the local setting.
// First-run repository setup runs package installs.
const BOOTSTRAP_TIMEOUT_MS = 75_000;
// Instance create/update with an API key dials the provider before answering.
const INSTANCE_KEY_TIMEOUT_MS = 75_000;
// Repository writes publish through the coordinator and may include SQLite/WAL plus authored-file
// materialization. Timing them out at the short read deadline leaves an ambiguous durable write.
const REPO_WRITE_TIMEOUT_MS = 20_000;
const INSTANCE_OP_TIMEOUT_MS = 20_000;
const INSTANCE_SHOW_TIMEOUT_MS = 2_000;
const SESSION_AUTH_TIMEOUT_MS = 1_000;

function requestTimeoutMs(route: ShippedGuiRoute, payload: JsonObject, timeouts: GuiRequestTimeouts): number {
  if (
    ["createRuntimeInstance", "updateRuntimeInstance", "createDecisionProvider", "updateDecisionProvider"].includes(
      route.guiBridgeMethod,
    ) &&
    payload.apiKey !== undefined
  )
    return INSTANCE_KEY_TIMEOUT_MS;
  if (route.commandClass === "repo-write") return REPO_WRITE_TIMEOUT_MS;
  if (
    route.guiBridgeMethod === "createRuntimeInstance" ||
    route.guiBridgeMethod === "updateRuntimeInstance" ||
    route.guiBridgeMethod === "deleteRuntimeInstance" ||
    route.guiBridgeMethod === "listRuntimeInstances" ||
    (route.guiBridgeMethod === "showRuntimeInstance" && payload.probe === true)
  )
    return INSTANCE_OP_TIMEOUT_MS;
  if (route.guiBridgeMethod === "showRuntimeInstance") return INSTANCE_SHOW_TIMEOUT_MS;
  if (["signInRuntimeInstance", "signOutRuntimeInstance"].includes(route.guiBridgeMethod))
    return SESSION_AUTH_TIMEOUT_MS;
  // Reads share the daemon with the single-writer queue; sustained ledger writes hold the
  // workspace for seconds at a time, so any deadline that undercuts a normal write window
  // turns ordinary contention into a visible GUI error (200ms, 2s and 10s all did, live;
  // 泽宇 2026-09-01/02 三次亲裁调高). Connection-level failures still surface within
  // the connect deadline through the socket connect path.
  return timeouts.requestTimeoutMs;
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
  return guiGlobalDaemonTarget();
}

/**
 * repo 作用域 target:local 仓走严格判定,启用中的 remote-proxy 仓回退全局 socket(见 repo-scoped-target.ts)。
 * rootDir 从请求自己的 repoId 在 registry 里取 —— 进程启动时捕获的根目录会在窗口换项目后过期。
 * 停用的 repoId 仍交给 resolver 产生原有错误码;未登记的直接给出同一错误码,避免占位根
 * 先触发 invalid_root。userRoot 只作不会过期的 bind 基准。
 */
function repoTarget(
  daemon: DaemonClient,
  repoId: string,
): ReturnType<DaemonClient["resolveLocalDaemonTargetFromRepos"]> {
  return resolveRepoScopedTarget(
    () => {
      const repos = defaultRegistryReader().repos,
        repo = repos.find((candidate) => candidate.repoId === repoId);
      // No registry row means no root to bind. Fail with the registry's own code instead of
      // handing its resolver a placeholder path, which would surface as invalid_root.
      if (repo === undefined)
        throw Object.assign(
          new Error(`workspace is not registered; run ha daemon repo register --repo-id ${repoId} --root <workspace>`),
          { code: "workspace_not_registered" },
        );
      return daemon.resolveLocalDaemonTargetFromRepos(
        {
          rootDir: repo.canonicalRoot ?? guiDaemonUserRoot(),
          repoIdOverride: repoId,
          userRoot: guiDaemonUserRoot(),
        },
        repos,
      );
    },
    defaultRegistryReader,
    globalTarget,
    repoId,
  ) as ReturnType<DaemonClient["resolveLocalDaemonTargetFromRepos"]>;
}

/** Settings → 仓库与连接 的 admin 通道:同一 one-shot 客户端直达本机 daemon 的 admin RPC。 */
export async function requestDaemonAdminRpc(method: string, params: JsonObject): Promise<JsonObject> {
  if (guiDaemonReadOnly() && method !== "daemon.connection.probe") return readOnlyFailure(method);
  return daemonRpc(globalTarget(), method, params);
}

/** repo 作用域的一次性 RPC(主进程侧消费,如产物物化副本的正文读取)。 */
export async function requestRepoScopedRpc(repoId: string, method: string, params: JsonObject): Promise<JsonObject> {
  if (guiDaemonReadOnly() && method !== "repo.tasks.document.read") return readOnlyFailure(method);
  const daemon = await loadClient();
  return daemonRpc(repoTarget(daemon, repoId), method, params);
}

async function daemonRpc(
  target: { readonly socketPath: string },
  method: string,
  params: JsonObject,
): Promise<JsonObject> {
  const daemon = await loadClient();
  try {
    return await daemon.requestLocalDaemonJsonRpcForTarget(
      target,
      method,
      params,
      DEFAULT_GUI_CONNECT_TIMEOUT_MS,
      20_000,
    );
  } catch (error) {
    return failure(method, "Local daemon request failed", error);
  }
}
async function loadClient(): Promise<DaemonClient> {
  client ??= import("@harness-anything/daemon/client") as Promise<DaemonClient>;
  return client;
}

function readOnlyFailure(method: string): JsonObject {
  const receipt = daemonProtocolError(
    method,
    "gui_read_only",
    "GUI read-only daemon attachment rejects write operations.",
  );
  return receipt as unknown as JsonObject;
}
