export default Object.freeze({
  id: "rebuild-gates",
  phases: ["P2"],
  projection: {
    catalog: "tools/gates/contracts/gates.projection.json",
    workflow: ".github/workflows/rebuild-gates.yml"
  },
  commands: [],
  guards: [],
  gates: [
    { id: "G04", phase: "P2", job: "gate-contract-tests", command: "node --test tools/gates/test/*.test.mjs" },
    { id: "G05", phase: "P2", job: "lint", command: "npm run lint" },
    { id: "G06", phase: "P2", job: "gate-contract-tests", command: "node --test tools/gates/test/*.test.mjs" },
    { id: "G11", phase: "P2", job: "derived-contracts", command: "node tools/gates/derived-contracts.mjs --check" },
    { id: "G12", phase: "P2", job: "lint", command: "npm run lint" },
    { id: "G17", phase: "P2", job: "evidence-contract", command: "node tools/gates/evidence-contract.mjs --event \"$GITHUB_EVENT_PATH\"" },
    { id: "G18", phase: "P2", job: "gate-contract-tests", command: "node --test tools/gates/test/*.test.mjs" },
    { id: "G19", phase: "P2", job: "lint", command: "npm run lint" },
    { id: "G20", phase: "P2", job: "platform-smoke", command: "node tools/gates/platform-smoke.mjs" },
    { id: "G23", phase: "P2", job: "schema-closure", command: "node tools/gates/schema-closure.mjs --check" },
    { id: "G24", phase: "P2", job: "gate-contract-tests", command: "node --test tools/gates/test/*.test.mjs" },
    { id: "G25", phase: "P2", job: "test-selection", command: "node tools/gates/test-selection.mjs --base \"$BASE_SHA\"" },
    { id: "G26", phase: "P2", job: "gate-contract-tests", command: "node --test tools/gates/test/*.test.mjs" },
    { id: "G30", phase: "P2", job: "clean-build", command: "node tools/gates/clean-build.mjs --temp" },
    { id: "G31", phase: "P2", job: "dependency-policy", command: "node tools/gates/dependency-policy.mjs" },
    { id: "G32", phase: "P2", job: "line-budget", command: "node tools/gates/line-budget.mjs --base \"$BASE_SHA\"" },
    { id: "G33", phase: "P2", job: "production-delta", command: "node tools/gates/production-delta.mjs --base \"$BASE_SHA\"" },
    { id: "G35", phase: "P2", job: "anti-entropy-review", command: "node tools/gates/anti-entropy-review.mjs --event \"$GITHUB_EVENT_PATH\"", required: false }
  ],
  schemas: [{
    id: "receipt",
    schema: "tools/gates/receipt-contract.mjs#RECEIPT_SCHEMA",
    parser: "tools/gates/receipt-contract.mjs#validateReceipt",
    writer: "tools/gates/receipt-contract.mjs#createReceipt",
    error: "tools/gates/receipt-contract.mjs#ReceiptContractError",
    negativeFixtures: ["tools/gates/test/fixtures/receipt-missing-next-action.json"]
  }]
});
