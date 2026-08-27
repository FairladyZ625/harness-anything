import { createHash } from "node:crypto";
import path from "node:path";
import {
  isDocEvent,
  isMigrationImportEvent,
  parseCanonicalEvent,
  type CanonicalEventV1,
} from "../domain/doc-sync.contract.ts";
import { isLedgerLayoutMigrationEvent } from "../domain/ledger-layout-migration-event.ts";
import { isSettingsEvent } from "../domain/settings-event.ts";
import { isPeopleEvent } from "../domain/people-event.ts";
import { parsePeopleRosterDocument, serializePeopleRosterDocument } from "../domain/people-roster.ts";
import { writeSettingsFacet } from "../domain/settings.ts";
import { serializeEventHead, type EventHead } from "../domain/write-chain.contract.ts";
import { ledgerGitPath, type LedgerGitLayout } from "./ledger-git-layout.ts";
import {
  localGitObjectRefStore as gitObjects,
  localGitText,
  localGitWorktreeSettlement as worktree,
} from "./local-version-control-system.ts";
import type { PublicationFile, PublicationRename } from "./task-event-store-types.ts";
import { TaskEventStoreError } from "./task-event-store-types.ts";
import { blobObjectPath, eventObjectPath, eventObjectPaths } from "./task-event-store-layout.ts";
import { canonicalDocumentRetirements, commitParent, stripLedgerPrefix } from "./task-event-store-claims-layout.ts";
import { publicationModes, showBytes, showText } from "./task-event-store-materialization.ts";

