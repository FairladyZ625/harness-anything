import type { RbacBackupStatus } from "@harness-anything/kernel/internal/domain/status-vocabulary.ts";

export const CENTER_SETTINGS_CHANNEL = "harness:center:settings";

export type CertificateMode = "self-signed" | "domain" | "internal-ca";

export interface CenterListenerSettings {
  readonly ok: true;
  readonly command: "rbac-listener";
  readonly listener: {
    readonly address: string;
    readonly hostname: string;
    readonly port: number;
    readonly certificateFile: string;
  } | null;
  readonly certificateMode: CertificateMode;
  readonly version: string;
}

export type CenterSettingsReply<T> =
  | T
  | {
      readonly ok: false;
      readonly code: string;
      readonly rejectionExplanation?: string;
    };

/** The fleet center service read (`daemon.fleet.center.read`): the live listener flag plus the saved start parameters. */
export interface CenterFleetStatus {
  readonly ok: true;
  readonly running: boolean;
  readonly port: number | null;
  readonly bind: string | null;
  readonly externalUrl: string | null;
  readonly repoId: string | null;
  readonly quotaBytes: number | null;
  readonly certificateSource: "login-listener" | "explicit" | null;
}

/**
 * One fleet center start. The TLS certificate is deliberately absent: the daemon reuses the
 * login service listener certificate when the start carries no pair, so no key path is ever
 * typed, stored, or displayed here.
 */
export interface CenterStartInput {
  readonly port: number;
  readonly repoId: string;
  readonly quotaBytes: number;
  readonly bind: string;
  readonly externalUrl?: string;
}

export type CenterSwitchPreflightCheckKind =
  | "trigger_source"
  | "node_identity"
  | "tls_reachable"
  | "replica_healthy"
  | "auth_reachable"
  | "symmetric_readiness";

export interface CenterSwitchPreflightCheck {
  readonly check: CenterSwitchPreflightCheckKind;
  readonly passed: boolean;
  readonly code: string;
  readonly detail: string;
}

export interface CenterSwitchPreflightResult {
  readonly ok: boolean;
  readonly checks: readonly CenterSwitchPreflightCheck[];
  readonly blockingCodes: readonly string[];
}

export type CenterSwitchInput =
  | {
      readonly repoId: string;
      readonly targetNodeId: string;
      readonly dryRun: boolean;
      readonly abortRollback?: false;
      readonly switchoverId?: string;
      readonly targetExternalUrl?: string;
      readonly targetLoginUrl?: string;
      readonly targetSpkiSha256?: string;
    }
  | {
      readonly repoId: string;
      readonly abortRollback: true;
      readonly switchoverId: string;
      readonly reason: string;
    };

export type CenterSwitchReply =
  | {
      readonly ok: true;
      readonly command?: string;
      readonly dryRun?: boolean;
      readonly phase?: string;
      readonly preflight?: CenterSwitchPreflightResult;
      readonly state?: {
        readonly switchoverId?: string;
        readonly oldEpoch?: number;
        readonly targetEpoch?: number;
        readonly phase?: string;
      };
      readonly activation?: {
        readonly switchoverId?: string;
        readonly newEpoch: number;
        readonly finalRevision?: number;
      };
      readonly demotion?: {
        readonly sourceNodeId?: string;
        readonly targetNodeId?: string;
        readonly newEpoch?: number;
        readonly mode?: string;
      };
      readonly rollback?: {
        readonly switchoverId?: string;
        readonly oldEpoch?: number;
        readonly cededEpoch?: number;
        readonly rollbackEpoch: number;
      };
      readonly summary?: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly phase?: string;
      readonly preflight?: CenterSwitchPreflightResult;
      readonly barrierIssues?: readonly string[];
      readonly fencedCeded?: boolean;
      readonly state?: {
        readonly switchoverId?: string;
        readonly oldEpoch?: number;
        readonly targetEpoch?: number;
      };
      readonly error?: {
        readonly code?: string;
        readonly hint?: string;
      };
      readonly rejectionExplanation?: string;
    };

export interface PromoteFromEdgeInput {
  readonly repoId: string;
  readonly forceNewEpoch: true;
  readonly confirmPossibleTailLoss: true;
  readonly rbacBackupStatus?: RbacBackupStatus;
}

export type PromoteFromEdgeReply =
  | {
      readonly ok: true;
      readonly command?: string;
      readonly repoId?: string;
      readonly oldEpoch?: number;
      readonly newEpoch: number;
      readonly finalRevision?: number;
      readonly replicationHistory?: string;
      readonly rbacBackupStatus?: string;
      readonly stoppedEdgeDaemon?: boolean;
      readonly registryMode?: string;
      readonly nextSteps?: readonly string[];
      readonly summary?: string;
      readonly nextAction?: string;
    }
  | {
      readonly ok: false;
      readonly code: string;
      readonly error?: {
        readonly code?: string;
        readonly hint?: string;
      };
      readonly rejectionExplanation?: string;
    };

/**
 * Purely local edge status summary for offline break-glass visibility.
 * Never carries machine credentials or certificate key material.
 */
export interface EdgeLocalState {
  readonly ok: true;
  readonly mode: string | null;
  readonly repoId: string;
  readonly nodeId: string | null;
  readonly configuredCenter: { readonly host: string; readonly port: number } | null;
  readonly localRevision: number | null;
  readonly localSequence: number | null;
  readonly writerEpoch: number | null;
  readonly syncFailureCode: string | null;
  readonly canPromote: boolean;
}

export interface CenterSettingsApi {
  readonly listener: () => Promise<CenterSettingsReply<CenterListenerSettings>>;
  readonly fleetStatus: () => Promise<CenterSettingsReply<CenterFleetStatus>>;
  readonly startCenter: (input: CenterStartInput) => Promise<
    CenterSettingsReply<{
      readonly ok: true;
      readonly port?: number;
      readonly externalAddressWarning?: string;
    }>
  >;
  readonly externalAddress: () => Promise<
    CenterSettingsReply<{ readonly ok: true; readonly externalUrl: string | null }>
  >;
  readonly setExternalAddress: (input: { readonly externalUrl: string }) => Promise<
    CenterSettingsReply<{
      readonly ok: true;
      readonly externalUrl: string;
      readonly warning?: string | null;
    }>
  >;
  readonly setCertificate: (input: {
    readonly expectedVersion: string;
    readonly certificateMode: CertificateMode;
    readonly hostname?: string;
    readonly listenAddress?: string;
    readonly port?: number;
    readonly certificateFile?: string;
    readonly certificateKeyFile?: string;
  }) => Promise<CenterSettingsReply<{ readonly ok: true }>>;
  readonly selectFile: (kind: "certificate" | "private-key") => Promise<string | null>;
  readonly centerSwitch?: (input: CenterSwitchInput) => Promise<CenterSwitchReply>;
  readonly promoteFromEdge?: (input: PromoteFromEdgeInput) => Promise<PromoteFromEdgeReply>;
  readonly edgeLocalState?: (input: { readonly repoId: string }) => Promise<CenterSettingsReply<EdgeLocalState>>;
}
