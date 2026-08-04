import path from "node:path";
import type { EntityId } from "../../../domain/entity-id.ts";
import type { DeclaredEntityDocumentWritePayload } from "../../../entity/declaration.ts";
import { sha256Text } from "../../../integrity/stable-hash.ts";
import { resolveHarnessLayout, type HarnessLayoutInput } from "../../../layout/index.ts";
import { localLayoutFileSystem } from "../../../local/local-layout-file-system.ts";
import type { DocumentWrite } from "../../../ports/artifact-store-writer.ts";
import { rejectWrite } from "../rejection.ts";

interface TranscriptConsentClaim {
  readonly key: `sha256:${string}`;
  readonly executionRef: string;
  readonly sourcePath: string;
}

export function assertTranscriptConsentAnchorUniqueness(
  rootInput: HarnessLayoutInput,
  payload: DeclaredEntityDocumentWritePayload,
  companionWrites: ReadonlyArray<DocumentWrite>,
  entityId: EntityId
): void {
  const candidates = candidateTranscriptConsentClaims(payload, companionWrites, entityId);
  if (candidates.length === 0) return;

  const claimsByKey = new Map<string, TranscriptConsentClaim>();
  for (const claim of [...existingTranscriptConsentClaims(rootInput, entityId), ...candidates]) {
    const existing = claimsByKey.get(claim.key);
    if (!existing) {
      claimsByKey.set(claim.key, claim);
      continue;
    }
    if (existing.executionRef === claim.executionRef) continue;
    rejectWrite([
      `transcript consent anchor ${claim.key} has already been consumed by ${existing.executionRef}.`,
      `Ask the human to send a new standalone confirmation message for ${claim.executionRef}, then pass that complete message.`
    ].join(" "), entityId);
  }
}

export function transcriptConsentAnchorKey(anchor: {
  readonly session_ref: string;
  readonly message_index: number;
  readonly message_sha256: string;
}): `sha256:${string}` {
  return `sha256:${sha256Text(`${anchor.session_ref}${anchor.message_index}${anchor.message_sha256}`)}`;
}

function candidateTranscriptConsentClaims(
  payload: DeclaredEntityDocumentWritePayload,
  companionWrites: ReadonlyArray<DocumentWrite>,
  entityId: EntityId
): ReadonlyArray<TranscriptConsentClaim> {
  const primary = payload.entityDocument.declaration.kind === "consent"
    ? [{ body: payload.entityDocument.body, sourcePath: "<declared consent entity>" }]
    : [];
  const companions = companionWrites
    .filter((write) => /^consents\/[^/]+\.md$/u.test(write.path))
    .map((write) => ({ body: write.body, sourcePath: `${write.taskId}/${write.path}` }));
  return [...primary, ...companions].flatMap(({ body, sourcePath }) => {
    const claim = decodeTranscriptConsentClaim(body, sourcePath, entityId);
    return claim ? [claim] : [];
  });
}

function existingTranscriptConsentClaims(
  rootInput: HarnessLayoutInput,
  entityId: EntityId
): ReadonlyArray<TranscriptConsentClaim> {
  const tasksRoot = resolveHarnessLayout(rootInput).tasksRoot;
  if (!localLayoutFileSystem.exists(tasksRoot)) return [];
  return localLayoutFileSystem.readDirents(tasksRoot)
    .filter((taskEntry) => taskEntry.isDirectory())
    .flatMap((taskEntry) => {
      const consentRoot = path.join(tasksRoot, taskEntry.name, "consents");
      if (!localLayoutFileSystem.exists(consentRoot)) return [];
      return localLayoutFileSystem.readDirents(consentRoot).flatMap((consentEntry) => {
        if (!consentEntry.isFile() || !consentEntry.name.endsWith(".md")) return [];
        const consentPath = path.join(consentRoot, consentEntry.name);
        const claim = decodeTranscriptConsentClaim(
          localLayoutFileSystem.readText(consentPath),
          path.relative(tasksRoot, consentPath).split(path.sep).join("/"),
          entityId
        );
        return claim ? [claim] : [];
      });
    });
}

function decodeTranscriptConsentClaim(
  body: string,
  sourcePath: string,
  entityId: EntityId
): TranscriptConsentClaim | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    rejectWrite(`consent document is not valid JSON: ${sourcePath}`, entityId);
  }
  if (!isConsentJsonRecord(value) || value.schema !== "consent/v2") return null;
  const source = value.source;
  if (!isConsentJsonRecord(source) || source.strength !== "transcript-verified") return null;
  const anchor = source.transcript_anchor;
  const executionRef = value.execution_ref;
  if (!isConsentJsonRecord(anchor)
    || typeof anchor.session_ref !== "string"
    || !Number.isInteger(anchor.message_index)
    || Number(anchor.message_index) < 0
    || typeof anchor.message_sha256 !== "string"
    || !/^sha256:[a-f0-9]{64}$/u.test(anchor.message_sha256)
    || typeof executionRef !== "string"
    || !executionRef.startsWith("execution/")) {
    rejectWrite(`transcript-verified consent has an invalid anchor or execution_ref: ${sourcePath}`, entityId);
  }
  return {
    key: transcriptConsentAnchorKey({
      session_ref: anchor.session_ref,
      message_index: Number(anchor.message_index),
      message_sha256: anchor.message_sha256
    }),
    executionRef,
    sourcePath
  };
}

function isConsentJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
