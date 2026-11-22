import { presetExecutionPolicy } from "@harness-anything/kernel/internal/domain/preset-execution-policy.ts";
import { resolverContentHash } from "./preset-resolver-common.ts";
import type { PlannedScaffoldFile } from "./vertical-scaffold-io.ts";

export interface VerticalTemplateParams {
  readonly verticalId: string;
  readonly slug: string;
  readonly title: string;
  readonly defaultPresetId: string;
  readonly defaultPresetTitle: string;
  readonly gateId: string;
  readonly sourceId: string;
  readonly predicateType: string;
  readonly artifactSchema: string;
  readonly artifactPath: string;
}

export interface PresetTemplateParams {
  readonly verticalId: string;
  readonly presetId: string;
  readonly title: string;
  readonly presetKind: "template-content" | "process-action";
  readonly outputShape: string;
  readonly gateId: string;
  readonly sourceId: string;
  readonly predicateType: string;
  readonly artifactSchema: string;
  readonly artifactPath: string;
  readonly includeCompletionDeclaration: boolean;
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;
const defaultTemplateLocale = { ...presetExecutionPolicy.defaultValue.overlayLocale };
const workRootGovernanceFile = "policy.json";

function deterministicKindId(seed: string): string {
  const hex = resolverContentHash(seed).slice(0, 32);
  return `KND-${hex}`;
}

export function buildDeliverableCheckerScript(input: {
  readonly predicateType: string;
  readonly artifactSchema: string;
  readonly artifactPath: string;
}): string {
  return `import { readFileSync } from "node:fs";

const PREDICATE_TYPE = ${JSON.stringify(input.predicateType)};
const ARTIFACT_SCHEMA = ${JSON.stringify(input.artifactSchema)};
const ARTIFACT_PATH = ${JSON.stringify(input.artifactPath)};

function emit(payload) {
  console.log(
    JSON.stringify({
      schema: "preset-script-result/v1",
      produces: [{ capabilityId: "completion-witness", payload }],
    }),
  );
}

const presetInput = JSON.parse(process.env.HA_PRESET_INPUT ?? "{}");
const witnessInput = JSON.parse(readFileSync(presetInput.witnessInput, "utf8"));
const subjects = (witnessInput.subjects ?? []).map(({ file: _file, ...identity }) => identity);
const target = (witnessInput.subjects ?? []).find(
  (entry) => typeof entry?.path === "string" && entry.path.endsWith("/" + ARTIFACT_PATH),
);

if (!target) {
  emit({
    result: "fail",
    subjects,
    predicateType: PREDICATE_TYPE,
    predicate: { schema: "", owner: "", summary: "", status: "missing", approved: false },
    diagnostic: "Missing required artifact " + ARTIFACT_PATH + ".",
  });
  process.exit(0);
}

let parsed;
try {
  parsed = JSON.parse(readFileSync(target.file, "utf8"));
} catch (error) {
  emit({
    result: "fail",
    subjects,
    predicateType: PREDICATE_TYPE,
    predicate: { schema: "", owner: "", summary: "", status: "invalid", approved: false },
    diagnostic: "Artifact " + ARTIFACT_PATH + " is not valid JSON: " + String(error?.message ?? error),
  });
  process.exit(0);
}

const errors = [];
if (parsed?.schema !== ARTIFACT_SCHEMA) errors.push("schema must equal " + ARTIFACT_SCHEMA);
if (typeof parsed?.owner !== "string" || !parsed.owner.trim()) errors.push("owner must be a non-empty string");
if (typeof parsed?.summary !== "string" || !parsed.summary.trim()) errors.push("summary must be a non-empty string");
if (parsed?.status !== "ready") errors.push('status must equal "ready"');
if (parsed?.approved !== true) errors.push("approved must be true");

const predicate = {
  schema: typeof parsed?.schema === "string" ? parsed.schema : "",
  owner: typeof parsed?.owner === "string" ? parsed.owner : "",
  summary: typeof parsed?.summary === "string" ? parsed.summary : "",
  status: typeof parsed?.status === "string" ? parsed.status : "draft",
  approved: parsed?.approved === true,
};

emit({
  result: errors.length === 0 ? "pass" : "fail",
  subjects,
  predicateType: PREDICATE_TYPE,
  predicate,
  diagnostic: errors.length === 0 ? "Verified " + ARTIFACT_PATH + "." : errors.join("; "),
});
`;
}

export function buildSamplePayloads(input: {
  readonly artifactSchema: string;
  readonly artifactPath: string;
  readonly title: string;
}): {
  readonly positive: Readonly<Record<string, string>>;
  readonly negative: Readonly<Record<string, string>>;
} {
  return {
    positive: {
      [input.artifactPath]: json({
        schema: input.artifactSchema,
        owner: "domain-owner",
        summary: `Verified sample package for ${input.title}.`,
        status: "ready",
        approved: true,
      }),
    },
    negative: {
      [input.artifactPath]: json({
        schema: input.artifactSchema,
        owner: "",
        summary: `Incomplete draft for ${input.title}.`,
        status: "draft",
        approved: false,
      }),
    },
  };
}

export function buildVerticalFiles(p: VerticalTemplateParams): PlannedScaffoldFile[] {
  const prefix = p.slug,
    samples = buildSamplePayloads({
      artifactSchema: p.artifactSchema,
      artifactPath: p.artifactPath,
      title: p.title,
    });
  const verticalJson = {
    schema: "vertical-definition/v1",
    id: p.verticalId,
    title: p.title,
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
        reason: `${p.title} coordinates domain initiatives under a work root.`,
      },
    ],
    entityKinds: [
      { id: "task", entityType: "lifecycle", packageKind: "task-package/v2", contractEntity: true },
      { id: "decision", entityType: "lifecycle", packageKind: "decision-event/v1", contractEntity: true },
      { id: "fact", entityType: "schema", schemaRef: "schema://fact-event", contractEntity: true },
      {
        kindId: deterministicKindId(`${p.verticalId}:deliverable`),
        id: "deliverable",
        entityType: "artifact",
        schemaVersions: [
          {
            version: 1,
            attributes: {
              owner: { type: "string", required: true },
              summary: { type: "string", required: true },
              status: { type: "string", enum: ["draft", "in_review", "ready", "archived"], required: true },
            },
          },
        ],
        idPrefix: "DELIV",
        display: { singular: `${p.title} Deliverable`, plural: `${p.title} Deliverables` },
        descriptorSchemaRef: "schema://artifact-descriptor",
        store: { pathTemplate: "entities/deliverables/{id}.json" },
        locatorKinds: ["repository-path", "url"],
        maturityVocabulary: ["draft", "in_review", "ready", "archived"],
      },
    ],
    contractEntityKinds: ["task", "decision", "fact"],
    packageScaffolds: [
      {
        entityKind: "task",
        templateSelections: [
          {
            slot: "task.plan",
            templateRef: `template://${prefix}/task-plan@1`,
            materializeAs: "task_plan.md",
            localePolicy: defaultTemplateLocale,
          },
          {
            slot: "task.closeout",
            templateRef: `template://${prefix}/closeout@1`,
            materializeAs: "closeout.md",
            localePolicy: defaultTemplateLocale,
          },
          {
            slot: "task.artifacts.keep",
            templateRef: `template://${prefix}/keep-file@1`,
            materializeAs: "artifacts/.gitkeep",
            localePolicy: defaultTemplateLocale,
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
        { path: "{{paths.sessionsRoot}}", create: "lazy" },
      ],
      seededDocs: [
        {
          slot: "repository.context.index",
          templateRef: `template://${prefix}/context-index@1`,
          materializeAs: "{{paths.contextRoot}}/README.md",
          localePolicy: defaultTemplateLocale,
        },
        {
          slot: "repository.standard.index",
          templateRef: `template://${prefix}/standards-index@1`,
          materializeAs: "{{paths.standardsRoot}}/README.md",
          localePolicy: defaultTemplateLocale,
        },
        {
          slot: "repository.gitattributes",
          templateRef: `template://${prefix}/gitattributes@1`,
          materializeAs: "{{paths.authoredRoot}}/.gitattributes",
          localePolicy: defaultTemplateLocale,
        },
        {
          slot: "repository.claude.entry",
          templateRef: `template://${prefix}/claude-entry@1`,
          materializeAs: "{{paths.rootDir}}/CLAUDE.md",
          localePolicy: defaultTemplateLocale,
        },
      ],
      agentsEntry: {
        materializeAs: "{{paths.rootDir}}/AGENTS.md",
        localePolicy: defaultTemplateLocale,
        baseRef: `template://${prefix}/agent-base@1`,
        overlayRef: `template://${prefix}/agent-overlay@1`,
        repoSpecificsAnchor: "## Repository Specifics",
      },
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
        [p.sourceId]: {
          kind: "command",
          entrypoint: `${p.defaultPresetId}/verify-deliverable`,
          predicateType: p.predicateType,
          resultSchema: {
            type: "object",
            required: ["schema", "owner", "summary", "status", "approved"],
            additionalProperties: false,
            properties: {
              schema: { type: "string", const: p.artifactSchema },
              owner: { type: "string", minLength: 1 },
              summary: { type: "string", minLength: 1 },
              status: { type: "string", const: "ready" },
              approved: { type: "boolean", const: true },
            },
          },
        },
      },
      gates: {
        [p.gateId]: {
          source: p.sourceId,
          appliesTo: "artifacts",
          subjects: [p.artifactPath],
          bindings: {
            schema: { artifact: p.artifactPath, pointer: "/schema" },
            owner: { artifact: p.artifactPath, pointer: "/owner" },
            status: { artifact: p.artifactPath, pointer: "/status" },
          },
        },
      },
      closeoutDefaults: {
        review: false,
        consent: false,
        factDisposition: false,
      },
    },
    projectionSchemas: [
      { id: "task-frontmatter", schemaRef: "schema://task-frontmatter" },
      { id: "decision-frontmatter", schemaRef: "schema://decision-frontmatter" },
      { id: "fact-event", schemaRef: "schema://fact-event" },
      { id: "artifact-descriptor", schemaRef: "schema://artifact-descriptor" },
    ],
  };

