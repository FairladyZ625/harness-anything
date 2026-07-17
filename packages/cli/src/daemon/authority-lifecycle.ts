import type {
  ActorAxesBindingRuntimeV2,
  AttributedCoordinatorFactory,
  AuthorityCutoverControlService,
  AuthorityCommittedEventPublisherV2,
  AuthorityFenceWitness,
  OperationNamespaceVerifierV2,
  ProtocolSchemaTupleV2
} from "../../../application/src/index.ts";
import { Effect } from "effect";
import type {
  AuthorityConnectionContext,
  DaemonRepoNamespace,
  PersonRegistry
} from "../../../daemon/src/index.ts";
import {
  resolveHarnessLayout,
  stableStringify,
  type WriteAttribution,
  type WriteCoordinator
} from "../../../kernel/src/index.ts";
import type { DaemonAuthorityCommandSubmissionV2 } from "./authority-command-submission.ts";
import type { AuthorityForcedCommandSession } from "../../../daemon/src/index.ts";
import type { Readable, Writable } from "node:stream";
import {
  createGitCanonicalPublicationInspector,
  type CanonicalPublicationEvidence
} from "./authority-publication-evidence.ts";
import {
  openDurableAuthorityServiceState,
  type DurableAuthorityServiceState
} from "./authority-service-state.ts";

export type AuthorityRepoStopReason =
  | "repo-detached"
  | "registry-disabled"
  | "reconcile-removed"
  | "daemon-shutdown";

export interface AuthorityRepoServerData {
  readonly authenticatedPersonRegistry: PersonRegistry;
  readonly deriveExecutorFromParsedPreset: (presetId: string) => `preset:${string}`;
  readonly workspaceId: string;
  readonly repoId: string;
  readonly canonicalRoot: string;
  readonly deviceId: string;
  readonly viewId: string;
  readonly sessionId: string;
  readonly schemaTuple: ProtocolSchemaTupleV2;
  readonly authorityGeneration: number;
  readonly revocationEpochs: Readonly<Record<string, number>>;
  readonly admissionTokenRef: string;
  readonly operationNamespace: string;
}

export interface AuthorityRepoComponent {
  readonly commandSubmissionV2: DaemonAuthorityCommandSubmissionV2;
  readonly cutoverControl: AuthorityCutoverControlService;
  readonly bindConnection: (context: AuthorityConnectionContext) => AuthorityRepoConnectionBinding;
  readonly stop: (reason: AuthorityRepoStopReason) => Promise<void>;
}

export interface AuthorityRepoConnectionBinding extends DaemonAuthorityCommandSubmissionV2 {
  readonly serveForcedCommand?: (input: {
    readonly input: Readable;
    readonly output: Writable;
  }) => AuthorityForcedCommandSession;
}

export interface AuthorityRepoLifecycleHooks {
  readonly start: (input: {
    readonly repo: DaemonRepoNamespace;
    readonly runtime: AuthorityLifecycleRuntime;
    readonly serverData: AuthorityRepoServerData;
    readonly attributedCoordinatorFactory: AttributedCoordinatorFactory;
    readonly operationRegistry: DurableAuthorityServiceState["operationRegistry"];
    readonly cutoverState: DurableAuthorityServiceState["cutoverState"];
    readonly replicaChangeLog: DurableAuthorityServiceState["replicaChangeLog"];
    readonly bindingRuntime: ActorAxesBindingRuntimeV2;
    readonly namespaceVerifier: OperationNamespaceVerifierV2;
    readonly fenceWitness: AuthorityFenceWitness;
    readonly committedEventPublisher: AuthorityCommittedEventPublisherV2;
    readonly inspectPublication: (previousCommit: string | null) => Promise<CanonicalPublicationEvidence>;
  }) => Promise<AuthorityRepoComponent>;
  readonly serve: (input: { readonly repo: DaemonRepoNamespace; readonly component: AuthorityRepoComponent }) => Promise<void>;
  readonly stop: (input: {
    readonly repo: DaemonRepoNamespace;
    readonly component: AuthorityRepoComponent;
    readonly reason: AuthorityRepoStopReason;
  }) => Promise<void>;
}

export interface AuthorityLifecycleRuntime {
  readonly createAttributedCoordinator: (input: {
    readonly attribution: WriteAttribution;
    readonly sessionId: string;
  }) => WriteCoordinator;
  readonly assertWriteFenceHeld: () => Promise<void>;
}

