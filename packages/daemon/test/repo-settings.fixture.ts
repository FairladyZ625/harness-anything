import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compileSettingsChangedEvent,
  compileVerticalDeclarationEvent,
  decodeVerticalDefinition,
  readSettingsFacet,
  resolveHarnessLayout,
  writeRepositorySettingsFacet,
} from "@harness-anything/kernel";
import {
  activateEmptyCanonicalGeneration,
  makeTaskEventStore,
  registerDaemonRepo as registerProductDaemonRepo,
} from "@harness-anything/storage";
import { daemonRegistryPaths } from "../../storage/test/store/canonical-generation.fixtures.ts";
import { defaultAssets } from "@harness-anything/preset/internal/preset-resolver-common";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { type RepoCell, type RepoCellBinding } from "../src/repo-cell.ts";
import { openRepoCell as openProductRepoCell } from "../src/repo-cell-open.ts";
import {
  openPersistentWriterEpoch,
  readLedgerWriterEpoch,
  type WriterEpochFenceDescriptor,
} from "@harness-anything/storage";
import { initialRuntimeInstanceSettings } from "../src/runtime-spawn-allowlist.ts";
import type { DaemonHost } from "../src/daemon-host.ts";
import { policyTestCenter, provisionPolicyTestRepository, withPolicyGroup } from "./keycloak-policy.fixtures.ts";

const seededSettings = new Set<string>();
const workDecisionByCell = new WeakMap<RepoCell, string>();

export async function acceptedWorkDecision(cell: RepoCell, binding: RepoCellBinding, key: string): Promise<string> {
  const existing = workDecisionByCell.get(cell);
  if (existing !== undefined) return existing;
  const decision = await cell.run(
      {
        kind: "decision-propose",
        jsonInput: JSON.stringify({
          title: `Fixture direction for ${key}`,
          question: `Should fixture work ${key} be tied to an accepted direction?`,
          riskTier: "low",
          urgency: "low",
          vertical: "software/coding",
          preset: "standard-task",
          decisionClass: "ordinary",
          appliesTo: { modules: ["daemon"], productLines: [] },
          chosen: [{ id: "CH1", text: "Tie the work to its accepted direction" }],
          rejected: [{ id: "RJ1", text: "Leave it unlinked", whyNot: "The work loses its source" }],
          claims: [],
          fulfillments: [],
        }),
        body: `# Fixture direction for ${key}\n\n## 背景\n\nThe fixture needs an effective decision.\n\n## 权衡\n\nAn accepted decision anchors the work.\n\n## 结论\n\nTie the work to its accepted direction.\n`,
      },
      binding,
    ),
    decisionId = String((JSON.parse(String(decision.evidence)) as { readonly decisionId: string }).decisionId),
    arbiter = withPolicyGroup(
      {
        actor: { principal: { personId: `person-arbiter-${key.replace(/[^a-z0-9]/giu, "-")}` }, executor: null },
        source: "local" as const,
      },
      "maintainer",
    ),
    accepted = await cell.run(
      {
        kind: "decision-accept",
        decisionId,
        rationale: "The fixture records an effective work direction.",
        judgmentOnlyRationale: "The fixture only needs an accepted decision as a work source.",
      },
      arbiter,
    );
  assert.equal(decision.outcome, "applied", JSON.stringify(decision));
  assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
  await waitForFixturePublication(cell, decision.opId, binding);
  await waitForFixturePublication(cell, accepted.opId, arbiter);
  workDecisionByCell.set(cell, decisionId);
  return decisionId;
}

function settingsBase(rootDir: string): string {
  const settingsPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "harness.yaml");
  if (!existsSync(settingsPath)) {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(
      settingsPath,
      "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    );
  }
  return readFileSync(settingsPath, "utf8");
}

