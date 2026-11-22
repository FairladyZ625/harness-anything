// harness-test-tier: integration
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { completionContractGap, readSettingsFacet } from "@harness-anything/kernel";
import { listBundledAgentDeclarationIds, readBundledAgentDeclaration, runPresetAction } from "@harness-anything/preset";
import { openPersistentWriterEpoch } from "@harness-anything/storage";
import { readAgentDeclarationResolution } from "../src/daemon-host/agent-declaration-resolution.ts";
import { canonicalRoot, workspaceId } from "../src/daemon-host/protocol/daemon-protocol.contract.ts";
import { resolveRepoBootstrap } from "../src/daemon-host/repo-bootstrap.ts";
import type { DaemonAuthenticationContext } from "../src/daemon-host/transport/auth-context.ts";
import { withPolicyGroup } from "./keycloak-policy.fixtures.ts";
import { openFencedRepoCell } from "./repo-settings.fixture.ts";

type OpenedCell = Awaited<ReturnType<typeof openFencedRepoCell>>;

const ownerAuth = {
  transportKind: "unix-socket",
  unixSocketOwnerBoundary: {
    ownerUid: process.getuid?.() ?? 0,
    source: "unix-socket-filesystem-owner-boundary",
  },
} as unknown as DaemonAuthenticationContext;

function writeFile(target: string, body: string): void {
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, body, "utf8");
}

function initGitRepo(rootDir: string): void {
  execFileSync("git", ["-C", rootDir, "init", "-q"]);
  execFileSync("git", ["-C", rootDir, "config", "user.name", "Decoupling Test"]);
  execFileSync("git", ["-C", rootDir, "config", "user.email", "decoupling@example.invalid"]);
  execFileSync("git", ["-C", rootDir, "commit", "--allow-empty", "-qm", "base"]);
}

