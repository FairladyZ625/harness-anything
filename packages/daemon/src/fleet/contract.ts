import { TextDecoder } from "node:util";
import { sha256Text, stableStringify } from "../../../kernel/src/index.ts";

export const FLEET_FRAME_BYTES = 96 * 1024, FLEET_CHUNK_BYTES = 64 * 1024, FLEET_PAGE_ROWS = 128;
export type FleetCut = Readonly<{ revision: number; commitSha: string; headDigest: string }>;
export type FleetBlob = Readonly<{ sha256: string; size: number; mediaType: string }>;
export type FleetDescriptor = FleetBlob & Readonly<{ ref: string }>;
export interface FleetAssignmentScope { readonly repoId: string; readonly taskId: string; readonly executionId: string; readonly paths: readonly string[] }
export interface FleetAssignmentBinding extends FleetAssignmentScope { readonly nodeId: string; readonly assignmentId: string; readonly actor: { readonly principal: { readonly personId: string }; readonly executor: { readonly kind: "agent"; readonly id: string } | null } }
type Msg<S extends string, P extends object = object> = Readonly<{ schema: S; messageId: string }> & Readonly<P>;
export type FleetFrameV1 =
  | Msg<"fleet.session.hello/v1", { protocolVersion: 1; nodeId: string; credential: string }>
  | Msg<"fleet.session.ready/v1", { inReplyTo: string; sessionId: string; maxFrameBytes: number; chunkBytes: number }>
  | Msg<"fleet.assignment.get/v1", { assignmentId: string }>
  | Msg<"fleet.assignment.result/v1", { inReplyTo: string; assignmentId: string; repoId: string; taskId: string; executionId: string; paths: readonly string[]; baseLedgerSha: string; expiresAt: string }>
  | Msg<"fleet.upload.begin/v1", { assignmentId: string; content: FleetBlob }>
  | Msg<"fleet.upload.ready/v1", { inReplyTo: string; uploadId: string; resumeOffset: number; status: "receiving" | "already_staged" }>
  | Msg<"fleet.upload.chunk/v1", { uploadId: string; offset: number; dataBase64: string }>
  | Msg<"fleet.upload.finish/v1", { uploadId: string }>
  | Msg<"fleet.upload.result/v1", { inReplyTo: string; status: "staged" | "already_staged"; descriptor: FleetDescriptor }>
  | Msg<"fleet.doc.submit/v1", { assignmentId: string; baseLedgerSha: string; changes: readonly FleetDocChange[] }>
  | Msg<"fleet.doc.result/v1", { inReplyTo: string; outcome: "applied" | "pending" | "rejected" | "indeterminate"; opId: string; revision: number | null; code: string | null; transferId: string | null }>
  | Msg<"fleet.snapshot.begin/v1", { transferId: string; repoId: string; viewId: string; cut: FleetCut; manifest: FleetManifest }>
  | Msg<"fleet.snapshot.page/v1", { transferId: string; pageIndex: number; entries: readonly FleetEntry[] }>
  | Msg<"fleet.snapshot.chunk/v1", { transferId: string; blobSha256: string; offset: number; dataBase64: string }>
  | Msg<"fleet.snapshot.finish/v1", { transferId: string; manifestDigest: string }>
  | Msg<"fleet.delta.begin/v1", { transferId: string; repoId: string; viewId: string; fromCut: FleetCut; toCut: FleetCut; changeCount: number; resultManifestDigest: string }>
  | Msg<"fleet.delta.page/v1", { transferId: string; pageIndex: number; changes: readonly FleetDeltaChange[] }>
  | Msg<"fleet.delta.chunk/v1", { transferId: string; blobSha256: string; offset: number; dataBase64: string }>
  | Msg<"fleet.delta.finish/v1", { transferId: string; resultManifestDigest: string }>
  | Msg<"fleet.ack/v1", { transferId: string; cut: FleetCut; manifestDigest: string }>
  | Msg<"fleet.ack.result/v1", { inReplyTo: string; outcome: "applied" | "current" | "rejected"; opId: string; revision: number; viewId: string; ackCut: number; code: string | null }>
  | Msg<"fleet.error/v1", { inReplyTo: string; code: string; retryable: boolean; resumeOffset: number | null; nextAction: string }>;