export interface AuthorityRepoCompositionData extends AuthorityRepoServerData {
  readonly bindingRuntime: ActorAxesBindingRuntimeV2 & AuthorityDurableAdapterMarker;
  readonly namespaceVerifier: OperationNamespaceVerifierV2 & AuthorityDurableAdapterMarker;
  readonly committedEventPublisher: AuthorityCommittedEventPublisherV2;
}

export interface AuthorityDurableAdapterMarker {
  readonly durability: {
    readonly schema: "authority-service-state-adapter/v1";
    readonly recovery: "replayed-before-serve";
  };
}

export const authorityDurableAdapterMarker: AuthorityDurableAdapterMarker = Object.freeze({
  durability: Object.freeze({
    schema: "authority-service-state-adapter/v1" as const,
    recovery: "replayed-before-serve" as const
  })
});

export interface AuthorityRepoLifecycleController {
  readonly startRepo: (repo: DaemonRepoNamespace, runtime: AuthorityLifecycleRuntime) => Promise<AuthorityRepoStartResult>;
  readonly unpublishRepo: (repoId: string) => AuthorityRepoComponent | undefined;
  readonly stopRepo: (repo: DaemonRepoNamespace, reason: AuthorityRepoStopReason) => Promise<void>;
  readonly stopAll: (reason: AuthorityRepoStopReason) => Promise<void>;
  readonly component: (repoId: string) => AuthorityRepoComponent | undefined;
  readonly unavailableReason: (repoId: string) => string | undefined;
}

export type AuthorityRepoStartResult =
  | { readonly ok: true; readonly component: AuthorityRepoComponent }
  | { readonly ok: false; readonly error: string };

interface StartedAuthorityRepo {
  readonly repo: DaemonRepoNamespace;
  readonly component: AuthorityRepoComponent;
  readonly state: DurableAuthorityServiceState;
  published: boolean;
  stopping?: Promise<void>;
}