function seedCustomAuditVertical(
  rootDir: string,
  options: { readonly verticalId: string; readonly includeWorkPreset: boolean },
): void {
  const verticalDir = path.join(rootDir, "verticals", options.verticalId.replaceAll("/", "-"));
  const { verticalId } = options;

  writeFile(
    path.join(verticalDir, "vertical.json"),
    JSON.stringify(
      {
        schema: "vertical-definition/v1",
        id: verticalId,
        title: "Finance Audit",
        version: "1.0.0",
        entityFieldExtensions: [
          {
            extends: "task",
            field: "taskClass",
            kind: "enum-facet",
            values: ["work"],
            default: null,
            mutability: "amendable",
            projection: { column: "task_class", queryable: true },
            reason: "Audit engagements coordinate review tasks under a work root.",
          },
        ],
        entityKinds: [
          { id: "task", entityType: "lifecycle", packageKind: "task-package/v2", contractEntity: true },
          { id: "decision", entityType: "lifecycle", packageKind: "decision-event/v1", contractEntity: true },
          { id: "fact", entityType: "schema", schemaRef: "schema://fact-event", contractEntity: true },
        ],
        contractEntityKinds: ["task", "decision", "fact"],
        packageScaffolds: [
          {
            entityKind: "task",
            templateSelections: [
              {
                slot: "task.plan",
                templateRef: "template://audit/task-plan@1",
                materializeAs: "task_plan.md",
                localePolicy: { prefer: "project", fallback: "en-US" },
              },
              {
                slot: "task.closeout",
                templateRef: "template://audit/closeout@1",
                materializeAs: "closeout.md",
                localePolicy: { prefer: "project", fallback: "en-US" },
              },
              {
                slot: "task.artifacts.keep",
                templateRef: "template://audit/keep-file@1",
                materializeAs: "artifacts/.gitkeep",
                localePolicy: { prefer: "project", fallback: "en-US" },
              },
            ],
          },
          { entityKind: "decision", templateSelections: [] },
        ],
        repositoryScaffold: {
          entityRoots: [
            { entityKind: "task", path: "{{paths.tasksRoot}}", create: "init" },
            { entityKind: "decision", path: "{{paths.decisionsRoot}}", create: "lazy" },
          ],
          dirs: [
            { path: "{{paths.standardsRoot}}", create: "init" },
            { path: "{{paths.contextRoot}}", create: "init" },
          ],
          seededDocs: [
            {
              slot: "repository.context.index",
              templateRef: "template://audit/context-index@1",
              materializeAs: "{{paths.contextRoot}}/README.md",
              localePolicy: { prefer: "project", fallback: "en-US" },
            },
          ],
        },
        scripts: [],
        templateSelections: [],
        completion: {
          sources: {
            "manual-attest": {
              kind: "manual",
              predicateType: "harness/attestation/v1",
              resultSchema: { type: "object", additionalProperties: false },
            },
          },
          gates: {},
          closeoutDefaults: { review: false, consent: false, factDisposition: false },
        },
        projectionSchemas: [
          { id: "task-frontmatter", schemaRef: "schema://task-frontmatter" },
          { id: "decision-frontmatter", schemaRef: "schema://decision-frontmatter" },
          { id: "fact-event", schemaRef: "schema://fact-event" },
          { id: "artifact-descriptor", schemaRef: "schema://artifact-descriptor" },
        ],
      },
      null,
      2,
    ),
  );

  writeFile(
    path.join(verticalDir, "capabilities.json"),
    JSON.stringify(
      {
        schema: "preset-capabilities/v1",
        providers: [
          { id: "policy:artifact-contract/v1", kind: "command", version: "1" },
          {
            id: "policy:template-override/audit-work-plan/v1",
            kind: "command",
            version: "1",
            requiredTaskClass: "work",
            templateOverrides: { "task.plan": "template://audit/work-plan@1" },
          },
        ],
      },
      null,
      2,
    ),
  );

  writeFile(
    path.join(verticalDir, "template-catalog.json"),
    JSON.stringify(
      {
        schema: "template-catalog/v2",
        package: {
          id: "finance-audit-core",
          title: "Finance Audit Core Templates",
          version: "1.0.0",
          owner: "finance-audit",
          locales: ["en-US"],
        },
        documents: [
          {
            id: "audit/context-index",
            version: "1",
            documentKind: "repository-context-index",
            slot: "repository.context.index",
            materializeAs: "{{paths.contextRoot}}/README.md",
            frontmatterSchema: "none",
            requiredAnchors: ["## Audit Scope"],
            fallbackLocale: "en-US",
            locales: [{ locale: "en-US", anchors: ["## Audit Scope"], bodyPath: "templates/context.md" }],
          },
          {
            id: "audit/task-plan",
            version: "1",
            documentKind: "task-plan",
            slot: "task.plan",
            materializeAs: "task_plan.md",
            frontmatterSchema: "task-package/v2",
            requiredAnchors: ["## Scope", "## Findings Criteria"],
            fallbackLocale: "en-US",
            locales: [
              { locale: "en-US", anchors: ["## Scope", "## Findings Criteria"], bodyPath: "templates/task-plan.md" },
            ],
          },
          {
            id: "audit/closeout",
            version: "1",
            documentKind: "task-closeout",
            slot: "task.closeout",
            materializeAs: "closeout.md",
            frontmatterSchema: "task-package/v2",
            requiredAnchors: ["## Summary", "## Verification"],
            fallbackLocale: "en-US",
            locales: [
              { locale: "en-US", anchors: ["## Summary", "## Verification"], bodyPath: "templates/closeout.md" },
            ],
          },
          {
            id: "audit/keep-file",
            version: "1",
            documentKind: "keep-file",
            slot: "task.artifacts.keep",
            materializeAs: "artifacts/.gitkeep",
            frontmatterSchema: "none",
            requiredAnchors: [],
            fallbackLocale: "en-US",
            locales: [{ locale: "en-US", anchors: [], bodyPath: "templates/keep.txt" }],
          },
        ],
      },
      null,
      2,
    ),
  );

  writeFile(
    path.join(verticalDir, "templates", "context.md"),
    "# Finance Audit Context\n\n## Audit Scope\n\nControls.\n",
  );
  writeFile(
    path.join(verticalDir, "templates", "task-plan.md"),
    "# {{title}}\n\n## Scope\n\nDescribe the controls under review.\n\n## Findings Criteria\n\nList evidence thresholds.\n",
  );
  writeFile(
    path.join(verticalDir, "templates", "closeout.md"),
    "# Closeout\n\n## Summary\n\nSummarize audit findings.\n\n## Verification\n\nList verified workpapers.\n",
  );
  writeFile(path.join(verticalDir, "templates", "keep.txt"), "");

  // Custom business roles inside verticals/<dir>/agents/*.json
  writeFile(
    path.join(verticalDir, "agents", "lead-auditor.json"),
    JSON.stringify({
      schema: "agent-declaration/v1",
      id: "lead-auditor",
      name: "Lead Auditor",
      role: "worker",
      instructions: "Execute financial control testing and document workpapers.",
      runtimes: [],
      skills: [],
    }),
  );
  writeFile(
    path.join(verticalDir, "agents", "control-reviewer.json"),
    JSON.stringify({
      schema: "agent-declaration/v1",
      id: "control-reviewer",
      name: "Control Reviewer",
      role: "reviewer",
      instructions: "Independently review financial audit workpapers and evidence.",
      runtimes: [],
      skills: [],
    }),
  );

  // Regular artifact preset (non-standard profile name `standard`)
  writeFile(
    path.join(verticalDir, "presets", "audit-review", "preset.json"),
    JSON.stringify({
      schema: "preset-manifest/v3",
      id: "audit-review",
      title: "Audit Control Review",
      vertical: verticalId,
      version: "1.0.0",
      kind: "template-content",
      outputShape: "task-package-artifact",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      profiles: [{ id: "standard", title: "Standard Audit", completionGates: [], templateSelections: [] }],
      defaultProfile: "standard",
    }),
  );
  writeFile(
    path.join(verticalDir, "presets", "audit-review", "PRESET.md"),
    "---\nschema: preset-document/v1\ndescription: Audit control review task.\nwhenToUse: Use for financial audit reviews.\n---\n# Audit Control Review\n",
  );

  // Repository-diff preset to verify dynamic guidance lists `audit-review`, never `docs-task`
  writeFile(
    path.join(verticalDir, "presets", "audit-policy-patch", "preset.json"),
    JSON.stringify({
      schema: "preset-manifest/v3",
      id: "audit-policy-patch",
      title: "Audit Policy Patch",
      vertical: verticalId,
      version: "1.0.0",
      kind: "template-content",
      outputShape: "repository-diff",
      kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
      capabilityImports: [],
      profiles: [{ id: "standard", title: "Standard Patch", completionGates: [], templateSelections: [] }],
      defaultProfile: "standard",
    }),
  );
  writeFile(
    path.join(verticalDir, "presets", "audit-policy-patch", "PRESET.md"),
    "---\nschema: preset-document/v1\ndescription: Repository policy update.\nwhenToUse: Use when editing repository policy files.\n---\n# Audit Policy Patch\n",
  );

  if (options.includeWorkPreset) {
    writeFile(
      path.join(verticalDir, "presets", "audit-engagement", "preset.json"),
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "audit-engagement",
        title: "Audit Engagement Work Root",
        vertical: verticalId,
        version: "1.0.0",
        kind: "process-action",
        outputShape: "task-package-artifact",
        policyPath: "policy.json",
        kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
        capabilityImports: [
          { id: "policy:artifact-contract/v1", kind: "command", version: "1", required: true },
          { id: "policy:template-override/audit-work-plan/v1", kind: "command", version: "1", required: true },
        ],
        profiles: [
          {
            id: "engagement",
            title: "Engagement",
            completionGates: [],
            templateSelections: [
              {
                slot: "task.plan",
                templateRef: "template://audit/work-plan@1",
                materializeAs: "task_plan.md",
                localePolicy: { prefer: "project", fallback: "en-US" },
              },
            ],
          },
        ],
        defaultProfile: "engagement",
      }),
    );
    writeFile(
      path.join(verticalDir, "presets", "audit-engagement", "policy.json"),
      JSON.stringify({
        schema: "preset-policy/v1",
        requires: ["policy:artifact-contract/v1", "policy:template-override/audit-work-plan/v1"],
      }),
    );
    writeFile(
      path.join(verticalDir, "presets", "audit-engagement", "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Audit engagement work root.\nwhenToUse: Use to coordinate a financial audit engagement.\n---\n# Audit Engagement\n",
    );
    writeFile(
      path.join(verticalDir, "presets", "audit-engagement", "template-catalog.json"),
      JSON.stringify({
        schema: "template-catalog/v2",
        package: {
          id: "preset-audit-engagement",
          title: "audit-engagement",
          version: "1.0.0",
          owner: "preset",
          locales: ["en-US"],
        },
        documents: [
          {
            id: "audit/work-plan",
            version: "1",
            documentKind: "work-task-plan",
            slot: "task.plan",
            materializeAs: "task_plan.md",
            frontmatterSchema: "task-package/v2",
            requiredAnchors: ["## Engagement Charter", "## Audit Streams"],
            fallbackLocale: "en-US",
            locales: [
              {
                locale: "en-US",
                anchors: ["## Engagement Charter", "## Audit Streams"],
                bodyPath: "templates/work-plan.md",
              },
            ],
          },
        ],
      }),
    );
    writeFile(
      path.join(verticalDir, "presets", "audit-engagement", "templates", "work-plan.md"),
      "# {{title}}\n\n## Engagement Charter\n\nDefine the audit engagement charter.\n\n## Audit Streams\n\nList the audit workstreams.\n",
    );
  }
}

