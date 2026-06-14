export interface MigratePlanAction {
  readonly kind: "migrate-plan";
  readonly limit: number;
}

export interface MigrateStructureAction {
  readonly kind: "migrate-structure";
  readonly mode: "plan" | "apply";
  readonly confirmPlan: boolean;
}

export interface MigrateRunAction {
  readonly kind: "migrate-run";
  readonly planOnly: boolean;
  readonly outDir: string;
  readonly locale?: "zh-CN" | "en-US";
  readonly assumeLocale?: "zh-CN" | "en-US";
  readonly allowDirty: boolean;
  readonly sessionDir?: string;
}

export interface MigrateVerifyAction {
  readonly kind: "migrate-verify";
  readonly sessionPath?: string;
  readonly fullCutover: boolean;
}

export interface LegacyScanAction {
  readonly kind: "legacy-scan";
  readonly sourcePath: string;
}

export interface LegacyIntakePlanAction {
  readonly kind: "legacy-intake-plan";
  readonly sourcePath: string;
  readonly outPath?: string;
}

export interface LegacyCopySafeDocsAction {
  readonly kind: "legacy-copy-safe-docs";
  readonly sourcePath: string;
  readonly apply: boolean;
}

export interface LegacyIndexAction {
  readonly kind: "legacy-index";
  readonly sourcePath: string;
  readonly apply: boolean;
}

export interface LegacyVerifyAction {
  readonly kind: "legacy-verify";
}
