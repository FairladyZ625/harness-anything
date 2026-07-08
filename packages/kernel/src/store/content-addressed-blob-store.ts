import path from "node:path";
import { sha256Bytes } from "../integrity/stable-hash.ts";
import { type HarnessLayoutInput, resolveHarnessLayout } from "../layout/index.ts";
import { durableFileExists, readFileBytes, writeFileDurably } from "./write-journal-durable.ts";

export interface ContentAddressedBlobRef {
  readonly ref: string;
  readonly sha256: string;
  readonly size: number;
  readonly mediaType: string;
}

const sha256Pattern = /^[0-9a-f]{64}$/u;

export function writeContentAddressedBlob(
  rootInput: HarnessLayoutInput,
  body: string | Uint8Array,
  mediaType: string
): ContentAddressedBlobRef {
  const bytes = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  const sha256 = sha256Bytes(bytes);
  const descriptor = descriptorForDigest(rootInput, sha256, bytes.byteLength, mediaType);
  const targetPath = resolveContentAddressedBlobPath(rootInput, descriptor);

  if (durableFileExists(targetPath)) {
    verifyBlobBytes(readFileBytes(targetPath), descriptor);
    return descriptor;
  }

  writeFileDurably(targetPath, bytes);
  verifyBlobBytes(readFileBytes(targetPath), descriptor);
  return descriptor;
}

export function readContentAddressedBlob(rootInput: HarnessLayoutInput, descriptor: ContentAddressedBlobRef): Uint8Array {
  const targetPath = resolveContentAddressedBlobPath(rootInput, descriptor);
  const bytes = readFileBytes(targetPath);
  verifyBlobBytes(bytes, descriptor);
  return bytes;
}

export function readContentAddressedTextBlob(rootInput: HarnessLayoutInput, descriptor: ContentAddressedBlobRef): string {
  return Buffer.from(readContentAddressedBlob(rootInput, descriptor)).toString("utf8");
}

export function resolveContentAddressedBlobPath(rootInput: HarnessLayoutInput, descriptor: ContentAddressedBlobRef): string {
  assertBlobRef(descriptor);
  const layout = resolveHarnessLayout(rootInput);
  const expectedRef = descriptorRef(layout.rootDir, blobPathForDigest(layout.authoredRoot, descriptor.sha256));
  if (descriptor.ref !== expectedRef) {
    throw new Error(`content-addressed blob ref does not match sha256 layout: ${descriptor.ref}`);
  }
  const targetPath = path.resolve(layout.rootDir, descriptor.ref);
  if (!isPathInsideRoot(layout.rootDir, targetPath)) {
    throw new Error(`content-addressed blob ref escapes root: ${descriptor.ref}`);
  }
  return targetPath;
}

export function isContentAddressedBlobRef(value: unknown): value is ContentAddressedBlobRef {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ContentAddressedBlobRef>;
  return typeof candidate.ref === "string" &&
    typeof candidate.sha256 === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.mediaType === "string" &&
    Number.isSafeInteger(candidate.size) &&
    candidate.size >= 0 &&
    sha256Pattern.test(candidate.sha256) &&
    candidate.mediaType.trim().length > 0;
}

function descriptorForDigest(rootInput: HarnessLayoutInput, sha256: string, size: number, mediaType: string): ContentAddressedBlobRef {
  if (mediaType.trim().length === 0) throw new Error("content-addressed blob mediaType is required");
  const layout = resolveHarnessLayout(rootInput);
  return {
    ref: descriptorRef(layout.rootDir, blobPathForDigest(layout.authoredRoot, sha256)),
    sha256,
    size,
    mediaType
  };
}

function blobPathForDigest(authoredRoot: string, sha256: string): string {
  assertSha256(sha256);
  return path.join(authoredRoot, "objects", "sha256", sha256.slice(0, 2), sha256.slice(2));
}

function descriptorRef(rootDir: string, absolutePath: string): string {
  return path.relative(rootDir, absolutePath).split(path.sep).join("/");
}

function assertBlobRef(descriptor: ContentAddressedBlobRef): void {
  if (!isContentAddressedBlobRef(descriptor)) throw new Error("invalid content-addressed blob ref");
}

function assertSha256(value: string): void {
  if (!sha256Pattern.test(value)) throw new Error(`invalid sha256 digest: ${value}`);
}

function verifyBlobBytes(bytes: Uint8Array, descriptor: ContentAddressedBlobRef): void {
  const actualSha = sha256Bytes(bytes);
  if (actualSha !== descriptor.sha256) throw new Error(`content-addressed blob sha256 mismatch: ${descriptor.ref}`);
  if (bytes.byteLength !== descriptor.size) throw new Error(`content-addressed blob size mismatch: ${descriptor.ref}`);
}

function isPathInsideRoot(rootPath: string, targetPath: string): boolean {
  const relative = path.relative(rootPath, targetPath);
  return relative.length === 0 || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