async function openInitializedVerticalCell(input: {
  readonly rootDir: string;
  readonly repoId: string;
  readonly vertical: string;
  readonly preset?: string;
}): Promise<{
  readonly cell: OpenedCell;
  readonly owner: ReturnType<typeof withPolicyGroup>;
  readonly close: () => Promise<void>;
}> {
  const repoId = workspaceId(input.repoId),
    stateRoot = path.join(input.rootDir, "writer-epochs"),
    authority = openPersistentWriterEpoch({ stateRoot, holderId: input.repoId }),
    lease = authority.acquire(repoId),
    owner = withPolicyGroup(
      {
        actor: { principal: { personId: "person-owner" }, executor: null },
        source: "local" as const,
        authorizationBindingMode: "declared" as const,
      },
      "admin",
    );
  const bootstrap = resolveRepoBootstrap(
    {
      rootDir: input.rootDir,
      repoId: input.repoId,
      personId: "person-owner",
      displayName: "Owner",
      vertical: input.vertical,
      ...(input.preset ? { preset: input.preset } : {}),
    },
    ownerAuth,
  );
  const cell = await openFencedRepoCell({
    repoId,
    rootDir: canonicalRoot(input.rootDir),
    ownerId: input.repoId,
    bootstrap: {
      ...bootstrap,
      actor: owner.actor,
      keycloakAuthorization: owner.keycloakAuthorization,
    },
    defaultWriterEpochFence: {
      schema: "harness-writer-epoch-fence/v1",
      stateRoot,
      repoId,
      epoch: lease.epoch,
      holderId: lease.holderId,
    },
  });
  return {
    cell,
    owner,
    close: async () => {
      await cell.close();
      authority.close();
    },
  };
}

