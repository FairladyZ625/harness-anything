export const CONNECTION_STATUS_CHANNEL = "harness:connections:status";
export const CONNECTION_PROBE_CHANNEL = "harness:connections:probe";
export const CONNECTION_REGISTER_CHANNEL = "harness:connections:register";
export const CONNECTION_UPDATE_CHANNEL = "harness:connections:update";
export const CONNECTION_UNREGISTER_CHANNEL = "harness:connections:unregister";
export const REPO_REGISTER_CHANNEL = "harness:repos:register";
export const REPO_UPDATE_CHANNEL = "harness:repos:update";
export const REPO_UNREGISTER_CHANNEL = "harness:repos:unregister";
export const WORKSPACE_INSPECT_CHANNEL = "harness:repos:inspectWorkspace";

/** registry v2 的连接形态(kernel daemon-registry/v2;local 为隐含连接,永远存在)。 */
export type AdminConnectionKind = "local" | "remote-endpoint" | "fleet-center";
export type AdminRegistrationState = "enabled" | "disabled";
export type AdminRepoMode = "local" | "remote-proxy" | "remote-center" | "remote-edge";

export interface AdminConnectionRow {
  readonly id: string;
  readonly kind: AdminConnectionKind;
  readonly displayName: string;
  readonly state: AdminRegistrationState;
  readonly endpoint?: string;
}

/** `daemon.connection.probe` 成功结果:对端 hello 的版本事实 + daemon.status 的仓列表。 */
export interface ConnectionProbeSuccess {
  readonly ok: true;
  readonly endpoint: string;
  readonly protocolVersion: { readonly major: number; readonly minor: number };
  readonly build: { readonly commit: string | null };
  readonly repos: ReadonlyArray<{
    readonly repoId: string;
    readonly mode: AdminRepoMode | null;
    readonly state: string;
  }>;
}

/** daemon admin 命令的 command-receipt/v2 成功回执(闭字段,daemon 是唯一事实源)。 */
export interface AdminReceipt {
  readonly schema: "command-receipt/v2";
  readonly ok: boolean;
  readonly command: string;
  readonly outcome: string;
  readonly opId?: string;
  readonly repo?: Record<string, unknown>;
  readonly connection?: AdminConnectionRow;
  readonly changed?: boolean;
  readonly error?: { readonly code: string; readonly hint: string } | null;
  readonly summary?: string;
}

export interface WorkspaceInspectResult {
  readonly ok: true;
  readonly rootDir: string;
  /** 选中的文件夹已有台账(.harness 目录)时为 true:走注册;否则走 bootstrap。 */
  readonly hasWorkspace: boolean;
  readonly suggestedRepoId: string;
}

export interface ConnectionAdminApi {
  readonly status: () => Promise<AdminStatusResult>;
  readonly probe: (input: { readonly endpoint: string }) => Promise<ConnectionProbeSuccess | AdminProtocolError>;
  readonly register: (input: {
    readonly connectionId?: string;
    readonly displayName?: string;
    readonly endpoint: string;
  }) => Promise<AdminReceipt>;
  readonly update: (input: {
    readonly connectionId: string;
    readonly displayName?: string;
    readonly endpoint?: string;
    readonly state?: AdminRegistrationState;
  }) => Promise<AdminReceipt>;
  readonly unregister: (input: { readonly connectionId: string }) => Promise<AdminReceipt>;
}

export interface RepoAdminApi {
  readonly register: (input: {
    readonly repoId?: string;
    readonly rootDir?: string;
    readonly displayName?: string;
    readonly mode?: AdminRepoMode;
    readonly endpoint?: string;
    readonly connectionId?: string;
  }) => Promise<AdminReceipt>;
  readonly update: (input: {
    readonly repoId: string;
    readonly displayName?: string;
    readonly mode?: AdminRepoMode;
    readonly endpoint?: string;
    readonly connectionId?: string;
    readonly state?: AdminRegistrationState;
  }) => Promise<AdminReceipt>;
  readonly unregister: (input: { readonly repoId: string }) => Promise<AdminReceipt>;
  readonly inspectWorkspace: (input: { readonly rootDir: string }) => Promise<WorkspaceInspectResult>;
}

export type AdminStatusResult =
  | {
      readonly ok: true;
      readonly connections: readonly AdminConnectionRow[];
    }
  | AdminProtocolError;

export interface AdminProtocolError {
  readonly ok: false;
  readonly error: { readonly code: string; readonly hint: string };
}
