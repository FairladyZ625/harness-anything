import type { OntologyPolicyDeclaration } from "./ontology-source.ts";

/** Existing desktop read, presentation and request budgets; consumers do not choose new defaults. */
export const guiInteractionPolicy = {
  id: "gui-interaction",
  ownerRef: "host",
  unit: "rows / pages / characters / milliseconds / query retries",
  bounds:
    "Existing bounded desktop reads, preview sizes and request deadlines; no automatic retry for explicit read failures.",
  defaultValue: {
    pageSizes: {
      agenda: 100,
      artifacts: 100,
      agentGroups: 60,
      relationGraph: 500,
      facts: 500,
      workspaceScope: 100,
      sessionGroups: 1000,
      squadRuns: 1000,
      taskTree: 300,
      observeFollow: 5_000,
      fleetGroups: 1000,
      cadenceEvents: 4_096,
      recent: 12,
      tasks: 500,
      taskDispatch: 16,
      endedFloor: 12,
    },
    pages: {
      cadenceHistory: 16,
      taskHydration: 12,
    },
    text: {
      toolPayload: 2_000,
      observeDetail: 2_000,
      cadenceSummary: 140,
      workspaceTitle: 48,
      sessionDetail: 8_000,
    },
    presentation: {
      sameDayCluster: 2,
      frictionAlert: 2,
    },
    deadlines: {
      serviceInstall: 120_000,
      bootstrap: 75_000,
      instanceKey: 75_000,
      repoWrite: 20_000,
      instanceOperation: 20_000,
      instanceShow: 2_000,
      sessionAuth: 1_000,
      startup: 30_000,
    },
    startWorkRisk: "medium",
    terminalProposedApi: true,
    shell: {
      spawnRequiresUserAction: true,
      hiddenCommandInjectionAllowed: false,
      outputCreatesTaskState: false,
      outputCreatesEvidence: false,
    },
    center: { port: 7545, mirrorBytes: 50 * 1024 * 1024 * 1024 },
    polls: { sessionBinding: 40, providerSelfTest: 80, runtimeSpawn: 80, daemonControl: 80 },
    retry: false,
  },
  version: 1,
  scope: "Desktop projections, bounded previews and local request deadlines",
  reason:
    "One declaration owns the existing desktop budgets; transport, pagination and rendering retain their behavior.",
  fixtures: ["packages/gui/test/query-pacing.vitest.ts", "packages/gui/test/task-read-response.test.ts"],
  sources: [
    "policy:packages/kernel:packages/kernel/src/domain/gui-interaction-policy.ts#guiInteractionPolicy.defaultValue.deadlines:3ca5f06bf8f7f65497534475285912f4",
    "policy:packages/kernel:packages/kernel/src/domain/gui-interaction-policy.ts#guiInteractionPolicy.defaultValue.shell.hiddenCommandInjectionAllowed:a8afd8bf461fe976039c024eb8ef883f",
    "policy:packages/kernel:packages/kernel/src/domain/gui-interaction-policy.ts#guiInteractionPolicy.defaultValue.retry:f4bc68586c42d270647259214461f126",
  ].map((candidateId) => ({ candidateId, route: "guiInteractionPolicy" })),
} as const satisfies OntologyPolicyDeclaration;
