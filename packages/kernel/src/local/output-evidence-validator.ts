import path from "node:path";
import type { OutputEvidence } from "../domain/execution.ts";
import type { HarnessLayoutInput } from "../layout/index.ts";
import { resolveEntityRoot, resolveHarnessLayout } from "../layout/index.ts";
import { sha256Bytes } from "../integrity/stable-hash.ts";
import { readContentAddressedBlob } from "../composition/index.ts";
import { localEvidenceFileSystem } from "./local-layout-file-system.ts";

export function validateOutputEvidence(input: {
  readonly rootInput: HarnessLayoutInput;
  readonly taskId: string;
  readonly executionId: string;
  readonly evidence: ReadonlyArray<OutputEvidence>;
}): void {
  const expectedOwner = `execution/${input.taskId}/${input.executionId}`;
  const byId = new Map<string, OutputEvidence>();
  for (const item of input.evidence) {
    if (byId.has(item.evidence_id)) throw new Error(`duplicate output evidence id: ${item.evidence_id}`);
    byId.set(item.evidence_id, item);
    if (item.execution_ref !== expectedOwner) {
      throw new Error(`output evidence ${item.evidence_id} belongs to ${item.execution_ref}, not ${expectedOwner}`);
    }
    const bytes = locatorBytes(input.rootInput, item);
    if (item.sha256 !== undefined) {
      if (bytes === null) throw new Error(`output evidence digest cannot be verified for ${item.locator.substrate} locator: ${item.evidence_id}`);
      const actual = sha256Bytes(bytes);
      if (actual !== item.sha256) throw new Error(`output evidence digest mismatch: ${item.evidence_id}`);
    }
  }
  for (const item of input.evidence) validateReceiptBinding(item, byId);
}

function locatorBytes(rootInput: HarnessLayoutInput, evidence: OutputEvidence): Uint8Array | null {
  const locator = evidence.locator;
  switch (locator.substrate) {
    case "inline":
      return Buffer.from(locator.text, "utf8");
    case "file":
      return readAllowedFile(rootInput, locator.path, evidence.evidence_id);
    case "url": {
      try {
        new URL(locator.url);
      } catch {
        throw new Error(`output evidence URL is not parseable: ${evidence.evidence_id}`);
      }
      return null; // Parseability is not a claim that remote content exists or is truthful (dec_mrg3z1we/CH3).
    }
    case "object":
      try {
        return readContentAddressedBlob(rootInput, {
          ref: locator.ref,
          sha256: locator.sha256,
          size: locator.size,
          mediaType: locator.media_type
        });
      } catch (error) {
        throw new Error(`output evidence object does not exist or is invalid: ${evidence.evidence_id}: ${errorMessage(error)}`);
      }
    case "entity": {
      let documentPath: string;
      try {
        documentPath = resolveEntityRoot(rootInput, locator.entity_ref, "read").documentPath;
      } catch (error) {
        throw new Error(`output evidence entity ref is not resolvable: ${evidence.evidence_id}: ${errorMessage(error)}`);
      }
      if (!localEvidenceFileSystem.exists(documentPath)) throw new Error(`output evidence entity does not exist: ${evidence.evidence_id}`);
      return localEvidenceFileSystem.readBytes(documentPath);
    }
    case "checker_receipt":
      if (!Number.isFinite(Date.parse(locator.receipt.checked_at))) {
        throw new Error(`checker receipt checked_at is invalid: ${evidence.evidence_id}`);
      }
      return Buffer.from(JSON.stringify(locator.receipt), "utf8");
  }
}

function readAllowedFile(rootInput: HarnessLayoutInput, relativePath: string, evidenceId: string): Uint8Array {
  if (path.isAbsolute(relativePath)) throw new Error(`output evidence file must be repository-relative: ${evidenceId}`);
  const root = localEvidenceFileSystem.realpath(resolveHarnessLayout(rootInput).rootDir);
  const target = path.resolve(root, relativePath);
  if (!localEvidenceFileSystem.exists(target)) throw new Error(`output evidence file does not exist: ${evidenceId}`);
  const realTarget = localEvidenceFileSystem.realpath(target);
  const relative = path.relative(root, realTarget);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`output evidence file escapes allowed root: ${evidenceId}`);
  }
  return localEvidenceFileSystem.readBytes(realTarget);
}

function validateReceiptBinding(evidence: OutputEvidence, byId: ReadonlyMap<string, OutputEvidence>): void {
  if (!evidence.checker_receipt_ref) return;
  const receiptEvidence = byId.get(evidence.checker_receipt_ref);
  if (!receiptEvidence || receiptEvidence.locator.substrate !== "checker_receipt") {
    throw new Error(`checker receipt does not exist: ${evidence.checker_receipt_ref}`);
  }
  const receipt = receiptEvidence.locator.receipt;
  if (receipt.target_evidence_id !== evidence.evidence_id || receipt.target_sha256 !== (evidence.sha256 ?? null)) {
    throw new Error(`checker receipt binding mismatch: ${evidence.checker_receipt_ref}`);
  }
  // A receipt result is mechanical provenance only; it never derives Review.verdict (ADR-0027 D6).
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