  const capabilitiesJson = {
    schema: "preset-capabilities/v1",
    providers: [
      {
        id: "completion-witness",
        kind: "checker",
        version: "1",
        actionKind: "completion-witness",
        payloadFields: ["result", "subjects", "predicateType", "predicate", "diagnostic"],
      },
      { id: "policy:artifact-contract/v1", kind: "command", version: "1" },
      {
        id: "policy:template-override/work-plan/v1",
        kind: "command",
        version: "1",
        requiredTaskClass: "work",
        templateOverrides: { "task.plan": `template://${prefix}/work-plan@1` },
      },
    ],
  };

  const doc = (
    id: string,
    documentKind: string,
    slot: string,
    materializeAs: string,
    frontmatterSchema: string,
    requiredAnchors: readonly string[],
    dir: string,
    ext = "md",
  ) => ({
    id: `${prefix}/${id}`,
    version: "1",
    documentKind,
    slot,
    materializeAs,
    frontmatterSchema,
    requiredAnchors,
    fallbackLocale: "en-US",
    locales: [
      { locale: "zh-CN", anchors: requiredAnchors, bodyPath: `templates/${dir}/zh-CN.${ext}` },
      { locale: "en-US", anchors: requiredAnchors, bodyPath: `templates/${dir}/en-US.${ext}` },
    ],
  });