function fixtureFence(repoId: string, rootDir: string, stateRoot: string): WriterEpochFenceDescriptor {
  const authority = openPersistentWriterEpoch({ stateRoot, holderId: "direct-store" });
  try {
    const lease = authority.acquire(repoId, readLedgerWriterEpoch(repoId, rootDir));
    return { schema: "harness-writer-epoch-fence/v1", stateRoot, repoId, holderId: lease.holderId, epoch: lease.epoch };
  } finally {
    authority.close();
  }
}

export function seedSettingsEvent(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly authoredBranch?: string;
  readonly writerEpochFence?: WriterEpochFenceDescriptor;
  readonly keepOpen?: boolean;
  readonly runtimeInstances?: readonly { readonly instanceId: string; readonly enabled: boolean }[];
}): ReturnType<typeof makeTaskEventStore> | undefined {
  const repoId = workspaceId(input.repoId),
    rootDir = canonicalRoot(input.rootDir),
    fixtureKey = `${rootDir}\0${repoId}`;
  if (seededSettings.has(fixtureKey)) return undefined;
  const store = makeTaskEventStore({
      repoId,
      rootDir,
      activationPreflight: activateEmptyCanonicalGeneration,
      ...(input.writerEpochFence ? { writerFence: () => input.writerEpochFence! } : {}),
      ...(input.authoredBranch ? { authoredBranch: input.authoredBranch } : {}),
    }),
    stream = store.read();
  if (stream.events.some((event) => event.schema === "settings-event/v1")) {
    return settleSeeded(store, fixtureKey, input.keepOpen);
  }
  const documentBody = settingsBase(rootDir),
    parsed = readSettingsFacet(documentBody),
    settings =
      input.runtimeInstances === undefined ? parsed : initialRuntimeInstanceSettings(parsed, input.runtimeInstances),
    digest = createHash("sha256").update(`${repoId}\0${documentBody}`).digest("hex");
  store.append(
    compileSettingsChangedEvent({
      settings,
      baseDocumentBody: documentBody,
      candidateDocumentBody: writeRepositorySettingsFacet(documentBody, settings),
      eventId: `event-settings-fixture-${digest}`,
      opId: `settings-fixture-${digest}`,
      workspaceRevision: stream.revision + 1,
      actor: { principal: { personId: "fixture" }, executor: null },
      source: "local",
      occurredAt: "2026-08-27T00:00:00.000Z",
    }),
  );
  return settleSeeded(store, fixtureKey, input.keepOpen);
}

function settleSeeded(
  store: ReturnType<typeof makeTaskEventStore>,
  fixtureKey: string,
  keepOpen?: boolean,
): ReturnType<typeof makeTaskEventStore> | undefined {
  seededSettings.add(fixtureKey);
  if (keepOpen) return store;
  // The seeded store schedules its follower publication one tick out; drain closes the SQLite
  // handle only after that publication settles. Callers that drop the store must not leave the
  // handle open for the rest of the process: on Windows an open handle blocks deleting the
  // fixture tree.
  void store.drain();
  return undefined;
}

export async function registerSettledBootstrappedDaemonRepo(
  input: Parameters<typeof registerProductDaemonRepo>[0],
): Promise<ReturnType<typeof registerProductDaemonRepo>> {
  if (input.mode !== "remote-edge" && input.repoId && input.canonicalRoot) {
    const writerEpochFence = fixtureFence(
        input.repoId,
        input.canonicalRoot,
        path.join(daemonRegistryPaths(input).userRoot, "fleet"),
      ),
      store = seedSettingsEvent({
        repoId: input.repoId,
        rootDir: input.canonicalRoot,
        writerEpochFence,
        keepOpen: true,
        runtimeInstances: fixtureMachineInstances(daemonRegistryPaths(input).userRoot),
      });
    if (store) {
      store.materialize();
      await store.drain();
    }
  }
  return registerProductDaemonRepo(input);
}

