import type { FdeDomainDraft, FdeLocale } from "./domain-draft.ts";

export interface FdeMaterializedFile {
  readonly relativePath: string;
  readonly body: string;
  readonly sha256: string;
}

export interface FdeHtmlPreviews {
  readonly explainerHtml: string;
  readonly projectAtlasHtml: string;
}

export interface FdeDossierValidation {
  readonly ok: boolean;
  readonly error?: string;
}

export interface FdeCompiledPackage {
  readonly verticalId: string;
  readonly slug: string;
  readonly title: string;
  readonly relativeTargetDir: string;
  readonly defaultPresetId: string;
  readonly workPresetId: string;
  readonly files: readonly FdeMaterializedFile[];
  readonly htmlPreviews: FdeHtmlPreviews;
  readonly dossierValidation: FdeDossierValidation;
}

export interface FdeSimulatedDocument {
  readonly slot: string;
  readonly path: string;
  readonly mediaType: string;
  readonly contentSha256: string;
  readonly body: string;
}

export interface FdeSimulatedGateProbe {
  readonly expected: "pass" | "fail";
  readonly ok: boolean;
  readonly result: "pass" | "fail" | "error";
  readonly diagnostic: string;
  readonly predicateIssues: readonly string[];
  readonly predicate?: Readonly<Record<string, unknown>>;
  readonly blockerCode?: string | null;
}

export interface FdeSimulatedGate {
  readonly gateId: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly presetId: string;
  readonly profileId: string;
  readonly ok: boolean;
  readonly positive: FdeSimulatedGateProbe;
  readonly negative: FdeSimulatedGateProbe;
}

export interface FdeSimulatedDiagnostic {
  readonly scope: "vertical" | "bootstrap" | "agents" | "materialization" | "gate" | "user-pointer";
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly remediation?: string;
}

export interface FdeSimulateReportDto {
  readonly schema: "vertical-simulate-report/v1";
  readonly ok: boolean;
  readonly zeroLedgerWrites: true;
  readonly locale: FdeLocale;
  readonly vertical: {
    readonly id: string | null;
    readonly title: string | null;
    readonly version: string | null;
    readonly source: string;
    readonly valid: boolean;
    readonly issues: readonly { readonly code: string; readonly message: string }[];
  };
  readonly bootstrap: {
    readonly ok: boolean;
    readonly defaultPresetId: string | null;
    readonly defaultProfileId: string | null;
    readonly workPresetId: string | null;
    readonly issues: readonly { readonly code: string; readonly message: string }[];
  };
  readonly agents: {
    readonly ok: boolean;
    readonly ids: readonly string[];
    readonly declarations: readonly {
      readonly id: string;
      readonly name: string;
      readonly role: string;
      readonly instructions: string;
    }[];
    readonly issues: readonly { readonly code: string; readonly message: string }[];
  };
  readonly previews: {
    readonly repository: readonly FdeSimulatedDocument[];
    readonly regularTask: {
      readonly presetId: string;
      readonly profileId: string;
      readonly outputShape: string;
      readonly completionGates: readonly string[];
      readonly snapshotDigest: string;
      readonly documents: readonly FdeSimulatedDocument[];
    } | null;
    readonly workTask: {
      readonly presetId: string;
      readonly profileId: string;
      readonly outputShape: string;
      readonly snapshotDigest: string;
      readonly documents: readonly FdeSimulatedDocument[];
    } | null;
  };
  readonly gates: readonly FdeSimulatedGate[];
  readonly diagnostics: readonly FdeSimulatedDiagnostic[];
}

export interface FdeSimulationResult {
  readonly compiled: FdeCompiledPackage;
  readonly report: FdeSimulateReportDto;
}

export interface FdePersistResult {
  readonly ok: boolean;
  readonly mode: "dry-run" | "apply";
  readonly verticalId: string;
  readonly targetDir: string;
  readonly created: readonly string[];
  readonly overwritten: readonly string[];
  readonly nextAction: string;
}

export interface FdeBootstrapPayload {
  readonly rootDir: string;
  readonly draft: FdeDomainDraft;
  readonly daemonConnected: boolean;
  readonly installedVerticals: readonly { readonly id: string; readonly title: string; readonly source?: string }[];
}