async function createAcceptedDecision(
  cell: OpenedCell,
  owner: ReturnType<typeof withPolicyGroup>,
  vertical: string,
  preset: string,
): Promise<string> {
  const proposed = await cell.run(
    {
      kind: "decision-propose",
      body: "# Decision\n\n## Context\n\nIndependent vertical charter.\n\n## Choice\n\nProceed.\n",
      jsonInput: JSON.stringify({
        title: `Charter for ${vertical}`,
        question: `How should ${vertical} coordinate work?`,
        riskTier: "medium",
        urgency: "medium",
        vertical,
        preset,
        decisionClass: "ordinary",
        appliesTo: { modules: ["vertical"], productLines: [] },
        chosen: [{ id: "CH1", text: `Run ${vertical} independently` }],
        rejected: [{ id: "RJ1", text: "Reuse coding defaults", whyNot: "Cross-domain coupling" }],
        claims: [{ id: "C1", text: `${vertical} operates without software/coding defaults.`, loadBearing: true }],
        fulfillments: [],
      }),
    },
    owner,
  );
  assert.equal(proposed.outcome, "applied", JSON.stringify(proposed));
  const decisionId = String((JSON.parse(String(proposed.evidence)) as { decisionId: string }).decisionId);
  const accepted = await cell.run(
    {
      kind: "decision-accept",
      decisionId,
      rationale: "Accepted charter decision.",
      judgmentOnlyRationale: "Accepted charter decision.",
    },
    owner,
  );
  assert.equal(accepted.outcome, "applied", JSON.stringify(accepted));
  await cell.settlePendingMaterialization("accept charter decision");
  return decisionId;
}

