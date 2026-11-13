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

export const identityGuiRejectionPolicy = {
  id: "identity-gui-rejection-codes",
  ownerRef: "host",
  unit: "authorization rejection code to translation key",
  bounds: "Keep the existing policy-group rejection codes mapped to their localized access-control messages.",
  defaultValue: {
    base_policy_group_read_only: "accessControl.error.baseReadOnly",
    policy_group_exists: "accessControl.error.groupExists",
    policy_group_unknown: "accessControl.error.groupUnknown",
    policy_group_in_use: "accessControl.error.groupInUse",
  },
  version: 1,
  scope: "Identity provider access-management GUI rejection presentation",
  reason:
    "Keep the GUI's existing rejection vocabulary and presentation mapping declared at the kernel policy boundary.",
  fixtures: ["packages/gui/test/access-control.vitest.tsx"],
  sources: [
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/gui-interaction-policy.ts#identityGuiRejectionPolicy.defaultValue.base_policy_group_read_only:98a37103a373fd5b52c36eb08d95c2ba",
      route: "default-base-policy-group-read-only",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/gui-interaction-policy.ts#identityGuiRejectionPolicy.defaultValue.policy_group_exists:cea53634fefb8e5866134be75cc92586",
      route: "default-policy-group-exists",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/gui-interaction-policy.ts#identityGuiRejectionPolicy.defaultValue.policy_group_unknown:0794a054e454c8b95f12e6d92e0de87d",
      route: "default-policy-group-unknown",
    },
    {
      candidateId:
        "policy:packages/kernel:packages/kernel/src/domain/gui-interaction-policy.ts#identityGuiRejectionPolicy.defaultValue.policy_group_in_use:e75fc34ea9acc4e438f402cf12a4677c",
      route: "default-policy-group-in-use",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak-gui:packages/authorization-keycloak-gui/src/access-model.ts#createAccessModel.REJECTION_KEYS.base_policy_group_read_only:98a37103a373fd5b52c36eb08d95c2ba",
      route: "base-policy-group-read-only",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak-gui:packages/authorization-keycloak-gui/src/access-model.ts#createAccessModel.REJECTION_KEYS.policy_group_exists:cea53634fefb8e5866134be75cc92586",
      route: "policy-group-exists",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak-gui:packages/authorization-keycloak-gui/src/access-model.ts#createAccessModel.REJECTION_KEYS.policy_group_unknown:0794a054e454c8b95f12e6d92e0de87d",
      route: "policy-group-unknown",
    },
    {
      candidateId:
        "policy:packages/authorization-keycloak-gui:packages/authorization-keycloak-gui/src/access-model.ts#createAccessModel.REJECTION_KEYS.policy_group_in_use:e75fc34ea9acc4e438f402cf12a4677c",
      route: "policy-group-in-use",
    },
  ],
} as const satisfies OntologyPolicyDeclaration;
