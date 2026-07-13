import { NamespaceAdmissionError, portableAsciiV2, type PortablePathDescriptor, type PortablePathOptions } from "./types.ts";

const portableSegment = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*|\.[A-Za-z0-9_][A-Za-z0-9._-]*)$/u;
const windowsDeviceNames = new Set([
  "CON", "PRN", "AUX", "NUL", "CLOCK$", "CONIN$", "CONOUT$",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`)
]);
const reservedFoldedSegments = new Set([
  ".git", ".gitmodules", ".hg", ".svn", ".ha", ".ha-state",
  ".harness-state", ".staging", ".quarantine", ".tombstones",
  ".conflicts", ".ds_store", "desktop.ini", "thumbs.db"
]);

export function validatePortableManagedPath(
  managedPath: string,
  options: PortablePathOptions = {}
): PortablePathDescriptor {
  if (managedPath.length === 0 || managedPath.startsWith("/") || /^[A-Za-z]:/u.test(managedPath) || managedPath.startsWith("\\")) {
    throw failure("ABSOLUTE_PATH", managedPath, "managed path must be a non-empty relative path");
  }
  if (!isAscii(managedPath) || managedPath.includes("\\") || managedPath.includes(":")) {
    throw failure("INVALID_SEGMENT", managedPath, "managed path must contain only portable ASCII segments separated by '/'");
  }
  const asciiBytes = Buffer.byteLength(managedPath, "ascii");
  if (asciiBytes > 180) throw failure("PATH_TOO_LONG", managedPath, `managed path is ${asciiBytes} bytes; maximum is 180`);
  const segments = managedPath.split("/");
  if (segments.length > 16) throw failure("PATH_TOO_DEEP", managedPath, `managed path has ${segments.length} segments; maximum is 16`);
  for (const segment of segments) validateSegment(segment, managedPath);

  const rootUnits = options.windowsVisibleRootUnits;
  if (rootUnits !== undefined) {
    if (!Number.isSafeInteger(rootUnits) || rootUnits < 0 || rootUnits > 59) {
      throw failure("WINDOWS_ROOT_TOO_LONG", managedPath, "Windows visible root must be 0..59 UTF-16 code units");
    }
    const targetUnits = rootUnits + 1 + managedPath.length;
    if (targetUnits > 240) {
      throw failure("WINDOWS_TARGET_TOO_LONG", managedPath, `Windows visible target is ${targetUnits} UTF-16 code units; maximum is 240`);
    }
    return { policy: portableAsciiV2, path: managedPath, segments, asciiBytes, windowsVisibleTargetUnits: targetUnits };
  }
  return { policy: portableAsciiV2, path: managedPath, segments, asciiBytes };
}

export function foldPortableComponent(segment: string): string {
  let folded = "";
  for (let index = 0; index < segment.length; index += 1) {
    const code = segment.charCodeAt(index);
    folded += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : segment[index];
  }
  return folded;
}

export function compareCanonicalPathBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"));
}

function validateSegment(segment: string, managedPath: string): void {
  const bytes = Buffer.byteLength(segment, "ascii");
  if (bytes > 112) throw failure("SEGMENT_TOO_LONG", managedPath, `segment ${JSON.stringify(segment)} is ${bytes} bytes; maximum is 112`);
  if (!portableSegment.test(segment) || segment.endsWith(".")) {
    throw failure("INVALID_SEGMENT", managedPath, `segment ${JSON.stringify(segment)} does not match portable-ascii-v2 grammar`);
  }
  const folded = foldPortableComponent(segment);
  const deviceStem = segment.trimEnd().split(".", 1)[0]!.toUpperCase();
  if (windowsDeviceNames.has(deviceStem) || reservedFoldedSegments.has(folded) || folded.startsWith(".ha-")) {
    throw failure("RESERVED_NAME", managedPath, `segment ${JSON.stringify(segment)} is reserved by portable-ascii-v2`);
  }
}

function isAscii(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

function failure(code: ConstructorParameters<typeof NamespaceAdmissionError>[0], managedPath: string, message: string): NamespaceAdmissionError {
  return new NamespaceAdmissionError(code, `${portableAsciiV2}: ${message}`, managedPath);
}