test("office/collab end-to-end lifecycle: init --vertical -> work create -> task create -> agents -> start -> submit -> complete", async () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-e2e-office-collab-")));
  initGitRepo(rootDir);
  const env = await openInitializedVerticalCell({
    rootDir,
    repoId: "e2e-office-collab",
    vertical: "office/collab",
  });
  try {
    const settings = readSettingsFacet(readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8"));
    assert.equal(settings.defaultVertical, "office/collab");
    assert.equal(settings.defaultPreset, "deliverable-task");
    assert.equal(settings.defaultProfile, "baseline");
    const verticalDoc = JSON.parse(readFileSync(path.join(rootDir, "harness", "vertical.json"), "utf8")) as {
      definition: { id: string };
    };
    assert.equal(verticalDoc.definition.id, "office/collab");

    // Bundled agent enumeration and reading stay scoped to office/collab (dec_4276A0CEACD4D402F122295925/CH1 adds chronicler)
    assert.deepEqual(listBundledAgentDeclarationIds("office/collab", rootDir), [
      "chronicler",
      "closeout-reviewer",
      "contributor",
      "coordinator",
      "reviewer",
    ]);
    const coordinator = readAgentDeclarationResolution({
      rootDir,
      agentId: "coordinator",
      entityStore: { get: () => null },
      verticalId: "office/collab",
    });
    assert.equal(coordinator?.layer, "bundled");
    assert.equal(readBundledAgentDeclaration("worker", "office/collab", rootDir), null);

    const decisionId = await createAcceptedDecision(env.cell, env.owner, "office/collab", "deliverable-task");

    // `ha work create` omits presetId and resolves office/collab's native `work-root` preset
    const workPlan = [
      "# Q4 Operations Plan",
      "## Mission\n\nCoordinate the quarterly operating review across teams.",
      "## Stakeholders\n\nSponsor: Operations Lead; Contributors: Finance and Ops.",
      "## Workstreams\n\n| Workstream | Goal | Child task anchor | Owner | Exit evidence |\n| --- | --- | --- | --- | --- |\n| W1 | Executive summary | pending | ops | verified brief |",
      "## Upstream Baselines\n\nCharter decision and Q3 operating metrics.",
      "## Deliverable Contract\n\nFinal executive briefing stored in task artifacts.",
      "## Handoff and Review\n\nReview in weekly sync and circulate handoff checklist.",
      "## Exit Criteria\n\n- [x] Executive briefing delivered.",
    ].join("\n\n");
    const createdWork = (await env.cell.run(
      {
        kind: "task-create",
        title: "Q4 Operations Plan",
        taskClass: "work",
        requirePlan: true,
        decisionRef: decisionId,
        plan: workPlan,
      },
      env.owner,
    )) as Record<string, unknown>;
    assert.equal(createdWork.outcome, "applied", JSON.stringify(createdWork));
    assert.equal(createdWork.presetId, "work-root");
    assert.equal(createdWork.outputShape, "task-package-artifact");
    const workTaskId = String(createdWork.taskId);

    // Child task under the work root resolves office/collab's default preset `deliverable-task`
    const taskPlan = [
      "# Draft Quarterly Brief",
      "## Brief\n\nDraft the Q4 executive operating review brief.",
      "## Objective\n\nGive leadership one verified summary of Q4 KPIs.",
      "## Stakeholders\n\nOperations Lead and Executive Sponsor.",
      "## Upstream Inputs\n\nQ3 baseline metrics and regional reports.",
      "## Deliverable Contract\n\nPublish executive-brief.md under artifacts/.",
      "## Constraints\n\nKeep figures reconciled to the Q3 baseline.",
      "## Acceptance Criteria\n\nAll sections verified and archived.",
    ].join("\n\n");
    const createdTask = (await env.cell.run(
      {
        kind: "task-create",
        title: "Draft Quarterly Brief",
        parentTaskId: workTaskId,
        riskTier: "low",
        plan: taskPlan,
      },
      env.owner,
    )) as Record<string, unknown>;
    assert.equal(createdTask.outcome, "applied", JSON.stringify(createdTask));
    assert.equal(createdTask.presetId, "deliverable-task");
    assert.equal(createdTask.outputShape, "task-package-artifact");
    const taskId = String(createdTask.taskId);
    const packagePath = String(createdTask.packagePath);

    // Start -> author artifact & closeout -> submit -> complete
    const started = await env.cell.run({ kind: "task-start", taskId }, env.owner);
    assert.equal(started.outcome, "applied", JSON.stringify(started));
    await env.cell.settlePendingMaterialization("start office/collab task");

    writeFile(
      path.join(rootDir, "harness", packagePath, "artifacts", "executive-brief.md"),
      "# Q4 Executive Brief\n\nAll quarterly KPIs reconciled.\n",
    );
    writeFile(
      path.join(rootDir, "harness", packagePath, "closeout.md"),
      [
        "# Closeout",
        "## Summary\n\nDelivered the Q4 executive operating review brief.",
        "## Delivered Outputs\n\n- artifacts/executive-brief.md",
        "## Verification\n\nMetrics reconciled against Q3 baseline.",
        "## Open Follow-ups\n\nNone.",
        "## Risks and Caveats\n\nNone.",
      ].join("\n\n"),
    );

    const submitted = await env.cell.run({ kind: "task-submit", taskId }, env.owner);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await env.cell.settlePendingMaterialization("submit office/collab task");

    const shownAfterSubmit = JSON.parse(
      String((await env.cell.run({ kind: "task-show", taskId }, env.owner)).evidence),
    ) as { task: { status: string } };
    if (shownAfterSubmit.task.status !== "done") {
      const completed = await env.cell.run({ kind: "task-complete", taskId }, env.owner);
      assert.equal(completed.outcome, "applied", JSON.stringify(completed));
    }
    const finalShow = JSON.parse(String((await env.cell.run({ kind: "task-show", taskId }, env.owner)).evidence)) as {
      task: { status: string; metadata: { verticalId: string; presetId: string } };
    };
    assert.equal(finalShow.task.status, "done");
    assert.equal(finalShow.task.metadata.verticalId, "office/collab");
    assert.equal(finalShow.task.metadata.presetId, "deliverable-task");
  } finally {
    await env.close();
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("pure custom vertical finance/audit (zero coding presets/agents): full lifecycle, dynamic guidance, broken preset attribution, and missing work preset negative control", async () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-e2e-finance-audit-")));
  initGitRepo(rootDir);
  seedCustomAuditVertical(rootDir, { verticalId: "finance/audit", includeWorkPreset: true });
  const env = await openInitializedVerticalCell({
    rootDir,
    repoId: "e2e-finance-audit",
    vertical: "finance/audit",
    preset: "audit-review",
  });
  try {
    const settings = readSettingsFacet(readFileSync(path.join(rootDir, "harness", "harness.yaml"), "utf8"));
    assert.equal(settings.defaultVertical, "finance/audit");
    assert.equal(settings.defaultPreset, "audit-review");
    assert.equal(settings.defaultProfile, "standard");
    const verticalDoc = JSON.parse(readFileSync(path.join(rootDir, "harness", "vertical.json"), "utf8")) as {
      definition: { id: string };
    };
    assert.equal(verticalDoc.definition.id, "finance/audit");

    // 1. Custom vertical agents resolve from verticals/finance-audit/agents/*.json with zero coding fallback
    assert.deepEqual(listBundledAgentDeclarationIds("finance/audit", rootDir), ["control-reviewer", "lead-auditor"]);
    const leadAuditor = readBundledAgentDeclaration("lead-auditor", "finance/audit", rootDir);
    assert.equal(leadAuditor?.name, "Lead Auditor");
    assert.equal(readBundledAgentDeclaration("worker", "finance/audit", rootDir), null);
    assert.equal(readBundledAgentDeclaration("coding-worker", "finance/audit", rootDir), null);

    // 2. Dynamic guidance for repository-diff preset recommends `audit-review`, never `docs-task`
    const repoDiffPreview = (await env.cell.run(
      {
        kind: "task-create",
        title: "Update Audit Policy",
        presetId: "audit-policy-patch",
        dryRun: true,
      },
      env.owner,
    )) as {
      outcome: string;
      guidance?: readonly { readonly kind: string; readonly args: Record<string, unknown> }[];
    };
    assert.equal(repoDiffPreview.outcome, "pending");
    const contractGuidance = repoDiffPreview.guidance?.find(({ kind }) => kind === "repository-diff-contract");
    assert.deepEqual(contractGuidance?.args, { artifactPresets: ["audit-review"] });

    // 3. Work create resolves `audit-engagement` dynamically via requiredTaskClass="work"
    const decisionId = await createAcceptedDecision(env.cell, env.owner, "finance/audit", "audit-review");
    const workPlan =
      "# FY26 Revenue Audit\n\n## Engagement Charter\n\nVerify FY26 revenue recognition controls.\n\n## Audit Streams\n\n- Revenue cutoff testing.\n";
    const createdWork = (await env.cell.run(
      {
        kind: "task-create",
        title: "FY26 Revenue Audit",
        taskClass: "work",
        requirePlan: true,
        decisionRef: decisionId,
        plan: workPlan,
      },
      env.owner,
    )) as Record<string, unknown>;
    assert.equal(createdWork.outcome, "applied", JSON.stringify(createdWork));
    assert.equal(createdWork.presetId, "audit-engagement");
    assert.equal(createdWork.profileId, "engagement");
    const workTaskId = String(createdWork.taskId);

    // 4. Child task -> start -> submit -> complete under finance/audit
    const taskPlan =
      "# Test Q4 Cutoff Controls\n\n## Scope\n\nSample 30 Q4 revenue invoices.\n\n## Findings Criteria\n\nZero unapproved manual adjustments.\n";
    const createdTask = (await env.cell.run(
      {
        kind: "task-create",
        title: "Test Q4 Cutoff Controls",
        parentTaskId: workTaskId,
        riskTier: "low",
        plan: taskPlan,
      },
      env.owner,
    )) as Record<string, unknown>;
    assert.equal(createdTask.outcome, "applied", JSON.stringify(createdTask));
    assert.equal(createdTask.presetId, "audit-review");
    assert.equal(createdTask.profileId, "standard");
    const taskId = String(createdTask.taskId);
    const packagePath = String(createdTask.packagePath);

    assert.equal((await env.cell.run({ kind: "task-start", taskId }, env.owner)).outcome, "applied");
    await env.cell.settlePendingMaterialization("start finance/audit task");

    writeFile(
      path.join(rootDir, "harness", packagePath, "artifacts", "audit-workpaper.md"),
      "# Q4 Cutoff Workpaper\n\nAll 30 sampled invoices reconciled cleanly.\n",
    );
    writeFile(
      path.join(rootDir, "harness", packagePath, "closeout.md"),
      "# Closeout\n\n## Summary\n\nCompleted Q4 revenue cutoff control testing.\n\n## Verification\n\nWorkpaper verified with zero exceptions.\n",
    );

    const submitted = await env.cell.run({ kind: "task-submit", taskId }, env.owner);
    assert.equal(submitted.outcome, "applied", JSON.stringify(submitted));
    await env.cell.settlePendingMaterialization("submit finance/audit task");

    const shownAfterSubmit = JSON.parse(
      String((await env.cell.run({ kind: "task-show", taskId }, env.owner)).evidence),
    ) as { task: { status: string } };
    if (shownAfterSubmit.task.status !== "done") {
      assert.equal((await env.cell.run({ kind: "task-complete", taskId }, env.owner)).outcome, "applied");
    }
    const finalShow = JSON.parse(String((await env.cell.run({ kind: "task-show", taskId }, env.owner)).evidence)) as {
      task: { status: string; metadata: { verticalId: string; presetId: string } };
    };
    assert.equal(finalShow.task.status, "done");
    assert.equal(finalShow.task.metadata.verticalId, "finance/audit");
    assert.equal(finalShow.task.metadata.presetId, "audit-review");

    // 5. completionContractGap never hardcodes `standard-task`
    const gapWithDefault = completionContractGap(
      { taskId: "task_gap", presetSnapshotDigest: "sha256:abc", presetSnapshotGap: true, metadata: null },
      "audit-review",
    );
    assert.match(gapWithDefault?.action ?? "", /--to-preset audit-review/u);
    const gapNoDefault = completionContractGap({
      taskId: "task_gap",
      presetSnapshotDigest: "sha256:abc",
      presetSnapshotGap: true,
      metadata: null,
    });
    assert.match(gapNoDefault?.action ?? "", /--to-preset <preset-id>/u);
    assert.doesNotMatch(gapNoDefault?.action ?? "", /standard-task/u);

    // 6. Broken preset inside custom vertical stays attributed to `finance/audit`, never leaks into `software/coding`
    writeFile(
      path.join(rootDir, "verticals", "finance-audit", "presets", "broken-audit", "preset.json"),
      "{not valid json",
    );
    const auditCatalog = (await runPresetAction({
      rootDir,
      settings,
      action: { kind: "preset-list", verticalId: "finance/audit" },
    })) as Array<{ id: string; verticalId: string; validity: string }>;
    const brokenEntry = auditCatalog.find((entry) => entry.id === "broken-audit");
    assert.ok(brokenEntry, JSON.stringify(auditCatalog));
    assert.equal(brokenEntry.verticalId, "finance/audit");
    assert.equal(brokenEntry.validity, "blocked");
  } finally {
    await env.close();
    rmSync(rootDir, { recursive: true, force: true });
  }

  // 7. Negative control: custom vertical WITHOUT a `taskClass=work` preset reports missing taskClass=work preset (never `create-work`)
  const noWorkRoot = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-e2e-audit-no-work-")));
  initGitRepo(noWorkRoot);
  seedCustomAuditVertical(noWorkRoot, { verticalId: "finance/audit-no-work", includeWorkPreset: false });
  const noWorkEnv = await openInitializedVerticalCell({
    rootDir: noWorkRoot,
    repoId: "e2e-audit-no-work",
    vertical: "finance/audit-no-work",
    preset: "audit-review",
  });
  try {
    const decisionId = await createAcceptedDecision(
      noWorkEnv.cell,
      noWorkEnv.owner,
      "finance/audit-no-work",
      "audit-review",
    );
    const rejected = await noWorkEnv.cell.run(
      {
        kind: "task-create",
        title: "Blocked Work Root",
        taskClass: "work",
        requirePlan: true,
        decisionRef: decisionId,
      },
      noWorkEnv.owner,
    );
    assert.equal(rejected.outcome, "op_rejected", JSON.stringify(rejected));
    assert.equal(rejected.code, "preset_not_found");
    const explanation = String(rejected.rejectionExplanation ?? "");
    assert.match(explanation, /Vertical finance\/audit-no-work has no preset declaring taskClass=work/u);
    assert.match(explanation, /Available presets: audit-policy-patch, audit-review/u);
    assert.doesNotMatch(explanation, /create-work/u);
  } finally {
    await noWorkEnv.close();
    rmSync(noWorkRoot, { recursive: true, force: true });
  }
});

test("repo bootstrap default preset preserves standard-task for software/coding, prefers regular presets over process-action audits, and rejects work-only or unavailable --preset values", () => {
  const rootDir = realpathSync(mkdtempSync(path.join(tmpdir(), "ha-bootstrap-default-preset-")));
  initGitRepo(rootDir);
  try {
    // 1. Explicit --vertical software/coding preserves INITIAL_SETTINGS_V1.defaultPreset (`standard-task`), never `architecture-rot-audit`
    const codingBootstrap = resolveRepoBootstrap(
      {
        rootDir,
        repoId: "bootstrap-coding",
        personId: "person-owner",
        displayName: "Owner",
        vertical: "software/coding",
      },
      ownerAuth,
    );
    assert.equal(codingBootstrap.settingsBootstrap[0].defaultVertical, "software/coding");
    assert.equal(codingBootstrap.settingsBootstrap[0].defaultPreset, "standard-task");
    assert.equal(codingBootstrap.settingsBootstrap[0].defaultProfile, "baseline");

    // 2. Explicit --vertical office/collab selects regular non-work default preset `deliverable-task`
    const officeBootstrap = resolveRepoBootstrap(
      {
        rootDir,
        repoId: "bootstrap-office",
        personId: "person-owner",
        displayName: "Owner",
        vertical: "office/collab",
      },
      ownerAuth,
    );
    assert.equal(officeBootstrap.settingsBootstrap[0].defaultVertical, "office/collab");
    assert.equal(officeBootstrap.settingsBootstrap[0].defaultPreset, "deliverable-task");
    assert.equal(officeBootstrap.settingsBootstrap[0].defaultProfile, "baseline");

    // 3. Explicit --preset work-root on office/collab (and create-work on software/coding) is rejected with invalid_preset
    assert.throws(
      () =>
        resolveRepoBootstrap(
          {
            rootDir,
            repoId: "bootstrap-office-work-root",
            personId: "person-owner",
            displayName: "Owner",
            vertical: "office/collab",
            preset: "work-root",
          },
          ownerAuth,
        ),
      (error: unknown) =>
        (error as { code?: string }).code === "invalid_preset" &&
        /requires taskClass="work"/u.test(error instanceof Error ? error.message : String(error)) &&
        /deliverable-task/u.test(error instanceof Error ? error.message : String(error)),
    );
    assert.throws(
      () =>
        resolveRepoBootstrap(
          {
            rootDir,
            repoId: "bootstrap-coding-work-root",
            personId: "person-owner",
            displayName: "Owner",
            preset: "create-work",
          },
          ownerAuth,
        ),
      (error: unknown) =>
        (error as { code?: string }).code === "invalid_preset" &&
        /requires taskClass="work"/u.test(error instanceof Error ? error.message : String(error)),
    );

    // 4. Cross-vertical preset (`standard-task` under `office/collab`) is rejected with preset_not_found
    assert.throws(
      () =>
        resolveRepoBootstrap(
          {
            rootDir,
            repoId: "bootstrap-cross-vertical",
            personId: "person-owner",
            displayName: "Owner",
            vertical: "office/collab",
            preset: "standard-task",
          },
          ownerAuth,
        ),
      (error: unknown) => (error as { code?: string }).code === "preset_not_found",
    );

    // 5. Custom vertical with an alphabetically earlier process-action audit preset + regular preset + missing-provider preset
    seedCustomAuditVertical(rootDir, { verticalId: "finance/custom-default", includeWorkPreset: true });
    const customDir = path.join(rootDir, "verticals", "finance-custom-default");
    rmSync(path.join(customDir, "presets", "audit-policy-patch"), { recursive: true, force: true });
    rmSync(path.join(customDir, "presets", "audit-review"), { recursive: true, force: true });
    writeFile(
      path.join(customDir, "presets", "alpha-audit", "preset.json"),
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "alpha-audit",
        title: "Alpha Process Audit",
        vertical: "finance/custom-default",
        version: "1.0.0",
        kind: "process-action",
        outputShape: "task-package-artifact",
        kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
        capabilityImports: [],
        profiles: [{ id: "audit", title: "Audit", completionGates: [], templateSelections: [] }],
        defaultProfile: "audit",
      }),
    );
    writeFile(
      path.join(customDir, "presets", "alpha-audit", "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Audit process preset.\nwhenToUse: Use for periodic audits.\n---\n# Alpha Audit\n",
    );
    writeFile(
      path.join(customDir, "presets", "zeta-regular", "preset.json"),
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "zeta-regular",
        title: "Zeta Regular Task",
        vertical: "finance/custom-default",
        version: "1.0.0",
        kind: "template-content",
        outputShape: "task-package-artifact",
        kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
        capabilityImports: [],
        profiles: [{ id: "standard", title: "Standard", completionGates: [], templateSelections: [] }],
        defaultProfile: "standard",
      }),
    );
    writeFile(
      path.join(customDir, "presets", "zeta-regular", "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Regular task preset.\nwhenToUse: Default daily work.\n---\n# Zeta Regular\n",
    );
    writeFile(
      path.join(customDir, "presets", "missing-cap", "preset.json"),
      JSON.stringify({
        schema: "preset-manifest/v3",
        id: "missing-cap",
        title: "Missing Capability Preset",
        vertical: "finance/custom-default",
        version: "1.0.0",
        kind: "template-content",
        outputShape: "task-package-artifact",
        kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
        capabilityImports: [{ id: "policy:nonexistent-provider/v1", kind: "command", version: "1", required: true }],
        profiles: [{ id: "standard", title: "Standard", completionGates: [], templateSelections: [] }],
        defaultProfile: "standard",
      }),
    );
    writeFile(
      path.join(customDir, "presets", "missing-cap", "PRESET.md"),
      "---\nschema: preset-document/v1\ndescription: Missing capability preset.\nwhenToUse: Never selectable.\n---\n# Missing Cap\n",
    );

    const customBootstrap = resolveRepoBootstrap(
      {
        rootDir,
        repoId: "bootstrap-custom",
        personId: "person-owner",
        displayName: "Owner",
        vertical: "finance/custom-default",
      },
      ownerAuth,
    );
    assert.equal(customBootstrap.settingsBootstrap[0].defaultPreset, "zeta-regular");
    assert.equal(customBootstrap.settingsBootstrap[0].defaultProfile, "standard");

    assert.throws(
      () =>
        resolveRepoBootstrap(
          {
            rootDir,
            repoId: "bootstrap-custom-work",
            personId: "person-owner",
            displayName: "Owner",
            vertical: "finance/custom-default",
            preset: "audit-engagement",
          },
          ownerAuth,
        ),
      (error: unknown) => (error as { code?: string }).code === "invalid_preset",
    );
    assert.throws(
      () =>
        resolveRepoBootstrap(
          {
            rootDir,
            repoId: "bootstrap-custom-missing-cap",
            personId: "person-owner",
            displayName: "Owner",
            vertical: "finance/custom-default",
            preset: "missing-cap",
          },
          ownerAuth,
        ),
      (error: unknown) => (error as { code?: string }).code === "missing_provider",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