  const templateCatalogJson = {
    schema: "template-catalog/v2",
    package: {
      id: `${prefix}-core`,
      title: `${p.title} Core Templates`,
      version: "1.0.0",
      owner: p.slug,
      locales: ["zh-CN", "en-US"],
    },
    documents: [
      doc(
        "context-index",
        "repository-context-index",
        "repository.context.index",
        "{{paths.contextRoot}}/README.md",
        "none",
        ["## Overview", "## Operating Norms"],
        "repository.context.index",
      ),
      doc(
        "standards-index",
        "repository-standards-index",
        "repository.standard.index",
        "{{paths.standardsRoot}}/README.md",
        "none",
        ["## Purpose", "## Active Rules"],
        "repository.standard.index",
      ),
      doc(
        "gitattributes",
        "repository-machine-file",
        "repository.gitattributes",
        "{{paths.authoredRoot}}/.gitattributes",
        "none",
        ["* -text"],
        "repository.gitattributes",
        "txt",
      ),
      doc(
        "agent-base",
        "repository-seeded-doc",
        "repository.agent.base",
        "{{paths.rootDir}}/AGENTS.md",
        "none",
        ["## Context Loading", "## Ownership Discipline", "## Write Coordination"],
        "repository.agent.base",
      ),
      doc(
        "agent-overlay",
        "repository-seeded-doc",
        "repository.agent.overlay",
        "{{paths.rootDir}}/AGENTS.md",
        "none",
        [`## ${p.title} (${p.verticalId})`, "## Deliverable Verification"],
        "repository.agent.overlay",
      ),
      doc(
        "claude-entry",
        "repository-agent-entry",
        "repository.claude.entry",
        "{{paths.rootDir}}/CLAUDE.md",
        "none",
        ["@AGENTS.md"],
        "repository.claude.entry",
      ),
      doc(
        "task-plan",
        "task-plan",
        "task.plan",
        "task_plan.md",
        "task-package/v2",
        ["## Brief", "## Objective", "## Deliverable Contract", "## Acceptance Criteria"],
        "task.plan",
      ),
      doc(
        "closeout",
        "task-closeout",
        "task.closeout",
        "closeout.md",
        "task-package/v2",
        ["## Summary", "## Verification", "## Residual Risk"],
        "task.closeout",
      ),
      doc("keep-file", "keep-file", "task.artifacts.keep", "artifacts/.gitkeep", "none", [], "task.keep"),
    ],
  };

