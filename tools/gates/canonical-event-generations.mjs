// Generation 2 migration retains historical generation bytes verbatim.
// These exact samples must remain readable by the offline reader and rejected by live admission.
export const readOnlyGenerationOneFixtures = new Map([
  [
    "packages/kernel/fixtures/canonical-events/ci-run-observation-v1/accepted.json",
    "3db3ee9de714fc15f0c0755e242469bb9282d57f640d0ea0879e83db73d21922",
  ],
  [
    "packages/kernel/fixtures/canonical-events/entity-event-v1/accepted-entity-upserted-ddcb7509cb2d.json",
    "cc77bba8eecd33be8f75f0cdb02c582d2c0540bb06a17e3e61fafb8d9c053552",
  ],
  [
    "packages/kernel/fixtures/canonical-events/entity-event-v1/accepted.json",
    "c2bfed9d4edeeba42b38bd5c04f6c8ce0517f1e19493658463b8d109d158b2dc",
  ],
  [
    "packages/kernel/fixtures/canonical-events/agent-entity-event-v1/accepted.json",
    "f785139f3f194184eaad8521a750a4f5f3481097e36404dab5e4e81efa74b4fb",
  ],
]);