export type FleetManifest = Readonly<{ digest: string; entryCount: number; totalBytes: number }>;
export type FleetEntry = Readonly<{ path: string; blob: FleetBlob }>;
export type FleetDocChange = Readonly<{ path: string; baseBlobSha256: string | null; policyId: string; candidate: FleetDescriptor }>;
export type FleetDeltaChange = Readonly<{ op: "put"; path: string; blob: FleetBlob } | { op: "delete"; path: string }>;
export function fleetManifestDigest(entries: readonly FleetEntry[]): string { return sha256Text(stableStringify(entries.map(({ path, blob }) => ({ path, blob })).sort((a, b) => a.path.localeCompare(b.path)))); }

export class FleetContractError extends Error { constructor(message: string) { super(message); this.name = "FleetContractError"; } }
export class FleetUtf8LineDecoder { readonly #decoder = new TextDecoder("utf-8", { fatal: true }); #buffer = "";
  push(chunk: Uint8Array): readonly string[] { this.#buffer += this.#decoder.decode(chunk, { stream: true }); const lines: string[] = []; for (;;) { const end = this.#buffer.indexOf("\n"); if (end < 0) break; lines.push(this.#buffer.slice(0, end)); this.#buffer = this.#buffer.slice(end + 1); } if (Buffer.byteLength(this.#buffer) > FLEET_FRAME_BYTES) throw new FleetContractError("Fleet frame exceeds 98304 bytes"); return lines; }
  finish(): readonly string[] { this.#buffer += this.#decoder.decode(); if (this.#buffer.length) throw new FleetContractError("Fleet stream ended mid-frame"); return []; } }
type RecordValue = Readonly<Record<string, unknown>>; type Check = (value: unknown) => boolean;
const id: Check = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,96}$/u.test(value), text: Check = (value) => typeof value === "string" && value.length > 0 && value.length <= 512;
const uint: Check = (value) => Number.isSafeInteger(value) && Number(value) >= 0, sha40: Check = (value) => typeof value === "string" && /^[0-9a-f]{40}$/u.test(value), sha64: Check = (value) => typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
const nullable = (check: Check): Check => (value) => value === null || check(value), one = (...values: readonly unknown[]): Check => (value) => values.includes(value);
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
const shape = (fields: Readonly<Record<string, Check>>): Check => (value) => record(value) && Object.keys(value).length === Object.keys(fields).length && Object.entries(fields).every(([key, check]) => Object.hasOwn(value, key) && check(value[key]));
const array = (check: Check, maximum = FLEET_PAGE_ROWS): Check => (value) => Array.isArray(value) && value.length <= maximum && value.every(check);
const logicalPath: Check = (value) => typeof value === "string" && value === value.normalize("NFC") && value.length <= 512 && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
const base64: Check = (value) => typeof value === "string" && value.length > 0 && Buffer.from(value, "base64").byteLength <= FLEET_CHUNK_BYTES && Buffer.from(value, "base64").toString("base64") === value;
const cut = shape({ revision: uint, commitSha: sha40, headDigest: (value) => typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value) });
const blob = shape({ sha256: sha64, size: uint, mediaType: text }), descriptor = shape({ ref: (value) => typeof value === "string" && /^doc-sync-claims\/[A-Za-z0-9_-]{1,96}$/u.test(value), sha256: sha64, size: uint, mediaType: text });
const manifest = shape({ digest: sha64, entryCount: uint, totalBytes: uint }), entry = shape({ path: logicalPath, blob }), put = shape({ op: one("put"), path: logicalPath, blob }), del = shape({ op: one("delete"), path: logicalPath });
const docChange = shape({ path: logicalPath, baseBlobSha256: nullable(sha64), policyId: text, candidate: descriptor });
const common = { schema: text, messageId: id } as const, reply = { ...common, inReplyTo: id } as const;
const schemas: Readonly<Record<string, Check>> = {
  "fleet.session.hello/v1": shape({ ...common, protocolVersion: one(1), nodeId: id, credential: text }), "fleet.session.ready/v1": shape({ ...reply, sessionId: id, maxFrameBytes: one(FLEET_FRAME_BYTES), chunkBytes: one(FLEET_CHUNK_BYTES) }),
  "fleet.assignment.get/v1": shape({ ...common, assignmentId: id }), "fleet.assignment.result/v1": shape({ ...reply, assignmentId: id, repoId: id, taskId: id, executionId: id, paths: array(logicalPath), baseLedgerSha: sha40, expiresAt: (value) => typeof value === "string" && !Number.isNaN(Date.parse(value)) }),
  "fleet.upload.begin/v1": shape({ ...common, assignmentId: id, content: blob }), "fleet.upload.ready/v1": shape({ ...reply, uploadId: id, resumeOffset: uint, status: one("receiving", "already_staged") }), "fleet.upload.chunk/v1": shape({ ...common, uploadId: id, offset: uint, dataBase64: base64 }), "fleet.upload.finish/v1": shape({ ...common, uploadId: id }), "fleet.upload.result/v1": shape({ ...reply, status: one("staged", "already_staged"), descriptor }),
  "fleet.doc.submit/v1": shape({ ...common, assignmentId: id, baseLedgerSha: sha40, changes: array(docChange) }), "fleet.doc.result/v1": shape({ ...reply, outcome: one("applied", "pending", "rejected", "indeterminate"), opId: text, revision: nullable(uint), code: nullable(text), transferId: nullable(id) }),
  "fleet.snapshot.begin/v1": shape({ ...common, transferId: id, repoId: id, viewId: id, cut, manifest }), "fleet.snapshot.page/v1": shape({ ...common, transferId: id, pageIndex: uint, entries: array(entry) }), "fleet.snapshot.chunk/v1": shape({ ...common, transferId: id, blobSha256: sha64, offset: uint, dataBase64: base64 }), "fleet.snapshot.finish/v1": shape({ ...common, transferId: id, manifestDigest: sha64 }),
  "fleet.delta.begin/v1": shape({ ...common, transferId: id, repoId: id, viewId: id, fromCut: cut, toCut: cut, changeCount: uint, resultManifestDigest: sha64 }), "fleet.delta.page/v1": shape({ ...common, transferId: id, pageIndex: uint, changes: array((value) => put(value) || del(value)) }), "fleet.delta.chunk/v1": shape({ ...common, transferId: id, blobSha256: sha64, offset: uint, dataBase64: base64 }), "fleet.delta.finish/v1": shape({ ...common, transferId: id, resultManifestDigest: sha64 }),
  "fleet.ack/v1": shape({ ...common, transferId: id, cut, manifestDigest: sha64 }), "fleet.ack.result/v1": shape({ ...reply, outcome: one("applied", "current", "rejected"), opId: text, revision: uint, viewId: id, ackCut: uint, code: nullable(text) }), "fleet.error/v1": shape({ ...reply, code: text, retryable: (value) => typeof value === "boolean", resumeOffset: nullable(uint), nextAction: text })
};
export function parseFleetFrame(input: string | unknown): FleetFrameV1 { if (typeof input === "string" && Buffer.byteLength(input) > FLEET_FRAME_BYTES) throw new FleetContractError("Fleet frame exceeds 98304 bytes"); let value: unknown; try { value = typeof input === "string" ? JSON.parse(input) : input; } catch { throw new FleetContractError("Fleet frame is not valid JSON"); }
  if (!record(value) || typeof value.schema !== "string" || !schemas[value.schema]?.(value)) throw new FleetContractError(`Fleet frame violates closed schema ${record(value) ? String(value.schema) : "unknown"}`); if (Buffer.byteLength(JSON.stringify(value)) > FLEET_FRAME_BYTES) throw new FleetContractError("Fleet frame exceeds 98304 bytes"); return value as FleetFrameV1; }
export function serializeFleetFrame(value: unknown): string { return `${JSON.stringify(parseFleetFrame(value))}\n`; }