  const workRootFiles = buildWorkRootPresetFiles(p);
  const defaultPresetFiles = buildPresetFiles({
    verticalId: p.verticalId,
    presetId: p.defaultPresetId,
    title: p.defaultPresetTitle,
    presetKind: "template-content",
    outputShape: "task-package-artifact",
    gateId: p.gateId,
    sourceId: p.sourceId,
    predicateType: p.predicateType,
    artifactSchema: p.artifactSchema,
    artifactPath: p.artifactPath,
    includeCompletionDeclaration: false,
  }).map((entry) => ({
    relativePath: `presets/${p.defaultPresetId}/${entry.relativePath}`,
    body: entry.body,
  }));

  const workerAgent = {
    schema: "agent-declaration/v1",
    id: "contributor",
    name: `${p.title} Contributor`,
    role: "worker",
    instructions: `Execute assigned ${p.title} (${p.verticalId}) tasks against task_plan.md, author required structured artifacts under artifacts/, and record verifiable evidence before submit.`,
    runtimes: [],
    skills: [],
  };

  const reviewerAgent = {
    schema: "agent-declaration/v1",
    id: "closeout-reviewer",
    name: `${p.title} Reviewer`,
    role: "reviewer",
    instructions: `Independently review submitted ${p.title} (${p.verticalId}) task packages against frozen completion gates and artifact evidence, recording approved or changes_requested.`,
    runtimes: [],
    skills: [],
  };