export const openFencedRepoCell: typeof openProductRepoCell = async (input) => {
  provisionPolicyTestRepository(input.repoId);
  if (input.mode === "remote-edge") return openProductRepoCell(input);
  const defaultWriterEpochFence =
    input.defaultWriterEpochFence ??
    fixtureFence(
      input.repoId,
      input.rootDir,
      path.join(resolveHarnessLayout(input.rootDir).localRoot, "fixture-writer-epochs"),
    );
  return openProductRepoCell({ keycloakCenter: policyTestCenter, ...input, defaultWriterEpochFence });
};

export async function waitForFixturePublication(cell: RepoCell, opId: string, binding: RepoCellBinding): Promise<void> {
  const receipt = await cell.run(
    { kind: "receipt-show", opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 5000 },
    binding,
  );
  assert.equal(receipt.wait?.state, "satisfied", JSON.stringify(receipt));
}

export const openBootstrappedRepoCell: typeof openProductRepoCell = async (input) => {
  provisionPolicyTestRepository(input.repoId);
  if (input.mode === "remote-edge") return openProductRepoCell(input);
  const defaultWriterEpochFence =
    input.defaultWriterEpochFence ??
    fixtureFence(
      input.repoId,
      input.rootDir,
      path.join(resolveHarnessLayout(input.rootDir).localRoot, "fixture-writer-epochs"),
    );
  await settleSettingsEvent({
    ...input,
    ...(input.runtimeInstances ? { runtimeInstances: input.runtimeInstances() } : {}),
    writerEpochFence: defaultWriterEpochFence,
  });
  const cell = await openProductRepoCell({ keycloakCenter: policyTestCenter, ...input, defaultWriterEpochFence });
  try {
    await cell.read("repo.settings.read");
  } catch (error) {
    if ((error as { readonly code?: string }).code !== "projection_pending") return cell;
    await cell.close();
    throw error;
  }
  return cell;
};

async function settleSettingsEvent(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly authoredBranch?: string;
  readonly writerEpochFence?: WriterEpochFenceDescriptor;
  readonly runtimeInstances?: readonly { readonly instanceId: string; readonly enabled: boolean }[];
}): Promise<void> {
  const repoId = workspaceId(input.repoId),
    rootDir = canonicalRoot(input.rootDir),
    fixtureKey = `${rootDir}\0${repoId}`;
  // registerBootstrappedDaemonRepo already placed a durable settings record in
  // SQLite. Reopening and draining a second store here defeats attach budgets
  // and masks tests that intentionally exercise an invalid Git layout.
  if (seededSettings.has(fixtureKey)) return;
  const store = makeTaskEventStore({
      repoId,
      rootDir,
      activationPreflight: activateEmptyCanonicalGeneration,
      ...(input.writerEpochFence ? { writerFence: () => input.writerEpochFence! } : {}),
      ...(input.authoredBranch ? { authoredBranch: input.authoredBranch } : {}),
    }),
    stream = store.read();
  if (!stream.events.some((event) => event.schema === "settings-event/v1")) {
    const documentBody = settingsBase(rootDir),
      parsed = readSettingsFacet(documentBody),
      seededSettings =
        input.runtimeInstances === undefined ? parsed : initialRuntimeInstanceSettings(parsed, input.runtimeInstances),
      digest = createHash("sha256").update(`${repoId}\0${documentBody}`).digest("hex");
    store.append(
      compileSettingsChangedEvent({
        settings: seededSettings,
        baseDocumentBody: documentBody,
        candidateDocumentBody: writeRepositorySettingsFacet(documentBody, seededSettings),
        eventId: `event-settings-fixture-${digest}`,
        opId: `settings-fixture-${digest}`,
        workspaceRevision: stream.revision + 1,
        actor: { principal: { personId: "fixture" }, executor: null },
        source: "local",
        occurredAt: "2026-08-27T00:00:00.000Z",
      }),
    );
  }
  if (!stream.events.some((event) => event.schema === "vertical-declaration-event/v1")) {
    const workspaceRevision = store.read().revision + 1;
    store.append(
      compileVerticalDeclarationEvent({
        type: "vertical_declared",
        definition: decodeVerticalDefinition(JSON.parse(readFileSync(`${defaultAssets}/vertical.json`, "utf8"))),
        eventId: `event-vertical-declaration-fixture-${workspaceRevision}`,
        opId: `vertical-declaration-fixture-${workspaceRevision}`,
        workspaceRevision,
        actor: { principal: { personId: "fixture" }, executor: null },
        source: "local",
        occurredAt: "2026-09-05T00:00:00.000Z",
      }),
    );
  }
  await store.drain();
  seededSettings.add(fixtureKey);
}

