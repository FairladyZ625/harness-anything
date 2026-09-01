import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  compileSettingsChangedEvent,
  readSettingsFacet,
  registerDaemonRepo as registerProductDaemonRepo,
  resolveHarnessLayout,
} from "../../kernel/src/index.ts";
import { makeTaskEventStore as makeGitEventStore } from "../../kernel/src/store/task-event-store.ts";
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
  const settingsPath = path.join(resolveHarnessLayout(rootDir).authoredRoot, "harness.yaml"),
    defaultDocumentBody = "schema: harness-anything/v1\nlayout:\n  authoredRoot: harness\n  localRoot: .harness\n";
  if (!existsSync(settingsPath)) {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, defaultDocumentBody, "utf8");
  }
  const settingsTarget = path.relative(rootDir, settingsPath);
  try {
    execFileSync("git", ["-C", rootDir, "cat-file", "-e", `HEAD:${settingsTarget}`], { stdio: "ignore" });
  } catch {
    execFileSync("git", ["-C", rootDir, "add", "--", settingsTarget]);
    execFileSync("git", ["-C", rootDir, "commit", "-qm", "settings fixture baseline", "--", settingsTarget]);
  }
  const store = makeGitEventStore({
      repoId,
      rootDir,
      ...(input.authoredBranch ? { authoredBranch: input.authoredBranch } : {}),
    }),
    stream = store.read();
  if (stream.events.some((event) => event.schema === "settings-event/v1")) {
    seededSettings.add(fixtureKey);
    return;
  }
  const documentBody = readFileSync(settingsPath, "utf8"),
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