  return [
    { relativePath: "vertical.json", body: json(verticalJson) },
    { relativePath: "capabilities.json", body: json(capabilitiesJson) },
    { relativePath: "template-catalog.json", body: json(templateCatalogJson) },
    {
      relativePath: "templates/repository.context.index/en-US.md",
      body: `# ${p.title} Context\n\n## Overview\n\nDomain context for ${p.verticalId}.\n\n## Operating Norms\n\nKeep domain deliverables structured and verifiable.\n`,
    },
    {
      relativePath: "templates/repository.context.index/zh-CN.md",
      body: `# ${p.title} 上下文索引\n\n## Overview\n\n${p.verticalId} 领域背景与术语说明。\n\n## Operating Norms\n\n所有领域交付物须结构化落盘并通过声明式门禁核验。\n`,
    },
    {
      relativePath: "templates/repository.standard.index/en-US.md",
      body: `# ${p.title} Standards\n\n## Purpose\n\nGovernance and verification rules for ${p.verticalId}.\n\n## Active Rules\n\n- Submit structured artifacts under \`artifacts/\`.\n`,
    },
    {
      relativePath: "templates/repository.standard.index/zh-CN.md",
      body: `# ${p.title} 规范索引\n\n## Purpose\n\n定义 ${p.verticalId} 领域的交付标准与核验基线。\n\n## Active Rules\n\n- 交付产物须落在 \`artifacts/\` 并通过门禁校验。\n`,
    },
    { relativePath: "templates/repository.gitattributes/en-US.txt", body: "* -text\n" },
    { relativePath: "templates/repository.gitattributes/zh-CN.txt", body: "* -text\n" },
    {
      relativePath: "templates/repository.agent.base/en-US.md",
      body: `# Harness Agent Entry\n\n## Context Loading\n\nRead \`task_plan.md\` and linked decisions before starting work.\n\n## Ownership Discipline\n\nClaim an execution lease before writing task deliverables.\n\n## Write Coordination\n\nRun lifecycle transitions through \`ha\` commands and synchronize artifacts via doc-sync.\n`,
    },
    {
      relativePath: "templates/repository.agent.base/zh-CN.md",
      body: `# Harness 代理入口\n\n## Context Loading\n\n开工前先读 \`task_plan.md\` 与关联决策。\n\n## Ownership Discipline\n\n写入交付物前先获取执行租约，不覆盖无关任务包。\n\n## Write Coordination\n\n所有状态流转通过 \`ha\` 命令执行，产物经 doc-sync 同步。\n`,
    },
    {
      relativePath: "templates/repository.agent.overlay/en-US.md",
      body: `## ${p.title} (${p.verticalId})\n\nDefault preset: \`${p.defaultPresetId}\`.\n\n## Deliverable Verification\n\nSatisfy the \`${p.gateId}\` gate by submitting a valid \`${p.artifactPath}\` artifact.\n`,
    },
    {
      relativePath: "templates/repository.agent.overlay/zh-CN.md",
      body: `## ${p.title} (${p.verticalId})\n\n默认预设：\`${p.defaultPresetId}\`。\n\n## Deliverable Verification\n\n提交合法的 \`${p.artifactPath}\` 产物以通过 \`${p.gateId}\` 完成门。\n`,
    },
    { relativePath: "templates/repository.claude.entry/en-US.md", body: "@AGENTS.md\n" },
    { relativePath: "templates/repository.claude.entry/zh-CN.md", body: "@AGENTS.md\n" },
    {
      relativePath: "templates/task.plan/en-US.md",
      body: `# {{title}}\n\nTask Contract: harness-task v1\n\n## Brief\n\nOne-line summary of the ${p.title} deliverable.\n\n## Objective\n\nDescribe the business goal and expected outcome.\n\n## Deliverable Contract\n\nProduce \`${p.artifactPath}\` matching schema \`${p.artifactSchema}\`.\n\n## Acceptance Criteria\n\n- Pass the \`${p.gateId}\` declarative completion gate.\n`,
    },
    {
      relativePath: "templates/task.plan/zh-CN.md",
      body: `# {{title}}\n\nTask Contract: harness-task v1\n\n## Brief\n\n一句话概述本 ${p.title} 任务目标。\n\n## Objective\n\n说明业务背景、核心目标与使用方。\n\n## Deliverable Contract\n\n交付符合 \`${p.artifactSchema}\` 的 \`${p.artifactPath}\` 产物。\n\n## Acceptance Criteria\n\n- 通过 \`${p.gateId}\` 声明式完成门核验。\n`,
    },
    {
      relativePath: "templates/task.closeout/en-US.md",
      body: `# Closeout\n\n## Summary\n\nSummarize the delivered ${p.title} package.\n\n## Verification\n\nRecord \`${p.gateId}\` gate evidence and review outcomes.\n\n## Residual Risk\n\nList open caveats or state none.\n`,
    },
    {
      relativePath: "templates/task.closeout/zh-CN.md",
      body: `# 收口报告\n\n## Summary\n\n总结本次 ${p.title} 交付成果。\n\n## Verification\n\n记录 \`${p.gateId}\` 门禁回执与评审结果。\n\n## Residual Risk\n\n列出剩余风险或注明无。\n`,
    },
    { relativePath: "templates/task.keep/en-US.md", body: "\n" },
    { relativePath: "templates/task.keep/zh-CN.md", body: "\n" },
    ...workRootFiles,
    ...defaultPresetFiles,
    { relativePath: "agents/contributor.json", body: json(workerAgent) },
    { relativePath: "agents/closeout-reviewer.json", body: json(reviewerAgent) },
    { relativePath: `samples/${p.gateId}/positive.json`, body: json({ artifacts: samples.positive }) },
    { relativePath: `samples/${p.gateId}/negative.json`, body: json({ artifacts: samples.negative }) },
  ];
}

