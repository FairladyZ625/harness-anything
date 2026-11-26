import type { OntologyJudgmentDeclaration } from "./ontology-source.ts";

export const daemonResidentCeoPolicySources = [
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-runtime-api.ts#createDaemonHostRuntimeApi.residentCeoService.service.runtime.run.receipt.mcpPolicy:10b79b4f8c0b0052d770c191c1551d40",
    "residentCeoRuntime",
    "Resident CEO runtime turns use the disabled MCP policy.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-runtime-api.ts#createDaemonHostRuntimeApi.watchResidentCeoInbox.run.page.limit:0dd585c292e12f6bf0b47a1d330750d6",
    "residentCeoInbox",
    "Resident CEO inbox reads use the bounded page limit.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-runtime-api.ts#createDaemonHostRuntimeApi.watchResidentCeoInbox.run.receipt.limit:5fe71253427187a597c501af26bb9f84",
    "residentCeoInbox",
    "Resident CEO peer inbox scans use the bounded 20-item page limit.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/daemon-host-runtime-api.ts#createDaemonHostRuntimeApi.watchResidentCeoInbox.run.page.limit:bf38217595aafee0d2b364031d7e7000",
    "residentCeoInbox",
    "Resident CEO event reads use the bounded page limit.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#buildResidentCeoPeerPrompt:ed03e4ff9cc327445ad8ae55bc63ef7b",
    "residentCeoDelegation",
    "Resident CEO emits structured delegation proposal prompts only under approval-gated policy.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#lookupOpenPeerRequest.receipt.limit:5fe71253427187a597c501af26bb9f84",
    "residentCeoDelegation",
    "Resident CEO peer request lookup uses the bounded 20-item page limit.",
  ],
  [
    "policy:packages/daemon:packages/daemon/src/daemon-host/resident-ceo-delegation.ts#settleResidentCeoPeerTurn:092bbbc27f58fc12928e8b0326d90384",
    "residentCeoDelegation",
    "Resident CEO records structured proposals instead of advisory replies only under approval-gated policy.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#assertResidentCeoExecutionAllowed:5901726fc470828d319870e7e7bcc4d9",
    "residentCeoExecutionPolicy",
    "Resident CEO write actions require explicit approval-gated execution policy.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#evaluateResidentCeoAutoApproval:a95900d267414754d1c9627eee2f8b93",
    "residentCeoExecutionPolicy",
    "Resident CEO allowlist auto-approval requires explicit approval-gated execution policy.",
  ],
  [
    "policy:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#createResidentCeoProfile:08f270fc2b07c6f7ddcfa00ad67d112f",
    "residentCeoExecutionPolicy",
    "Resident CEO profile creation enforces valid execution policy and bounded heartbeat interval.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.commitProfileMutation.attempt:11ab76e8d0c02192aa2b1be4c6731dd8",
    "residentCeoProfileCas",
    "Resident CEO profile mutations retry optimistic CAS conflicts with a bounded 4-attempt ceiling.",
  ],
  [
    "policy:packages/application:packages/application/src/resident-ceo.ts#makeResidentCeoService.commitProfileMutation:5c2f8dd8bfc1d1749c78cdabdbb1d1cc",
    "residentCeoProfileCas",
    "Resident CEO profile CAS retry rethrows immediately on non-conflict errors or after the final attempt.",
  ],
] as const;

export const residentCeoJudgments = [
  {
    id: "resident-ceo-principal",
    symbol: "packages/kernel/src/domain/resident-ceo.ts#assertResidentCeoPrincipal",
    inputs: ["ResidentCeoProfile", "principalPersonId"],
    output: "void or ResidentCeoProfileError",
    failureCodes: ["resident_ceo_principal_mismatch"],
    explain: "A resident CEO profile may only be read or updated by its anchored principal person.",
    consumers: [
      "packages/application/src/resident-ceo.ts",
      "packages/daemon/src/daemon-host/daemon-host-runtime-api.ts",
    ],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#assertResidentCeoPrincipal:c8c638e607792c3b9b5abdb5048786bd",
        route: "assertResidentCeoPrincipal",
      },
    ],
  },
  {
    id: "resident-ceo-execution-policy",
    symbol: "packages/kernel/src/domain/resident-ceo.ts#assertResidentCeoExecutionAllowed",
    inputs: ["ResidentCeoProfile", "operation"],
    output: "void or ResidentCeoProfileError",
    failureCodes: ["resident_ceo_advisory_only"],
    explain:
      "Resident CEO delegation proposal creation, approval, and rejection require explicit approval-gated execution policy.",
    consumers: ["packages/application/src/resident-ceo.ts"],
    sources: [
      {
        candidateId:
          "judgment:packages/kernel:packages/kernel/src/domain/resident-ceo.ts#assertResidentCeoExecutionAllowed:e325546d97d4576b94f165c0426257a3",
        route: "assertResidentCeoExecutionAllowed",
      },
    ],
  },
] as const satisfies readonly OntologyJudgmentDeclaration[];