// Prepared-publication inspection, replacement authorization, and Git diff reads.
export function changedPublication(
  ledger: LedgerGitLayout,
  commit: string,
): {
  readonly parent: string;
  readonly head: EventHead;
  readonly event: CanonicalEventV1;
  readonly files: readonly PublicationFile[];
} {
  const parent = commitParent(ledger.rootDir, commit);
  const changes = changedPaths(ledger.rootDir, parent, commit);
  const headBody = showText(ledger.rootDir, commit, ledgerGitPath(ledger, "events/head.json"));
  if (!headBody) throw new TaskEventStoreError("invalid_store", "prepared commit has no event head");
  const head = JSON.parse(headBody) as EventHead;
  if (serializeEventHead(head) !== headBody)
    throw new TaskEventStoreError("invalid_store", "prepared event head is not canonical");
  const eventBody =
    eventObjectPaths(ledger, head.opId)
      .map((target) => showText(ledger.rootDir, commit, target))
      .find((body) => body !== null) ?? null;
  if (!eventBody) throw new TaskEventStoreError("invalid_store", "prepared commit has no changed event");
  const event = parseCanonicalEvent(eventBody);
  if (isLedgerLayoutMigrationEvent(event)) {
    const added = new Set(changes.filter(({ status }) => status === "A").map(({ target }) => target));
    const renames: PublicationRename[] = [];
    for (const { status, target } of changes) {
      if (status !== "D") continue;
      const logical = stripLedgerPrefix(ledger, target);
      const eventMatch = /^events\/([^/]+\.json)$/u.exec(logical);
      const blobMatch = /^objects\/sha256\/([0-9a-f]{64})$/u.exec(logical);
      const to = eventMatch
        ? eventObjectPath(ledger, eventMatch[1]!.slice(0, -5))
        : blobMatch
          ? blobObjectPath(ledger, blobMatch[1]!)
          : null;
      if (!to || !added.delete(to))
        throw new TaskEventStoreError("invalid_store", `prepared migration has unmatched deletion ${target}`);
      renames.push({ from: target, to });
    }
    const eventPath = eventObjectPath(ledger, event.opId);
    const headPath = ledgerGitPath(ledger, "events/head.json");
    added.delete(eventPath);
    if (changes.some(({ status, target }) => status === "A" && target === headPath)) added.delete(headPath);
    if (
      added.size > 0 ||
      renames.length !== event.payload.eventCount + event.payload.blobCount ||
      changes.some(({ status, target }) => !["A", "D", "M"].includes(status) || (status === "M" && target !== headPath))
    )
      throw new TaskEventStoreError("invalid_store", "prepared migration change set does not match its event payload");
    return {
      parent,
      head,
      event,
      files: [
        { target: eventPath, body: eventBody, mode: "100644" },
        { target: headPath, body: headBody, mode: "100644" },
        ...renames,
      ],
    };
  }
  const expectedDeletes = new Set(
      canonicalDocumentRetirements(event).map(({ path: target }) => ledgerGitPath(ledger, target)),
    ),
    actualDeletes = changes.filter(({ status }) => status === "D").map(({ target }) => target);
  if (
    changes.some(({ status }) => !["A", "M", "D"].includes(status)) ||
    actualDeletes.length !== expectedDeletes.size ||
    actualDeletes.some((target) => !expectedDeletes.has(target))
  )
    throw new TaskEventStoreError("invalid_store", "ordinary prepared publication contains an undeclared deletion");
  const writes = readChangedWrites(
    ledger.rootDir,
    commit,
    changes.filter(({ status }) => status !== "D").map(({ target }) => target),
  );
  return {
    parent,
    head,
    event,
    files: [...publicationModes(ledger, writes, event), ...actualDeletes.map((target) => ({ delete: target }))],
  };
}
export function changedPaths(
  repoRoot: string,
  parent: string,
  commit: string,
): readonly { readonly status: string; readonly target: string }[] {
  const tokens = localGitText(
    repoRoot,
    "diff-tree",
    "--no-commit-id",
    "--name-status",
    "--no-renames",
    "-r",
    "-z",
    parent,
    commit,
  ).split("\0");
  const changes: { status: string; target: string }[] = [];
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = tokens[index]!;
    const target = tokens[index + 1]!;
    if (status && target) changes.push({ status, target });
  }
  return changes;
}
export function readChangedWrites(
  repoRoot: string,
  commit: string,
  targets: readonly string[],
): readonly { readonly target: string; readonly body: string }[] {
  if (targets.length === 0) return [];
  const output = gitObjects.batch(repoRoot, `${targets.map((target) => `${commit}:${target}`).join("\n")}\n`);
  const files: { target: string; body: string }[] = [];
  let cursor = 0;
  for (const target of targets) {
    const object = batchBody(output, cursor);
    files.push({ target, body: object.body });
    cursor = object.next;
  }
  return files;
}
export function batchBody(output: Buffer, cursor: number): { readonly body: string; readonly next: number } {
  const headerEnd = output.indexOf(10, cursor),
    size = Number(output.subarray(cursor, headerEnd).toString("utf8").split(" ").at(-1)),
    start = headerEnd + 1;
  return {
    body: output.subarray(start, start + size).toString("utf8"),
    next: start + size + 1,
  };
}
export function assertAuthorizedReplacement(
  ledger: LedgerGitLayout,
  parent: string,
  event: CanonicalEventV1,
  acceptPublished = false,
  candidateBody?: string,
): void {
  if (isSettingsEvent(event)) {
    const target = ledgerGitPath(ledger, event.payload.harnessDocumentClaim.path),
      committed = showText(ledger.rootDir, parent, target);
    if (committed === null || createHash("sha256").update(committed).digest("hex") !== event.payload.baseDocumentSha256)
      throw new TaskEventStoreError("revision_conflict", "harness.yaml changed before the Settings write committed");
    if (candidateBody === undefined)
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "Settings replacement authorization requires candidate bytes",
      );
    if (candidateBody !== writeSettingsFacet(committed, event.payload.settings))
      throw new TaskEventStoreError(
        "invalid_write_plan",
        "Settings may change only their owned harness.yaml facet fields",
      );
    return;
  }
  if (isPeopleEvent(event)) {
    const target = ledgerGitPath(ledger, event.payload.peopleDocumentClaim.path),
      committed = showText(ledger.rootDir, parent, target),
      committedSha = committed === null ? null : createHash("sha256").update(committed).digest("hex");
    if (committedSha !== event.payload.baseDocumentSha256)
      throw new TaskEventStoreError("revision_conflict", "people.yaml changed before the People write committed");
    if (candidateBody === undefined)
      throw new TaskEventStoreError("invalid_write_plan", "People replacement authorization requires candidate bytes");
    if (
      candidateBody !== serializePeopleRosterDocument(event.payload.roster) ||
      serializePeopleRosterDocument(parsePeopleRosterDocument(candidateBody)) !== candidateBody
    )
      throw new TaskEventStoreError("invalid_write_plan", "People may replace only the canonical people roster");
    return;
  }
  if (isDocEvent(event)) {
    for (const retirement of canonicalDocumentRetirements(event)) {
      const committed = committedNode(ledger.rootDir, parent, ledgerGitPath(ledger, retirement.path));
      if (committed?.nodeKind !== "file" || committed.sha256 !== retirement.baseBlobSha256)
        throw new TaskEventStoreError(
          "revision_conflict",
          `Document retirement base changed at ${retirement.path}; run ha doc status and retry.`,
        );
    }
    return;
  }
  if (
    !isMigrationImportEvent(event) ||
    event.payload.entity.kind !== "repo-document" ||
    event.payload.entity.destinationPreimage === undefined
  )
    return;
  const entity = event.payload.entity,
    expected = entity.destinationPreimage!,
    target = ledgerGitPath(ledger, entity.documentClaim.path),
    committed = committedNode(ledger.rootDir, parent, target),
    local = worktree.readNode(path.join(ledger.rootDir, ...target.split("/"))),
    same = (node: typeof committed, shape: typeof expected) =>
      node !== null && node.nodeKind === shape.nodeKind && node.sha256 === shape.sha256 && node.size === shape.size,
    localNode = local && {
      nodeKind: local.mode === "120000" ? ("symbolic-link" as const) : ("file" as const),
      sha256: local.sha256,
      size: local.size,
    },
    published = {
      nodeKind: entity.nodeKind,
      sha256: entity.documentClaim.sha256,
      size: entity.documentClaim.size,
    };
  if (
    !same(committed, expected) ||
    !localNode ||
    (!same(localNode, expected) && !(acceptPublished && same(localNode, published)))
  )
    throw new TaskEventStoreError(
      "revision_conflict",
      `Migration destination changed after conflict classification at ${entity.documentClaim.path}; ` +
        "rerun --dry-run and resolve the current node.",
    );
}
export function committedNode(
  repoRoot: string,
  commit: string,
  target: string,
): {
  readonly nodeKind: "file" | "symbolic-link";
  readonly sha256: string;
  readonly size: number;
} | null {
  const bytes = showBytes(repoRoot, commit, target);
  if (bytes === null) return null;
  const mode = localGitText(repoRoot, "ls-tree", "-z", commit, "--", target).slice(0, 6);
  if (mode !== "100644" && mode !== "120000") return null;
  return {
    nodeKind: mode === "120000" ? "symbolic-link" : "file",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.byteLength,
  };
}