function buildWorkRootPresetFiles(p: VerticalTemplateParams): PlannedScaffoldFile[] {
  const workAnchors = ["## Mission", "## Workstreams", "## Deliverable Contract", "## Exit Criteria"];
  const presetJson = {
    schema: "preset-manifest/v3",
    id: "work-root",
    title: `${p.title} Work Root`,
    vertical: p.verticalId,
    version: "1.0.0",
    kind: "process-action",
    outputShape: "task-package-artifact",
    policyPath: workRootGovernanceFile,
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [
      { id: "policy:artifact-contract/v1", kind: "command", version: "1", required: true },
      { id: "policy:template-override/work-plan/v1", kind: "command", version: "1", required: true },
    ],
    profiles: [
      {
        id: "baseline",
        title: "Baseline",
        completionGates: [],
        templateSelections: [
          {
            slot: "task.plan",
            templateRef: `template://${p.slug}/work-plan@1`,
            materializeAs: "task_plan.md",
            localePolicy: defaultTemplateLocale,
          },
        ],
      },
    ],
    defaultProfile: "baseline",
  };
  const presetMd = [
    "---",
    "schema: preset-document/v1",
    `description: Create a ${p.title} work root whose plan coordinates child tasks and exit criteria.`,
    `whenToUse: Use when a ${p.title} initiative needs a parent work map anchored to an accepted decision.`,
    "---",
    `# ${p.title} Work Root`,
    "",
    `Create with \`ha work create --title "<name>" --decision <decision-id>\`.`,
    "",
  ].join("\n");
  const workRootGovernanceDocument = {
    schema: "preset-policy/v1",
    requires: ["policy:artifact-contract/v1", "policy:template-override/work-plan/v1"],
  };
  const catalogJson = {
    schema: "template-catalog/v2",
    package: {
      id: `preset-${p.slug}-work-root`,
      title: "work-root",
      version: "1.0.0",
      owner: "preset",
      locales: ["zh-CN", "en-US"],
    },
    documents: [
      {
        id: `${p.slug}/work-plan`,
        version: "1",
        documentKind: "work-task-plan",
        slot: "task.plan",
        materializeAs: "task_plan.md",
        frontmatterSchema: "task-package/v2",
        requiredAnchors: workAnchors,
        fallbackLocale: "en-US",
        locales: [
          { locale: "zh-CN", anchors: workAnchors, bodyPath: "templates/task.work.plan/zh-CN.md" },
          { locale: "en-US", anchors: workAnchors, bodyPath: "templates/task.work.plan/en-US.md" },
        ],
      },
    ],
  };
  return [
    { relativePath: "presets/work-root/preset.json", body: json(presetJson) },
    { relativePath: "presets/work-root/PRESET.md", body: presetMd },
    { relativePath: "presets/work-root/policy.json", body: json(workRootGovernanceDocument) },
    { relativePath: "presets/work-root/template-catalog.json", body: json(catalogJson) },
    {
      relativePath: "presets/work-root/templates/task.work.plan/en-US.md",
      body: `# {{title}}\n\nTask Contract: harness-task v1\n\n## Mission\n\nState the ${p.title} initiative mission.\n\n## Workstreams\n\n| Wave | Goal | Child task | Exit evidence |\n| --- | --- | --- | --- |\n| W1 | Initial delivery | TBD | ${p.gateId} |\n\n## Deliverable Contract\n\nSpecify required deliverables across child tasks.\n\n## Exit Criteria\n\n- [ ] All child tasks pass declared completion gates.\n`,
    },
    {
      relativePath: "presets/work-root/templates/task.work.plan/zh-CN.md",
      body: `# {{title}}\n\nTask Contract: harness-task v1\n\n## Mission\n\n一句话说明本 ${p.title} 工作线的目标。\n\n## Workstreams\n\n| 波次 | 目标 | 子任务 | 验收证据 |\n| --- | --- | --- | --- |\n| W1 | 首批交付 | 待建 | ${p.gateId} |\n\n## Deliverable Contract\n\n明确各子任务需交付的结构化产物与核验门禁。\n\n## Exit Criteria\n\n- [ ] 全部子任务通过声明式完成门。\n`,
    },
  ];
}