export function createAuthorityRepoLifecycleController(input: {
  readonly hooks: AuthorityRepoLifecycleHooks;
  readonly serviceStateRoot: string;
  readonly resolveCompositionData: (
    repo: DaemonRepoNamespace,
    state: DurableAuthorityServiceState
  ) => Promise<AuthorityRepoCompositionData>;
  readonly resolvePublicationRoot?: (repo: DaemonRepoNamespace) => string;
  /** Test-only escape hatch; production composition must carry durable adapter markers. */
  readonly allowInMemoryFixture?: true;
}): AuthorityRepoLifecycleController {
  const started = new Map<string, StartedAuthorityRepo>();
  const starting = new Map<string, Promise<AuthorityRepoStartResult>>();
  const unavailable = new Map<string, string>();

  return {
    startRepo,
    unpublishRepo: (repoId) => {
      const entry = started.get(repoId);
      if (entry) entry.published = false;
      return entry?.component;
    },
    stopRepo,
    stopAll: async (reason) => {
      const errors: unknown[] = [];
      for (const entry of [...started.values()].sort((left, right) => left.repo.repoId.localeCompare(right.repo.repoId))) {
        try {
          await stopRepo(entry.repo, reason);
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length > 0) throw new AggregateError(errors, "failed to stop one or more authority repo components");
    },
    component: (repoId) => started.get(repoId)?.component,
    unavailableReason: (repoId) => unavailable.get(repoId)
  };

  function startRepo(repo: DaemonRepoNamespace, runtime: AuthorityLifecycleRuntime): Promise<AuthorityRepoStartResult> {
    const existing = started.get(repo.repoId);
    if (existing) return Promise.resolve(existing.repo.canonicalRoot === repo.canonicalRoot
      ? { ok: true, component: existing.component }
      : { ok: false, error: "AUTHORITY_REPO_ATTACHMENT_MISMATCH" });
    const pending = starting.get(repo.repoId);
    if (pending) return pending;
    const attempt = startRepoOnce(repo, runtime).finally(() => {
      if (starting.get(repo.repoId) === attempt) starting.delete(repo.repoId);
    });
    starting.set(repo.repoId, attempt);
    return attempt;
  }

  async function startRepoOnce(
    repo: DaemonRepoNamespace,
    runtime: AuthorityLifecycleRuntime
  ): Promise<AuthorityRepoStartResult> {
    let state: DurableAuthorityServiceState | undefined;
    let component: AuthorityRepoComponent | undefined;
    try {
      state = openDurableAuthorityServiceState({
        serviceStateRoot: input.serviceStateRoot,
        repoId: repo.repoId
      });
      const serverData = await input.resolveCompositionData(repo, state);
      validateServerData(repo, serverData, input.allowInMemoryFixture === true);
      const publicationInspector = createGitCanonicalPublicationInspector(
        input.resolvePublicationRoot?.(repo) ?? resolveHarnessLayout(repo.canonicalRoot).authoredRoot
      );
      const attributedCoordinatorFactory = makeHeldLockAttributedCoordinatorFactory(runtime);
      component = await input.hooks.start({
        repo,
        runtime,
        serverData,
        attributedCoordinatorFactory,
        operationRegistry: state.operationRegistry,
        cutoverState: state.cutoverState,
        replicaChangeLog: state.replicaChangeLog,
        bindingRuntime: serverData.bindingRuntime,
        namespaceVerifier: serverData.namespaceVerifier,
        fenceWitness: { assertHeld: () => runtime.assertWriteFenceHeld() },
        committedEventPublisher: serverData.committedEventPublisher,
        inspectPublication: publicationInspector.inspectPublication
      });
      await input.hooks.serve({ repo, component });
      started.set(repo.repoId, { repo, component, state, published: true });
      unavailable.delete(repo.repoId);
      return { ok: true, component };
    } catch (error) {
      if (component) await stopStartedComponent(repo, component, "repo-detached").catch(() => undefined);
      await state?.close().catch(() => undefined);
      const message = authorityLifecycleErrorMessage(error);
      unavailable.set(repo.repoId, message);
      return { ok: false, error: message };
    }
  }

  async function stopRepo(repo: DaemonRepoNamespace, reason: AuthorityRepoStopReason): Promise<void> {
    await starting.get(repo.repoId);
    const entry = started.get(repo.repoId);
    if (!entry) return;
    entry.published = false;
    entry.stopping ??= (async () => {
      try {
        await stopStartedComponent(repo, entry.component, reason);
      } finally {
        await entry.state.close();
        started.delete(repo.repoId);
      }
    })();
    await entry.stopping;
  }

  async function stopStartedComponent(
    repo: DaemonRepoNamespace,
    component: AuthorityRepoComponent,
    reason: AuthorityRepoStopReason
  ): Promise<void> {
    // The hook owns the one idempotent stop action and may delegate to component.stop.
    await input.hooks.stop({ repo, component, reason });
  }
}

export function makeHeldLockAttributedCoordinatorFactory(
  runtime: AuthorityLifecycleRuntime
): AttributedCoordinatorFactory {
  const active = new Map<string, WriteCoordinator>();
  return {
    create: ({ attribution, sessionId }) => {
      const key = stableStringify({ attribution, sessionId });
      const existing = active.get(key);
      if (existing) return existing;
      const coordinator = runtime.createAttributedCoordinator({ attribution, sessionId });
      const shared: WriteCoordinator = {
        enqueue: coordinator.enqueue,
        flush: (reason) => Effect.ensuring(
          coordinator.flush(reason),
          Effect.sync(() => {
            if (active.get(key) === shared) active.delete(key);
          })
        ),
        recover: coordinator.recover
      };
      active.set(key, shared);
      return shared;
    }
  };
}

function validateServerData(
  repo: DaemonRepoNamespace,
  data: AuthorityRepoCompositionData,
  allowInMemoryFixture: boolean
): void {
  if (data.repoId !== repo.repoId || data.canonicalRoot !== repo.canonicalRoot) {
    throw new Error("AUTHORITY_SERVER_REPO_BINDING_MISMATCH");
  }
  for (const [name, value] of Object.entries({
    workspaceId: data.workspaceId,
    deviceId: data.deviceId,
    viewId: data.viewId,
    sessionId: data.sessionId,
    admissionTokenRef: data.admissionTokenRef,
    operationNamespace: data.operationNamespace
  })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`AUTHORITY_SERVER_AXIS_REQUIRED:${name}`);
  }
  if (!allowInMemoryFixture) {
    for (const [name, adapter] of Object.entries({
      bindingRuntime: data.bindingRuntime,
      namespaceVerifier: data.namespaceVerifier
    })) {
      if (adapter.durability?.schema !== "authority-service-state-adapter/v1"
        || adapter.durability.recovery !== "replayed-before-serve") {
        throw new Error(`AUTHORITY_DURABLE_ADAPTER_REQUIRED:${name}`);
      }
    }
  }
}

function authorityLifecycleErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
