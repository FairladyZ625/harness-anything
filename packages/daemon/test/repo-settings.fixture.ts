import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  compileSettingsChangedEvent,
  compileVerticalDeclarationEvent,
  makeTaskEventStore,
  preflightCanonicalGeneration,
  readSettingsFacet,
  registerDaemonRepo as registerProductDaemonRepo,
  resolveHarnessLayout,
} from "../../kernel/src/index.ts";
import { daemonRegistryPaths } from "../../kernel/src/daemon/registry.ts";
import { defaultAssets } from "../../preset/src/preset-resolver-common.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell as openProductRepoCell } from "../src/repo-cell.ts";
import { openPersistentWriterEpoch, type WriterEpochFenceDescriptor } from "../src/writer-epoch.ts";

const seededSettings = new Set<string>();

function fixtureFence(repoId: string, stateRoot: string): WriterEpochFenceDescriptor {
  const authority = openPersistentWriterEpoch({ stateRoot, holderId: "direct-store" });
  try {
    const lease = authority.acquire(repoId);
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
}): void {
  const repoId = workspaceId(input.repoId),
    rootDir = canonicalRoot(input.rootDir),
    fixtureKey = `${rootDir}\0${repoId}`;
  if (seededSettings.has(fixtureKey)) return;
  const store = makeTaskEventStore({
      repoId,
      rootDir,
      activationPreflight: preflightCanonicalGeneration,
      ...(input.writerEpochFence ? { writerFence: () => input.writerEpochFence! } : {}),
      ...(input.authoredBranch ? { authoredBranch: input.authoredBranch } : {}),
    }),
    stream = store.read();
  if (stream.events.some((event) => event.schema === "settings-event/v1")) {
    seededSettings.add(fixtureKey);
    return;
  }
  const settingsPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "harness.yaml"),
    documentBody = existsSync(settingsPath)
      ? readFileSync(settingsPath, "utf8")
      : "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
    digest = createHash("sha256").update(`${repoId}\0${documentBody}`).digest("hex");
  store.append(
    compileSettingsChangedEvent({
      settings: readSettingsFacet(documentBody),
      baseDocumentBody: documentBody,
      candidateDocumentBody: documentBody,
      eventId: `event-settings-fixture-${digest}`,
      opId: `settings-fixture-${digest}`,
      workspaceRevision: stream.revision + 1,
      actor: { principal: { personId: "fixture" }, executor: null },
      source: "local",
      occurredAt: "2026-08-27T00:00:00.000Z",
    }),
  );
  seededSettings.add(fixtureKey);
}

export const openBootstrappedRepoCell: typeof openProductRepoCell = async (input) => {
  if (input.mode === "remote-edge") return openProductRepoCell(input);
  const defaultWriterEpochFence =
    input.defaultWriterEpochFence ??
    fixtureFence(input.repoId, path.join(resolveHarnessLayout(input.rootDir).localRoot, "fixture-writer-epochs"));
  await settleSettingsEvent({ ...input, writerEpochFence: defaultWriterEpochFence });
  const cell = await openProductRepoCell({ ...input, defaultWriterEpochFence });
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
      activationPreflight: preflightCanonicalGeneration,
      ...(input.writerEpochFence ? { writerFence: () => input.writerEpochFence! } : {}),
      ...(input.authoredBranch ? { authoredBranch: input.authoredBranch } : {}),
    }),
    stream = store.read();
  if (!stream.events.some((event) => event.schema === "settings-event/v1")) {
    const settingsPath = path.join(resolveHarnessLayout(input.rootDir).authoredRoot, "harness.yaml"),
      documentBody = existsSync(settingsPath)
        ? readFileSync(settingsPath, "utf8")
        : "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n",
      digest = createHash("sha256").update(`${repoId}\0${documentBody}`).digest("hex");
    store.append(
      compileSettingsChangedEvent({
        settings: readSettingsFacet(documentBody),
        baseDocumentBody: documentBody,
        candidateDocumentBody: documentBody,
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
        definition: JSON.parse(readFileSync(`${defaultAssets}/vertical.json`, "utf8")),
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

export const registerBootstrappedDaemonRepo: typeof registerProductDaemonRepo = (input) => {
  if (input.mode !== "remote-edge" && input.repoId && input.canonicalRoot) {
    const writerEpochFence = fixtureFence(input.repoId, path.join(daemonRegistryPaths(input).userRoot, "fleet"));
    seedSettingsEvent({ repoId: input.repoId, rootDir: input.canonicalRoot, writerEpochFence });
  }
  return registerProductDaemonRepo(input);
};