export function buildPresetFiles(p: PresetTemplateParams): PlannedScaffoldFile[] {
  const briefSlot = `task.${p.presetId.replaceAll("-", ".")}.brief`,
    briefRef = `template://${p.presetId}/brief@1`,
    briefAnchors = ["## Deliverable Scope", "## Verification Checklist"],
    entrypointId = "verify-deliverable",
    scriptPath = "checks/verify-deliverable.mjs";

  const presetJson: Record<string, unknown> = {
    schema: "preset-manifest/v3",
    id: p.presetId,
    title: p.title,
    vertical: p.verticalId,
    version: "1.0.0",
    kind: p.presetKind,
    outputShape: p.outputShape,
    kernelVersionRange: { min: "1.0.0", maxExclusive: "2.0.0" },
    capabilityImports: [{ id: "completion-witness", kind: "checker", version: "1", required: true }],
    entrypoints: {
      [entrypointId]: {
        type: "script",
        intent: `Verify ${p.artifactPath} against ${p.artifactSchema} and emit a completion-witness payload.`,
        inputs: [{ name: "witnessInput", type: "string", required: true }],
        requires: [],
        produces: [{ id: "completion-witness", kind: "checker", version: "1" }],
        sideEffects: [],
        command: scriptPath,
      },
    },
    ...(p.includeCompletionDeclaration
      ? {
          completion: {
            sources: {
              [p.sourceId]: {
                kind: "command",
                entrypoint: `${p.presetId}/${entrypointId}`,
                predicateType: p.predicateType,
                resultSchema: {
                  type: "object",
                  required: ["schema", "owner", "summary", "status", "approved"],
                  additionalProperties: false,
                  properties: {
                    schema: { type: "string", const: p.artifactSchema },
                    owner: { type: "string", minLength: 1 },
                    summary: { type: "string", minLength: 1 },
                    status: { type: "string", const: "ready" },
                    approved: { type: "boolean", const: true },
                  },
                },
              },
            },
            gates: {
              [p.gateId]: {
                source: p.sourceId,
                appliesTo: "artifacts",
                subjects: [p.artifactPath],
                bindings: {
                  schema: { artifact: p.artifactPath, pointer: "/schema" },
                  owner: { artifact: p.artifactPath, pointer: "/owner" },
                  status: { artifact: p.artifactPath, pointer: "/status" },
                },
              },
            },
            closeoutDefaults: { review: false, consent: false, factDisposition: false },
          },
        }
      : {}),
    profiles: [
      {
        id: "verified",
        title: "Verified Deliverable",
        completionGates: [p.gateId],
        templateSelections: [
          {
            slot: briefSlot,
            templateRef: briefRef,
            materializeAs: `${p.presetId}-brief.md`,
            localePolicy: defaultTemplateLocale,
          },
        ],
      },
      {
        id: "baseline",
        title: "Baseline",
        completionGates: [],
        templateSelections: [
          {
            slot: briefSlot,
            templateRef: briefRef,
            materializeAs: `${p.presetId}-brief.md`,
            localePolicy: defaultTemplateLocale,
          },
        ],
      },
    ],
    defaultProfile: "verified",
  };

  const presetMd = [
    "---",
    "schema: preset-document/v1",
    `description: Execute ${p.title} tasks under ${p.verticalId} with declarative artifact verification.`,
    `whenToUse: Use when delivering a ${p.title} package that requires deterministic ${p.gateId} verification.`,
    "---",
    `# ${p.title}`,
    "",
    `Preset for \`${p.verticalId}\` with declarative artifact gate \`${p.gateId}\`.`,
    "",
    "## Profiles",
    "",
    `- \`verified\` (default): Enforces \`${p.gateId}\` against \`${p.artifactPath}\`.`,
    `- \`baseline\`: Materializes the domain brief without extra completion gates.`,
    "",
  ].join("\n");

  const catalogJson = {
    schema: "template-catalog/v2",
    package: {
      id: `preset-${p.presetId}`,
      title: p.title,
      version: "1.0.0",
      owner: "preset",
      locales: ["zh-CN", "en-US"],
    },
    documents: [
      {
        id: `${p.presetId}/brief`,
        version: "1",
        documentKind: "domain-brief",
        slot: briefSlot,
        materializeAs: `${p.presetId}-brief.md`,
        frontmatterSchema: "task-package/v2",
        requiredAnchors: briefAnchors,
        fallbackLocale: "en-US",
        locales: [
          { locale: "zh-CN", anchors: briefAnchors, bodyPath: "templates/brief/zh-CN.md" },
          { locale: "en-US", anchors: briefAnchors, bodyPath: "templates/brief/en-US.md" },
        ],
      },
    ],
  };

  return [
    { relativePath: "preset.json", body: json(presetJson) },
    { relativePath: "PRESET.md", body: presetMd },
    { relativePath: "template-catalog.json", body: json(catalogJson) },
    {
      relativePath: "templates/brief/en-US.md",
      body: `# ${p.title} Brief\n\n## Deliverable Scope\n\nDescribe the scope and expected \`${p.artifactPath}\` payload.\n\n## Verification Checklist\n\n- Confirm \`${p.artifactPath}\` satisfies \`${p.gateId}\`.\n`,
    },
    {
      relativePath: "templates/brief/zh-CN.md",
      body: `# ${p.title} 交付简报\n\n## Deliverable Scope\n\n说明本次交付范围与 \`${p.artifactPath}\` 结构化内容。\n\n## Verification Checklist\n\n- 确认 \`${p.artifactPath}\` 通过 \`${p.gateId}\` 门禁核验。\n`,
    },
    {
      relativePath: scriptPath,
      body: buildDeliverableCheckerScript({
        predicateType: p.predicateType,
        artifactSchema: p.artifactSchema,
        artifactPath: p.artifactPath,
      }),
    },
  ];
}
