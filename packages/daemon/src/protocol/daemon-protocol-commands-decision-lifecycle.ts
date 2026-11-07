import {
  defineEdgeReplicaQueryOnlyReadCommand,
  defineCenterForwardWriteCommand,
  defineCliCommand,
  cliInput,
  decisionProposalDefaultJsonFields,
  decisionProposalJsonFields,
  decisionProposalRequiredJsonFields,
  defineLedgerWriteCommand,
  workspacePathFormat,
} from "@harness-anything/preset/internal/preset-command-contract";

const defineCenterForwardArbiterCommand = <
  const Command extends {
    readonly path: readonly string[];
    readonly inputs: readonly ReturnType<typeof cliInput>[];
  },
>(
  declaration: Command,
) =>
  defineCliCommand({
    ...declaration,
    commandClass: "arbiter" as const,
    admission: {
      local: "direct" as const,
      "remote-proxy": "rejected" as const,
      "remote-center": "direct" as const,
      "remote-edge": "via-center-forward" as const,
    },
  });

export const decisionLifecycleProtocolCommands = Object.freeze([
  ...["assign", "unassign"].map((operation) =>
    defineCenterForwardWriteCommand({
      id: `decision-${operation}`,
      phase: "DecisionFact-B",
      path: ["decision", operation, "<id>"],
      summary:
        operation === "assign"
          ? "Assign a Decision to a person, node or team."
          : "Remove the current Decision assignment.",
      method: "repo.task.run",
      inputs: [
        cliInput(
          "--expected-version",
          "single",
          true,
          { code: "missing_field" },
          { pathKind: "non-path", projection: "number" },
        ),
        ...(operation === "assign"
          ? [
              cliInput(
                "--person",
                "single",
                false,
                { code: "invalid_field" },
                { pathKind: "non-path", field: "personId" },
              ),
              cliInput("--node", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "nodeId" }),
              cliInput("--team", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "teamId" }),
              cliInput(
                "--expires-at",
                "single",
                false,
                { code: "invalid_field" },
                { pathKind: "non-path", field: "expiresAt" },
              ),
            ]
          : []),
      ],
      actionConstraints: operation === "assign" ? [["personId", "nodeId", "teamId"]] : [],
    }),
  ),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "decision-validate",
    actionKind: "decision-validate",
    phase: "DecisionFact-B",
    path: ["decision", "validate", "[id]"],
    summary: "Read-only validation of one or all Decision packages, pins, and amend history.",
    method: "repo.task.read",
    inputs: [
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineEdgeReplicaQueryOnlyReadCommand({
    id: "decision-verify",
    actionKind: "decision-validate",
    phase: "DecisionFact-B",
    path: ["decision", "verify", "[id]"],
    summary: "Read-only content-pin verification alias; reports every warning without rewriting.",
    method: "repo.task.read",
    inputs: [
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineLedgerWriteCommand({
    id: "decision-rematerialize",
    phase: "DecisionFact-B",
    path: ["decision", "rematerialize"],
    summary: "Re-render one Decision's or every Decision's managed document from the current canonical projection.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--all",
        "boolean",
        false,
        {
          code: "invalid_field",
        },
        { conflictsWith: ["--id"] },
      ),
      cliInput(
        "--id",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "decisionId", conflictsWith: ["--all"] },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-repin",
    payloadFields: [{ field: "decisionId", type: "string", required: false }],
    phase: "DecisionFact-B",
    path: ["decision", "repin", "[id]"],
    summary: "Append current v1 content pins to one Decision or every Decision in a migration batch.",
    method: "repo.task.run",
    inputs: [
      cliInput("--all", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--migration-evidence",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^task/[^/]+/[^/]+$" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-propose",
    payloadFields: [
      ...decisionProposalJsonFields.map((field) => ({
        field,
        type: ["chosen", "rejected", "claims", "fulfillments"].includes(field)
          ? ("json-object-array" as const)
          : field === "appliesTo"
            ? ("json-object" as const)
            : ("string" as const),
        required: false,
        wire: { maxLength: 32 * 1024 },
      })),
    ],
    phase: "DecisionFact-B",
    path: ["decision", "propose"],
    summary: "Propose an immutable Decision from one structured packet.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--from-file",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          jsonFields: decisionProposalRequiredJsonFields,
          jsonAllowedFields: decisionProposalJsonFields,
          jsonDefaultFields: decisionProposalDefaultJsonFields,
          pathKind: "workspace-file",
          pathReader: "workspace-text",
          zeroHit: "not-a-selection",
          format: workspacePathFormat,
          conflictsWith: ["--json-input"],
        },
      ),
      cliInput(
        "--json-input",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          pathKind: "non-path",
          jsonFields: decisionProposalRequiredJsonFields,
          jsonAllowedFields: decisionProposalJsonFields,
          jsonDefaultFields: decisionProposalDefaultJsonFields,
          format: "<json|@->",
          conflictsWith: ["--from-file"],
        },
      ),
      cliInput(
        "--body",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          pathKind: "non-path",
          requiresAny: ["--from-file", "--json-input"],
          conflictsWith: ["--body-file"],
          maxLength: 32 * 1024,
        },
      ),
      cliInput(
        "--body-file",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          requiresAny: ["--from-file", "--json-input"],
          pathKind: "workspace-file",
          pathReader: "workspace-text",
          zeroHit: "not-a-selection",
          format: workspacePathFormat,
          conflictsWith: ["--body"],
          wire: { omit: true },
        },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-transition",
    payloadFields: [{ field: "targetState", type: "string", required: true, enum: ["superseded", "outcome_retired"] }],
    phase: "DecisionFact-B",
    path: ["decision", "transition", "<superseded|outcome_retired>", "<id>"],
    summary: "Bookkeeping transition of an in_effect Decision; adjudication uses decision accept/reject/defer.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--decided-at",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-accept",
    phase: "DecisionFact-B",
    path: ["decision", "accept", "<id>"],
    summary: "Adjudicate a proposed Decision as in_effect; carries explicit human consent when given.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
        },
        {
          pathKind: "non-path",
          requiresAny: ["claim-to-evidence relation", "--judgment-only"],
          regex: "^[\\s\\S]{1,199}$",
        },
      ),
      cliInput(
        "--judgment-only",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          pathKind: "non-path",
          requires: ["--rationale"],
          regex: "^[\\s\\S]{1,199}$",
          field: "judgmentOnlyRationale",
          wire: { nullable: true },
        },
      ),
      cliInput("--review-id", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--expected-digest", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput(
        "--consent-by",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-at", "--consent-channel"] },
      ),
      cliInput(
        "--consent-at",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-by"] },
      ),
      cliInput(
        "--consent-channel",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-by"], regex: "^(chat|cli|gui)$" },
      ),
    ],
  }),
  defineCenterForwardArbiterCommand({
    id: "decision-reject",
    phase: "DecisionFact-B",
    path: ["decision", "reject", "<id>"],
    summary: "Adjudicate a proposed Decision as rejected; carries explicit human consent when given.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "reason", regex: "^[\\s\\S]{1,199}$" },
      ),
      cliInput(
        "--consent-by",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-at", "--consent-channel"] },
      ),
      cliInput(
        "--consent-at",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-by"] },
      ),
      cliInput(
        "--consent-channel",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-by"], regex: "^(chat|cli|gui)$" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-defer",
    phase: "DecisionFact-B",
    path: ["decision", "defer", "<id>"],
    summary: "Adjudicate a proposed Decision as deferred.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--rationale",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", field: "reason", regex: "^[\\s\\S]{1,199}$" },
      ),
      cliInput(
        "--consent-by",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-at", "--consent-channel"] },
      ),
      cliInput(
        "--consent-at",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-by"] },
      ),
      cliInput(
        "--consent-channel",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-by"], regex: "^(chat|cli|gui)$" },
      ),
    ],
  }),
  defineCenterForwardArbiterCommand({
    id: "decision-review",
    payloadFields: [
      { field: "reviewId", type: "string", required: true },
      { field: "reviewContentDigest", type: "string", required: true },
      { field: "verdict", type: "string", required: true },
      { field: "reason", type: "string", required: true },
      { field: "findings", type: "json-object-array", required: true },
      { field: "evidenceChecked", type: "string-array", required: true },
      { field: "reportRef", type: "string", required: true },
    ],
    phase: "DecisionFact-B",
    path: ["decision", "review", "<id>"],
    summary:
      "Record an independent review of the current Decision content cut; changes_requested must name findings, " +
      "then the proposal owner responds to each with ha decision respond-review.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--from-file",
        "single",
        true,
        { code: "invalid_field" },
        {
          pathKind: "workspace-file",
          pathReader: "workspace-text",
          zeroHit: "not-a-selection",
          format: workspacePathFormat,
          jsonAllowedFields: [
            "reviewId",
            "reviewContentDigest",
            "verdict",
            "reason",
            "findings",
            "evidenceChecked",
            "reportRef",
          ],
          jsonFields: [
            "reviewId",
            "reviewContentDigest",
            "verdict",
            "reason",
            "findings",
            "evidenceChecked",
            "reportRef",
          ],
        },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-dispatch-review",
    phase: "DecisionFact-B",
    path: ["decision", "dispatch-review", "<id>"],
    summary:
      "Dispatch one read-only independent reviewer for the current Decision content cut; the receipt names its " +
      "reviewContentDigest and runtime to wait for.",
    method: "repo.task.run",
    inputs: [
      cliInput("--agent", "single", false, { code: "invalid_field" }, { pathKind: "non-path", field: "agentId" }),
      cliInput(
        "--instance",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", field: "runtimeInstanceId" },
      ),
      cliInput("--model", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
      cliInput("--effort", "single", false, { code: "invalid_runtime_effort" }, { pathKind: "non-path" }),
      cliInput("--expected-digest", "single", false, { code: "invalid_field" }, { pathKind: "non-path" }),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-respond-review",
    payloadFields: [{ field: "responses", type: "json-object-array", required: true }],
    phase: "DecisionFact-B",
    path: ["decision", "respond-review", "<id>"],
    summary:
      "Respond to each finding with adopt (name the corresponding change) or rebut (give the reason). A response " +
      "does not clear changes_requested; only a new content cut or authorized override does.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--from-file",
        "single",
        true,
        { code: "invalid_field" },
        {
          pathKind: "workspace-file",
          pathReader: "workspace-text",
          zeroHit: "not-a-selection",
          format: workspacePathFormat,
          jsonAllowedFields: ["responses"],
          jsonFields: ["responses"],
        },
      ),
    ],
  }),
  defineCenterForwardArbiterCommand({
    id: "decision-override-review",
    payloadFields: [
      { field: "reviewContentDigest", type: "string", required: true },
      { field: "reviewIds", type: "string-array", required: true },
      { field: "reason", type: "string", required: true },
    ],
    phase: "DecisionFact-B",
    path: ["decision", "override-review", "<id>"],
    summary:
      "Override named changes_requested reviewIds with a reason. This requires arbiter authority; an agent also " +
      "requires explicit authenticated human consent.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--from-file",
        "single",
        true,
        { code: "invalid_field" },
        {
          pathKind: "workspace-file",
          pathReader: "workspace-text",
          zeroHit: "not-a-selection",
          format: workspacePathFormat,
          jsonAllowedFields: ["reviewContentDigest", "reviewIds", "reason"],
          jsonFields: ["reviewContentDigest", "reviewIds", "reason"],
        },
      ),
      cliInput(
        "--consent-by",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-at", "--consent-channel"] },
      ),
      cliInput(
        "--consent-at",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-by"] },
      ),
      cliInput(
        "--consent-channel",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-by"], regex: "^(chat|cli|gui)$" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-retire",
    phase: "DecisionFact-B",
    path: ["decision", "retire", "<id>"],
    summary: "Deprecated alias for decision transition outcome_retired.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--reason",
        "single",
        true,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path", regex: "^[\\s\\S]{1,199}$" },
      ),
    ],
  }),
  defineCenterForwardWriteCommand({
    id: "decision-amend",
    payloadFields: [
      { field: "fulfillments", type: "json-object-array", required: false },
      {
        field: "loadBearing",
        type: "json-object",
        required: false,
        fields: [
          { field: "claimId", type: "string", required: true },
          { field: "value", type: "boolean", required: true },
        ],
      },
      { field: "nonLoadBearing", type: "string", required: false, wire: { omit: true } },
      { field: "body", type: "string", required: false, wire: { maxLength: 32 * 1024 } },
    ],
    phase: "DecisionFact-B",
    path: ["decision", "amend", "<id>"],
    summary: "Replace or append declared Decision content with an audit reason; in_effect requires owner consent.",
    method: "repo.task.run",
    inputs: [
      cliInput(
        "--reason",
        "single",
        true,
        { code: "invalid_field" },
        { pathKind: "non-path", regex: "^[\\s\\S]{1,199}$" },
      ),
      cliInput(
        "--title",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput("--standing-policy", "boolean", false, {
        code: "invalid_field",
      }),
      cliInput(
        "--fulfillment",
        "repeated",
        false,
        {
          code: "invalid_field",
        },
        {
          pathKind: "non-path",
          regex: "^C[A-Za-z0-9_-]+:(?:evidenced|delivered|standing_policy)$",
          wire: { omit: true },
        },
      ),
      cliInput(
        "--load-bearing",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--non-load-bearing",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput("--set", "repeated", false, { code: "invalid_field" }, { pathKind: "non-path", field: "sets" }),
      cliInput("--append", "repeated", false, { code: "invalid_field" }, { pathKind: "non-path", field: "appends" }),
      cliInput(
        "--body",
        "single",
        false,
        {
          code: "invalid_field",
        },
        { pathKind: "non-path" },
      ),
      cliInput(
        "--body-file",
        "single",
        false,
        {
          code: "invalid_field",
        },
        {
          pathKind: "workspace-file",
          pathReader: "workspace-text",
          zeroHit: "not-a-selection",
          format: workspacePathFormat,
          wire: { omit: true },
        },
      ),
      cliInput(
        "--consent-by",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-at", "--consent-channel"] },
      ),
      cliInput(
        "--consent-at",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-by"] },
      ),
      cliInput(
        "--consent-channel",
        "single",
        false,
        { code: "invalid_field" },
        { pathKind: "non-path", requires: ["--consent-by"], regex: "^(chat|cli|gui)$" },
      ),
      cliInput("--dry-run", "boolean", false, {
        code: "invalid_field",
      }),
    ],
  }),
] as const);