export const registerBootstrappedDaemonRepo = (
  input: Parameters<typeof registerProductDaemonRepo>[0] & {
    readonly runtimeInstances?: readonly { readonly instanceId: string; readonly enabled: boolean }[];
  },
): ReturnType<typeof registerProductDaemonRepo> => {
  if (input.mode !== "remote-edge" && input.repoId && input.canonicalRoot) {
    const writerEpochFence = fixtureFence(
      input.repoId,
      input.canonicalRoot,
      path.join(daemonRegistryPaths(input).userRoot, "fleet"),
    );
    seedSettingsEvent({
      repoId: input.repoId,
      rootDir: input.canonicalRoot,
      writerEpochFence,
      runtimeInstances: input.runtimeInstances ?? fixtureMachineInstances(daemonRegistryPaths(input).userRoot),
    });
  }
  return registerProductDaemonRepo(input);
};

function fixtureMachineInstances(
  userRoot: string,
): readonly { readonly instanceId: string; readonly enabled: boolean }[] | undefined {
  const target = path.join(userRoot, "runtime-instances.json");
  return existsSync(target) ? JSON.parse(readFileSync(target, "utf8")).instances : undefined;
}

/** Explicit project opt-in for fixture instances created after repository setup. */
export async function allowFixtureRuntimeInstances(
  host: Pick<DaemonHost, "read" | "run">,
  repoId: string,
  auth: Parameters<DaemonHost["run"]>[2],
  runtimeAllowedInstances: readonly string[],
): Promise<void> {
  const settings = await host.read(repoId, "repo.settings.read", {}, auth);
  const receipt = await host.run(
    repoId,
    {
      kind: "settings-update",
      runtimeAllowedInstances: [
        ...new Set([...(settings.settings.runtime?.allowedInstances ?? []), ...runtimeAllowedInstances]),
      ],
      expectedVersion: settings.revision,
    },
    auth,
  );
  assert.ok(receipt.outcome === "applied" || receipt.outcome === "no_changes", JSON.stringify(receipt));
  if (receipt.outcome === "no_changes") return;
  const published = await host.run(
    repoId,
    { kind: "receipt-show", opId: receipt.opId, waitFor: ["git_verified", "worktree_visible"], timeoutMs: 5000 },
    auth,
  );
  assert.equal(published.wait?.state, "satisfied", JSON.stringify(published));
}

/** Register a fixture runtime and opt it into the already bootstrapped repository in one step. */
export async function registerFixtureRuntimeInstance(
  host: Pick<DaemonHost, "runtimeInstance" | "read" | "run">,
  repoId: string,
  auth: Parameters<DaemonHost["run"]>[2],
  declaration: Readonly<Record<string, unknown>>,
  options: {
    readonly allowHost?: Pick<DaemonHost, "read" | "run">;
    readonly allowRepoId?: string;
  } = {},
): Promise<void> {
  const created = await host.runtimeInstance("daemon.runtimeInstance.create", declaration, auth);
  assert.equal(created.outcome, "applied", JSON.stringify(created));
  await allowFixtureRuntimeInstances(options.allowHost ?? host, options.allowRepoId ?? repoId, auth, [
    String(declaration.instanceId),
  ]);
}
