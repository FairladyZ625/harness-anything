export const portableAsciiV2 = "portable-ascii-v2" as const;

export type ManagedObjectKind = "file" | "directory";

export type NamespaceAdmissionCode =
  | "ABSOLUTE_PATH"
  | "CASE_COLLISION"
  | "DUPLICATE_PATH"
  | "FILE_ANCESTOR"
  | "INVALID_SEGMENT"
  | "KIND_COLLISION"
  | "PATH_TOO_DEEP"
  | "PATH_TOO_LONG"
  | "RESERVED_NAME"
  | "SEGMENT_TOO_LONG"
  | "WINDOWS_ROOT_TOO_LONG"
  | "WINDOWS_TARGET_TOO_LONG";

export class NamespaceAdmissionError extends Error {
  readonly code: NamespaceAdmissionCode;
  readonly managedPath?: string;

  constructor(
    code: NamespaceAdmissionCode,
    message: string,
    managedPath?: string
  ) {
    super(message);
    this.name = "NamespaceAdmissionError";
    this.code = code;
    if (managedPath !== undefined) this.managedPath = managedPath;
  }
}

export interface PortablePathOptions {
  readonly windowsVisibleRootUnits?: number;
}

export interface PortablePathDescriptor {
  readonly policy: typeof portableAsciiV2;
  readonly path: string;
  readonly segments: ReadonlyArray<string>;
  readonly asciiBytes: number;
  readonly windowsVisibleTargetUnits?: number;
}
