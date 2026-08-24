import type {
  TemplateCatalog,
  VerticalDefinition,
} from "../../kernel/src/index.ts";
import type {
  CapabilityRefV1,
  PresetDocumentV1,
  PresetLayer,
  PresetManifestV3,
  PresetSnapshotV1,
  PresetTaskManifestV3,
} from "./preset.contract.ts";
import type { ScaffoldSelection } from "./scaffold-overlay.ts";
import path from "node:path";

export declare const decodedPackageBrand: unique symbol;

export interface DecodedPresetPackageV3 {
  readonly manifest: PresetManifestV3;
  readonly document: PresetDocumentV1;
  readonly root: string;
  readonly packageDigest: string;
  readonly manifestSha256: string;
  readonly [decodedPackageBrand]: true;
}

export interface PresetResolverOptions {
  readonly bundledRoot?: string;
  readonly userRoot: string;
  readonly assetsRoot?: string;
  readonly kernelVersion?: string;
  readonly projectScaffold?: string;
  readonly projectRoot?: string;
}

export interface Candidate {
  readonly id: string;
  readonly verticalId: string;
  readonly layer: PresetLayer;
  readonly source: string;
  readonly decoded?: DecodedPresetPackageV3;
  readonly error?: PresetFailure;
  readonly shadow?: { readonly title: string };
}

export interface PresetFailure {
  readonly code: string;
  readonly message: string;
  readonly missingProviderIds?: readonly string[];
}

export interface CatalogSource {
  readonly catalog: TemplateCatalog;
  readonly root: string;
  readonly sha256: string;
}

export interface CanonicalAssets {
  readonly vertical: VerticalDefinition;
  readonly verticalSha256: string;
  readonly catalog: CatalogSource;
  readonly providers: readonly Provider[];
}

export interface ResolverScaffoldSelection extends ScaffoldSelection {
  readonly source?: CatalogSource;
}

export interface Provider {
  readonly id: string;
  readonly kind: CapabilityRefV1["kind"];
  readonly version: string;
  readonly templateOverrides?: Readonly<Record<string, string>>;
  readonly requiredTaskClass?: "milestone" | "epic";
  readonly actionKind?: string;
  readonly payloadFields?: readonly string[];
}

export type ManifestEntrypoint = NonNullable<
  PresetTaskManifestV3["entrypoints"]
>[string];

export interface OwnedEntrypoint {
  readonly definition: ManifestEntrypoint;
  readonly root: string;
  readonly packageDigest: string;
}

export interface PresetPackageScript {
  readonly name: string;
  readonly body: string;
}

export interface InternalPresetResolution {
  readonly manifest: PresetManifestV3;
  readonly document: PresetDocumentV1;
  readonly snapshot: PresetSnapshotV1;
  readonly documents: readonly {
    readonly slot: string;
    readonly path: string;
    readonly body: string;
    readonly mediaType: "text/markdown" | "text/plain";
    readonly owner: "doc-sync";
    readonly requiredAnchors: readonly string[];
    readonly templateRef: string;
  }[];
  readonly scripts: readonly PresetPackageScript[];
  readonly requiredTaskClass?: "milestone" | "epic";
  readonly packageRoot: string;
  readonly packageDigest: string;
  readonly produceActions: Readonly<
    Record<
      string,
      { readonly actionKind: string; readonly payloadFields: readonly string[] }
    >
  >;
}

export interface RepositoryScaffoldDocument {
  readonly slot: string;
  readonly path: string;
  readonly body: string;
  readonly mediaType: "text/markdown" | "text/plain";
  readonly owner: "doc-sync";
  readonly requiredAnchors: readonly string[];
  readonly templateRef: string;
  readonly contentSha256: string;
  readonly existingSha256: string | null;
  readonly disposition: "created" | "preserved" | "drifted";
}

export interface RepositoryScaffoldPlan {
  readonly schema: "repository-scaffold-plan/v1";
  readonly rootDir: string;
  readonly verticalId: string;
  readonly verticalVersion: string;
  readonly verticalDigest: `sha256:${string}`;
  readonly baseScaffoldDigest: `sha256:${string}`;
  readonly projectOverlayPath: string | null;
  readonly projectOverlayDigest: `sha256:${string}` | null;
  readonly documents: readonly RepositoryScaffoldDocument[];
  readonly digest: `sha256:${string}`;
}
