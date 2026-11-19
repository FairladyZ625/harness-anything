import { guiInteractionPolicy } from "@harness-anything/kernel/internal/domain/gui-interaction-policy.ts";
import { daemonRuntimePolicy } from "@harness-anything/kernel/internal/domain/cli-operational-policy.ts";
import { daemonClientFailureCode, daemonProtocolError } from "@harness-anything/daemon/client";
import type {
  DaemonTaskSnapshotListResult,
  DaemonStreamPayloadMap,
  DaemonStreamMethod,
  InteractiveRpcDescriptor,
} from "@harness-anything/daemon/protocol";
import { parseClientRpcResponse } from "@harness-anything/daemon/client";
import { guiDaemonReadOnly, guiDaemonUserRoot, guiGlobalDaemonTarget } from "./gui-daemon-target.ts";
import { interactiveRpcDescriptor } from "@harness-anything/daemon/protocol";
import { streamDaemonFacetAt } from "@harness-anything/daemon/client";
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
export interface GuiServiceBridge {
  readonly invoke: (method: string, params: JsonObject) => Promise<unknown>;
  readonly stream: (
    method: DaemonStreamMethod,
    params: {
      readonly repo: { readonly repoId: string };
      readonly payload: DaemonStreamPayloadMap[DaemonStreamMethod];
    },
    emit: (value: unknown) => void,
    signal: AbortSignal,
  ) => Promise<() => void>;
}

export function createLocalGuiServiceBridge(): GuiServiceBridge {
  return {
    invoke: async (method, params) => {
      const descriptor = interactiveRpcDescriptor(method);
      if (!descriptor)
        return failure(
          method,
          "Unsupported interactive RPC",
          Object.assign(new Error(method), { code: "method_not_allowed" }),
        );
      return request(descriptor, params);
    },
    stream: async (method, params, emit, signal) => {
      const daemon = await loadClient(),
        target = repoTarget(daemon, params.repo.repoId);
      return streamDaemonFacetAt({
        socketPath: target.socketPath,
        repoId: target.repoId,
        method,
        payload: params.payload,
        signal,
        onValue: emit,
        onClosed: (failure) =>
          emit({
            schema: "daemon-stream-failure/v1",
            code: failure.code,
            hint: failure.lastError,
          }),
      });
    },
  };
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
async function request(route: InteractiveRpcDescriptor, params: JsonObject): Promise<JsonObject> {
  try {
    const daemon = await loadClient(),
      scope = params.repo,
      repoId = scope && typeof scope === "object" && "repoId" in scope ? scope.repoId : undefined;
    if (guiDaemonReadOnly() && (!("commandClass" in route) || route.commandClass !== "repo-read"))
      return readOnlyFailure(route.method);
    const scopedTarget = typeof repoId === "string" ? repoTarget(daemon, repoId) : null,
      target = scopedTarget ?? globalTarget(),
      daemonPayload = (params.payload ?? {}) as JsonObject;
    const parse = (result: JsonObject) => {
      const parsed = parseClientRpcResponse(route.method, result);
      if (route.method === "repo.tasks.list" && parsed.ok === true)
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
          route.method,
          params,
          timeouts.connectTimeoutMs,
          requestTimeoutMs(route, daemonPayload, timeouts),
        );
    return parse(await invoke());
  } catch (error) {
    return failure(route.method, "Local daemon request failed", error);
  }
}
// The transport's own connect deadline is 75ms, tuned for the CLI which retries around it. The GUI
// never retries, and a daemon mid-write on its single event loop easily misses 75ms, so every
// contention blip used to read as "daemon unreachable" — raised to 2s (泽宇 2026-09-01/02) and now the
// local setting gui.connectTimeoutMs. The admin channel has no repository root to read settings
// from, so it keeps the declared default.
// Socket errors that mean no daemon is listening (missing socket file, nobody accepting).
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
  const code = daemonClientFailureCode(error);
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
const BOOTSTRAP_TIMEOUT_MS = guiInteractionPolicy.defaultValue.deadlines.bootstrap;
// Instance create/update with an API key dials the provider before answering.
const INSTANCE_KEY_TIMEOUT_MS = guiInteractionPolicy.defaultValue.deadlines.instanceKey;
// Repository writes publish through the coordinator and may include SQLite/WAL plus authored-file
// materialization. Timing them out at the short read deadline leaves an ambiguous durable write.
const REPO_WRITE_TIMEOUT_MS = guiInteractionPolicy.defaultValue.deadlines.repoWrite;
const INSTANCE_OP_TIMEOUT_MS = guiInteractionPolicy.defaultValue.deadlines.instanceOperation;
const INSTANCE_SHOW_TIMEOUT_MS = guiInteractionPolicy.defaultValue.deadlines.instanceShow;
// Account refresh can run model listing and quota sequentially, each with the provider's
// model-listing budget, in addition to installation discovery and receipt publication.
const INSTANCE_PROBE_TIMEOUT_MS =
  INSTANCE_OP_TIMEOUT_MS + 2 * daemonRuntimePolicy.defaultValue.runtime.subscriptionProbeTimeoutMs.modelListing;

function requestTimeoutMs(route: InteractiveRpcDescriptor, payload: JsonObject, timeouts: GuiRequestTimeouts): number {
  if (
    [
      "daemon.runtimeInstance.create",
      "daemon.runtimeInstance.update",
      "daemon.provider.create",
      "daemon.provider.update",
    ].includes(route.method) &&
    payload.apiKey !== undefined
  )
    return INSTANCE_KEY_TIMEOUT_MS;
  if ("commandClass" in route && route.commandClass === "repo-write") return REPO_WRITE_TIMEOUT_MS;
  if (route.method === "daemon.runtimeInstance.show" && payload.probe === true) return INSTANCE_PROBE_TIMEOUT_MS;
  if (
    route.method === "daemon.runtimeInstance.create" ||
    route.method === "daemon.runtimeInstance.update" ||
    route.method === "daemon.runtimeInstance.delete" ||
    route.method === "daemon.runtimeInstance.list" ||
    route.method === "repo.runtimeInstance.auth.login" ||
    route.method === "repo.runtimeInstance.auth.logout"
  )
    return INSTANCE_OP_TIMEOUT_MS;
  if (route.method === "daemon.runtimeInstance.show") return INSTANCE_SHOW_TIMEOUT_MS;
  // Reads share the daemon with the single-writer queue; sustained ledger writes hold the
  // workspace for seconds at a time, so any deadline that undercuts a normal write window
  // turns ordinary contention into a visible GUI error (200ms, 2s and 10s all did, live;
  // 泽宇 2026-09-01/02 三次亲裁调高). Connection-level failures still surface within
  // the connect deadline through the socket connect path.
  return timeouts.requestTimeoutMs;
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
