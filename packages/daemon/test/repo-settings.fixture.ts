import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  compileSettingsChangedEvent,
  makeTaskEventStore,
  readSettingsFacet,
  registerDaemonRepo as registerProductDaemonRepo,
  resolveHarnessLayout,
} from "../../kernel/src/index.ts";
import { canonicalRoot, workspaceId } from "../src/protocol/daemon-protocol.contract.ts";
import { openRepoCell as openProductRepoCell } from "../src/repo-cell.ts";

const seededSettings = new Set<string>();

export function seedSettingsEvent(input: {
  readonly repoId: string;
  readonly rootDir: string;
  readonly authoredBranch?: string;
}): void {
  const repoId = workspaceId(input.repoId),
    rootDir = canonicalRoot(input.rootDir),
    fixtureKey = `${rootDir}\0${repoId}`;
  if (seededSettings.has(fixtureKey)) return;
  const store = makeTaskEventStore({
      repoId,
      rootDir,
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
  seedSettingsEvent(input);
  const cell = await openProductRepoCell(input);
  try {
    await cell.read("repo.settings.read");
  } catch (error) {
    if ((error as { readonly code?: string }).code !== "projection_pending") return cell;
    await cell.close();
    throw error;
  }
  return cell;
};

export const registerBootstrappedDaemonRepo: typeof registerProductDaemonRepo = (input) => {
  if (input.mode !== "remote-edge") seedSettingsEvent({ repoId: input.repoId, rootDir: input.canonicalRoot });
  return registerProductDaemonRepo(input);
};
