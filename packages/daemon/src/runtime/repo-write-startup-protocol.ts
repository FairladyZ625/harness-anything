interface RepoWriteStartupFrameBase {
  readonly protocol: "harness-repo-write-ipc/v1";
  readonly repoId: string;
  readonly generation: number;
}

export const repoWriteStartupProgressPhases = [
  "artifact-identity",
  "authority-manifest",
  "conflict-marker-preflight",
  "runtime-create",
  "runtime-start",
  "authority-lifecycle-compose",
  "authority-start-repo",
  "historical-recovery-scan",
  "historical-recovery",
  "child-host-start"
] as const;

export type RepoWriteStartupProgressPhase = typeof repoWriteStartupProgressPhases[number];

export interface RepoWriteStartupProgressFrame extends RepoWriteStartupFrameBase {
  readonly kind: "startup-progress";
  readonly phase: RepoWriteStartupProgressPhase;
  readonly workUnit: string;
}
