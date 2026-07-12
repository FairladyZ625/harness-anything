import type { PlatformKind } from "./types.ts";

export const metadataPolicyFields = {
  macos: [
    "ownership.uid-gid",
    "posix-mode-projection",
    "acl.entries-inheritance",
    "file-flags",
    "xattrs.finder-quarantine"
  ],
  linux: [
    "ownership.uid-gid",
    "posix-default-acl-mask",
    "selinux.label-transition",
    "file-capabilities",
    "file-flags.immutable-append",
    "xattrs.allowed-set"
  ],
  wsl: [
    "ownership.uid-gid",
    "posix-default-acl-mask",
    "selinux.label-transition",
    "file-capabilities",
    "file-flags.immutable-append",
    "xattrs.allowed-set"
  ],
  "windows-native": [
    "owner-sid",
    "dacl.aces-order-inheritance",
    "integrity-label",
    "efs-compression-flags",
    "ads.named-set",
    "reparse-object-kind"
  ]
} as const satisfies Record<PlatformKind, ReadonlyArray<string>>;

export type MetadataFieldDisposition =
  | { readonly disposition: "required" }
  | { readonly disposition: "allowed-exact-set"; readonly values: ReadonlyArray<string> }
  | { readonly disposition: "forbidden" };

export interface PlatformMetadataPolicy {
  readonly version: string;
  readonly platform: PlatformKind;
  readonly fields: Readonly<Record<string, MetadataFieldDisposition | undefined>>;
}

export interface MetadataPolicyValidation {
  readonly complete: boolean;
  readonly missingFields: ReadonlyArray<string>;
  readonly unknownFields: ReadonlyArray<string>;
}

export function draftPlatformMetadataPolicy(platform: PlatformKind): PlatformMetadataPolicy {
  return { version: "L-14-unresolved", platform, fields: {} };
}

export function validatePlatformMetadataPolicy(policy: PlatformMetadataPolicy): MetadataPolicyValidation {
  const declared = new Set<string>(metadataPolicyFields[policy.platform]);
  const missingFields = [...declared].filter((field) => policy.fields[field] === undefined);
  const unknownFields = Object.keys(policy.fields).filter((field) => !declared.has(field)).sort();
  return {
    complete: missingFields.length === 0 && unknownFields.length === 0,
    missingFields,
    unknownFields
  };
}
