import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  REPLAY_TASK_GRAPH,
  assertTransitionDocumentReady,
  classifyTextualArtifactPath,
  currentTaskForWrite,
  deriveTaskWorktreeBinding,
  getExecutableEntityAction,
  presetSnapshotUpgradeWritePlan,
  sha256Text,
  slugifyTaskTitle,
  taskBootstrapWritePlan,
  transitionDocumentContract,
  validatePresetSnapshotUpgradeEvent,
  validateTaskBootstrapEvent,
  validateTaskIdSyntax,
  OPAQUE_TEXTUAL_POLICY_ID,
  type ActorIdentity,
  type FrozenWritePlan,
  type PresetSnapshotUpgradeBundle,
  type PresetSnapshotUpgradeEventV1,
  type TaskBootstrapBlob,
  type TaskBootstrapEventV1,
  type TaskClass,
  type TaskDocumentOwner,
  type TaskMetadataV1,
  type OpaqueTextualMediaType,
  type WriteSource,
} from "@harness-anything/kernel";
import { canonicalPresetBytes, serializePresetSnapshotV1, type PresetSnapshotV1 } from "./preset.contract.ts";
import { createRuntime, type PresetResolverOptions } from "./preset-resolver.ts";
import { resolverContentHash } from "./preset-resolver-common.ts";

export interface CompileTaskPackageInput extends PresetResolverOptions {
  readonly taskId: string;
  readonly title: string;
  readonly taskClass?: TaskClass;
  readonly presetId: string;
  readonly verticalId: string;
  readonly profileId?: string;
  readonly locale: string;
  readonly idempotencyKey?: string;
  readonly parentTaskId?: string;
  readonly workKind?: TaskMetadataV1["workKind"];
  readonly riskTier?: TaskMetadataV1["riskTier"];
  readonly urgency?: TaskMetadataV1["urgency"];
  readonly slug?: string;
  readonly surfaces?: readonly string[];
  readonly reviewReturnBudget?: number;
  /** Authored task_plan.md body written in the same create transaction, replacing the scaffold body. */
  readonly plan?: string;
}
export interface CompileTaskBootstrapInput extends CompileTaskPackageInput {
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly workspaceRevision: number;
  readonly eventId: string;
  readonly opId: string;
  readonly occurredAt: string;
}
export interface CompiledTaskDocument {
  readonly slot: string;
  readonly relativePath: string;
  readonly path: string;
  readonly body: string;
  readonly contentSha256: string;
  readonly mediaType: "application/json" | "text/markdown" | "text/plain" | OpaqueTextualMediaType;
  readonly owner: TaskDocumentOwner;
  readonly requiredAnchors: readonly string[];
  readonly templateRef: string | null;
}
export interface CompiledTaskPackage {
  readonly snapshot: PresetSnapshotV1;
  readonly packagePath: string;
  readonly scaffoldDigest: `sha256:${string}`;
  readonly documents: readonly CompiledTaskDocument[];
  readonly metadata: TaskMetadataV1;
  readonly lightweightPresetIds: readonly string[];
}
export interface CompiledTaskBootstrap extends CompiledTaskPackage {
  readonly event: TaskBootstrapEventV1;
  readonly plan: FrozenWritePlan<"TaskBootstrap">;
  readonly blobs: readonly TaskBootstrapBlob[];
}

const LIVING_EXPLAINER_TEMPLATE = (title: string) => `<!DOCTYPE html>
<!--
AUTHORING GUIDE (comments are instructions; replace Pending content, keep the five section ids):
Global rules: one self-contained HTML file; inline all CSS and SVG; no network assets or JavaScript; keep all content visible without JS. Follow the task title's language in the body (a Chinese title gets Chinese prose). Use a light palette (#faf7f0 page, #f7f3ea panels, #3d3833 text), near-full-width layout (max-width:none; 16–32px page gutters), and make each chapter's SVG its visual centerpiece. SVGs use width:100%; diagrams should carry the facts, with prose only clarifying them. Distinguish observed results from inference and state unverified items. Use .hero-subtitle and .measure-note under the hero title, .metric-grid/.metric for key numbers, .chapter-head with .chapter-index/.chapter-note for numbered sections, .group/.node-existing/.node-new/.node-removed/.node-external/.connector for SVG structure, .legend for status colors, and .source-note directly under each diagram.
1. #conclusion: lead with one plain sentence that says result and verification state; follow with a compact status badge row. Add an SVG status summary, not decorative art.
2. #objectives: one table row per task subgoal with action, status, and source anchor. Add an SVG completion overview. Coding: show changed modules; research: show answered questions; writing: show delivered sections; operations: show affected nodes.
3. #structure: make the main explanatory diagram. Coding = module-change map with existing context green (#4a7c59), changed parts orange (#b0713c), interfaces blue (#4a6b8a). Research = evidence chain with source and confidence. Writing = section map with completion state. Operations = node/status map. These four scenarios change only this chapter's diagram, never the five-chapter structure.
4. #evidence: table the before-fix failure, after-fix success, exact command/output excerpt, and unverified checks. Add a comparison chart or timeline when evidence has sequence or measurable change. Never claim a check that was not run.
5. #next-steps: name residual risks and the next owner/action; draw dependencies in order with an SVG. If none remain, say so and show the completed path.
Quality floor: replace every placeholder with real task evidence; use meaningful labels and values in every SVG; diagrams must explain the change rather than say Input/Process/Output. Keep the chapter ids stable and edit this page incrementally each work round.
-->
<html lang="en">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} | Task explainer</title>
<style>
:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;padding:24px clamp(16px,2vw,32px) 80px;background:#faf7f0;color:#3d3833;font:16px/1.55 system-ui,sans-serif}main{max-width:none;margin:0 auto}h1{font:700 clamp(2.35rem,5vw,5.2rem)/1.02 Georgia,serif;letter-spacing:0;margin:.2rem 0 .55rem;max-width:18ch}.hero-subtitle{font-size:1.25rem;max-width:70ch;margin:.2rem 0;color:#514940}.measure-note,.source-note{color:#7a7266;font-size:.82rem;letter-spacing:.02em}.measure-note{margin:.2rem 0 1.2rem}.chapter-head{display:flex;align-items:baseline;gap:1rem;margin-bottom:.8rem}.chapter-index{font:700 1rem/1 system-ui,sans-serif;letter-spacing:.14em;color:#b0713c}.chapter-head h2{font-size:1.45rem;margin:0}.chapter-note{color:#7a7266;margin:0 0 0 auto;font-size:.92rem}section,header{border-top:1px solid #d8d0c4;padding:2.1rem 0}section>p{max-width:80ch}.muted{color:#7a7266}.badges{display:flex;gap:.5rem;flex-wrap:wrap}.badge{border:1px solid #4a7c59;border-radius:999px;padding:.25rem .7rem;background:#e4eee5;color:#365d42;font-size:.88rem}.badge.warn{border-color:#b0713c;background:#f3e3d5;color:#8a542c}.metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:1.2rem 0}.metric{background:#fff;border:1px solid #d8d0c4;padding:1rem 1.1rem}.metric strong{display:block;font:700 2.2rem/1 Georgia,serif;color:#4a6b8a}.metric span{display:block;margin-top:.3rem;color:#7a7266;font-size:.9rem}.table-wrap{overflow-x:auto}table{width:100%;border-collapse:collapse;background:#f7f3ea}th,td{text-align:left;vertical-align:top;border-bottom:1px solid #d8d0c4;padding:.7rem}th{color:#4a6b8a}svg{display:block;width:100%;height:auto;min-height:150px;background:#f7f3ea;border:1px solid #d8d0c4;margin-top:1rem}.placeholder,.node-existing{fill:#e4eee5;stroke:#4a7c59;stroke-width:2}.node-new{fill:#f3e3d5;stroke:#b0713c;stroke-width:2}.node-removed{fill:#f1dddd;stroke:#a05252;stroke-width:2}.node-external{fill:#e4ebf1;stroke:#4a6b8a;stroke-width:2}.group{fill:none;stroke:#b8ad9d;stroke-width:2;stroke-dasharray:8 5}.connector{fill:none;stroke:#4a6b8a;stroke-width:3}.placeholder-text,.svg-label{fill:#3d3833;font:20px system-ui,sans-serif}.svg-small{fill:#7a7266;font:15px system-ui,sans-serif}.legend{display:flex;gap:1rem;flex-wrap:wrap;margin:.7rem 0 0;color:#7a7266;font-size:.85rem}.legend span{display:inline-flex;align-items:center;gap:.35rem}.legend i{display:inline-block;width:.8rem;height:.8rem;border:1px solid #777}.legend .existing{background:#e4eee5;border-color:#4a7c59}.legend .new{background:#f3e3d5;border-color:#b0713c}.legend .removed{background:#f1dddd;border-color:#a05252}.legend .external{background:#e4ebf1;border-color:#4a6b8a}.source-note{margin:.55rem 0 0}.columns{display:grid;grid-template-columns:minmax(0,2fr) minmax(320px,1fr);gap:24px}@media(max-width:900px){.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr))}.chapter-note{margin-left:0}}@media(max-width:720px){body{padding-left:16px;padding-right:16px}h1{font-size:clamp(2.2rem,11vw,3.2rem)}.metric-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.metric{padding:.75rem}.metric strong{font-size:1.8rem}th,td{min-width:180px}.columns{display:block}.chapter-head{display:block}.chapter-index{display:block;margin-bottom:.35rem}}
</style>
</head>
<body><main>
<header id="conclusion"><h1>${title}</h1><p class="hero-subtitle"><strong>结论：</strong>Pending. 用一句话说明交付结果和验证状态。</p><p class="measure-note">测量范围：本任务工作树；记录时间：填写最后一次验证日期。</p><p class="badges"><span class="badge">状态：待更新</span><span class="badge">证据：待补</span></p><div class="metric-grid"><div class="metric"><strong>0</strong><span>已完成目标</span></div><div class="metric"><strong>0</strong><span>验证命令</span></div><div class="metric"><strong>0</strong><span>结构图节点</span></div><div class="metric"><strong>0</strong><span>未验项目</span></div></div><svg viewBox="0 0 1200 140" role="img" aria-label="Conclusion status placeholder"><rect class="node-existing" x="24" y="24" width="1152" height="92" rx="8"/><text class="svg-label" x="600" y="80" text-anchor="middle">用状态图说明本任务结论</text></svg><p class="source-note">数据来源：填写任务计划、提交记录或测试命令。</p></header>
<section id="objectives"><div class="chapter-head"><span class="chapter-index">01</span><h2>任务对照表</h2><p class="chapter-note">每个子目标都有状态和证据锚点。</p></div><div class="table-wrap"><table><thead><tr><th>子目标</th><th>做了什么</th><th>状态</th><th>锚点</th></tr></thead><tbody><tr><td>Pending</td><td>Pending</td><td>待更新</td><td>task / commit</td></tr></tbody></table></div><svg viewBox="0 0 1200 160" role="img" aria-label="Task objectives placeholder"><rect class="node-existing" x="24" y="30" width="1152" height="100" rx="8"/><text class="svg-label" x="600" y="90" text-anchor="middle">按目标数量绘制完成状态</text></svg><p class="source-note">数据来源：任务计划中的目标清单。</p></section>
<section id="structure"><div class="chapter-head"><span class="chapter-index">02</span><h2>结构图</h2><p class="chapter-note">用一张信息密度足够的图解释核心变化。</p></div><p class="muted">按任务类型替换为模块变更地图、证据链、章节地图或节点状态图。</p><svg viewBox="0 0 1600 300" role="img" aria-label="Structure diagram placeholder"><rect class="group" x="25" y="30" width="470" height="240" rx="10"/><rect class="group" x="565" y="30" width="470" height="240" rx="10"/><rect class="group" x="1105" y="30" width="470" height="240" rx="10"/><text class="svg-label" x="55" y="65">分组 A</text><text class="svg-label" x="595" y="65">分组 B</text><text class="svg-label" x="1135" y="65">分组 C</text><rect class="node-existing" x="65" y="105" width="390" height="90" rx="8"/><rect class="node-new" x="605" y="105" width="390" height="90" rx="8"/><rect class="node-external" x="1145" y="105" width="390" height="90" rx="8"/><path class="connector" d="M455 150h150M995 150h150"/><text class="svg-label" x="260" y="155" text-anchor="middle">已有节点 / 文件路径</text><text class="svg-label" x="800" y="155" text-anchor="middle">新增或修改节点</text><text class="svg-label" x="1340" y="155" text-anchor="middle">外部依赖</text></svg><div class="legend"><span><i class="existing"></i>已实现</span><span><i class="new"></i>新增/修改</span><span><i class="removed"></i>删除</span><span><i class="external"></i>外部</span></div><p class="source-note">数据来源：填写源码路径、依赖清单或架构测量命令。</p></section>
<section id="evidence"><div class="chapter-head"><span class="chapter-index">03</span><h2>验证与证据</h2><p class="chapter-note">修前红、修后绿与未验项必须可复核。</p></div><div class="columns"><div class="table-wrap"><table><thead><tr><th>阶段</th><th>命令与输出摘录</th><th>状态</th></tr></thead><tbody><tr><td>修前红</td><td>Pending</td><td>待更新</td></tr><tr><td>修后绿</td><td>Pending</td><td>待更新</td></tr><tr><td>未验清单</td><td>Pending</td><td>待更新</td></tr></tbody></table></div><svg viewBox="0 0 700 240" role="img" aria-label="Evidence comparison placeholder"><path class="connector" d="M80 180h540"/><circle cx="160" cy="130" r="52" class="node-removed"/><circle cx="350" cy="130" r="52" class="node-existing"/><circle cx="540" cy="130" r="52" class="node-new"/><text class="svg-label" x="160" y="137" text-anchor="middle">修前红</text><text class="svg-label" x="350" y="137" text-anchor="middle">修后绿</text><text class="svg-label" x="540" y="137" text-anchor="middle">未验</text></svg></div><p class="source-note">数据来源：逐条填写真实测试命令及其输出。</p></section>
<section id="next-steps"><div class="chapter-head"><span class="chapter-index">04</span><h2>剩余风险与下一步</h2><p class="chapter-note">按依赖顺序交代风险、负责人和动作。</p></div><p>Pending. 写清风险、负责人和先后依赖。</p><svg viewBox="0 0 1200 220" role="img" aria-label="Next steps dependency placeholder"><rect class="node-removed" x="40" y="70" width="300" height="90" rx="8"/><rect class="node-new" x="450" y="70" width="300" height="90" rx="8"/><rect class="node-existing" x="860" y="70" width="300" height="90" rx="8"/><path class="connector" d="M340 115h110M750 115h110"/><text class="svg-label" x="190" y="125" text-anchor="middle">风险</text><text class="svg-label" x="600" y="125" text-anchor="middle">依赖</text><text class="svg-label" x="1010" y="125" text-anchor="middle">下一步</text></svg><p class="source-note">数据来源：任务计划、closeout 和 owner 决策。</p></section>
</main></body></html>
`;
export interface CompilePresetSnapshotUpgradeInput extends PresetResolverOptions {
  readonly toPresetId?: string;
  readonly documentExists?: (relativePath: string) => boolean;
  readonly task: TaskBootstrapEventV1["payload"]["task"];
  readonly taskContractBody: string;
  readonly actor: ActorIdentity;
  readonly source: WriteSource;
  readonly workspaceRevision: number;
  readonly eventId: string;
  readonly opId: string;
  readonly occurredAt: string;
}
export interface CompiledPresetSnapshotUpgrade extends PresetSnapshotUpgradeBundle {
  readonly snapshot: PresetSnapshotV1;
}
export function compileTaskPackage(input: CompileTaskPackageInput): CompiledTaskPackage {
  validateTaskIdSyntax(input.taskId);
  if (!input.title.trim()) throw bootstrapFailure("invalid_title", "Task title is required.");
  if (
    input.reviewReturnBudget !== undefined &&
    (!Number.isSafeInteger(input.reviewReturnBudget) || input.reviewReturnBudget < 1)
  )
    throw bootstrapFailure("invalid_field", "reviewReturnBudget must be a positive integer.");
  const resolved = createRuntime(input).resolveInternal({
    presetId: input.presetId,
    verticalId: input.verticalId,
    ...(input.profileId ? { profileId: input.profileId } : {}),
    locale: input.locale,
    purpose: "task-create",
  });
  if (resolved.requiredTaskClass && input.taskClass === undefined)
    throw bootstrapFailure(
      "task_class_required",
      `Preset requires caller-supplied taskClass=${resolved.requiredTaskClass}.`,
    );
  if (resolved.requiredTaskClass && input.taskClass !== resolved.requiredTaskClass)
    throw bootstrapFailure("task_class_mismatch", `Preset requires taskClass=${resolved.requiredTaskClass}.`);
  const snapshot = input.workKind === "docs" ? withoutCodeDeliveryGates(resolved.snapshot) : resolved.snapshot,
    slug = input.slug ?? slugifyTaskTitle(input.title),
    packagePath = `tasks/${input.taskId}-${slug}`,
    metadata: TaskMetadataV1 = {
      idempotencyKey: input.idempotencyKey ?? null,
      parentTaskId: input.parentTaskId ?? null,
      workKind: input.workKind ?? null,
      riskTier: input.riskTier ?? null,
      urgency: input.urgency ?? null,
      verticalId: input.verticalId,
      presetId: input.presetId,
      profileId: input.profileId ?? resolved.snapshot.profile.id,
      moduleKey: null,
      slug,
      surfaces: [...(input.surfaces ?? [])],
      fromLegacyId: null,
    },
    planBody = typeof input.plan === "string" && input.plan.trim() ? input.plan : null,
    planScaffoldBody =
      planBody === null
        ? null
        : (resolved.documents.find(({ slot }) => slot === "task.plan")?.body.replaceAll("{{title}}", input.title) ??
          null);
  if (planBody !== null && planScaffoldBody !== null)
    assertTransitionDocumentReady("task.plan", planBody, transitionDocumentContract(planScaffoldBody));
  const prose = resolved.documents.map((document): CompiledTaskDocument => {
      const scaffoldBody = document.body.replaceAll("{{title}}", input.title),
        body = document.slot === "task.plan" && planBody !== null ? planBody : scaffoldBody;
      return {
        slot: document.slot,
        relativePath: document.path,
        path: `${packagePath}/${document.path}`,
        body,
        contentSha256: sha256Text(body),
        mediaType: document.mediaType,
        owner: document.owner,
        requiredAnchors: document.requiredAnchors,
        templateRef: document.templateRef,
      };
    }),
    bySlot = new Map(prose.map((document) => [document.slot, document]));
  const createAction = getExecutableEntityAction("task-create");
  if (!createAction) throw bootstrapFailure("invalid_scaffold", "task.create descriptor is missing.");
  const requiredSlots = [
    ...createAction.ownedArtifacts.filter(({ scaffoldRequired }) => scaffoldRequired).map(({ slot }) => slot),
    ...createAction.managedDocuments.filter(({ scaffoldRequired }) => scaffoldRequired).map(({ slot }) => slot),
  ];
  for (const slot of requiredSlots)
    if (!bySlot.has(slot)) throw bootstrapFailure("invalid_scaffold", `Base scaffold slot ${slot} cannot be removed.`);
  const presetScripts = resolved.scripts.map(
    (script): CompiledTaskDocument => ({
      slot: `preset.script.${script.name}`,
      relativePath: `artifacts/scripts/${script.name}`,
      path: `${packagePath}/artifacts/scripts/${script.name}`,
      body: script.body,
      contentSha256: sha256Text(script.body),
      mediaType: classifyTextualArtifactPath(`artifacts/scripts/${script.name}`)?.mediaType ?? "text/plain",
      owner: "machine",
      requiredAnchors: [],
      templateRef: null,
    }),
  );
  for (const script of presetScripts)
    if (prose.some((document) => document.relativePath === script.relativePath))
      throw bootstrapFailure(
        "invalid_scaffold",
        `Preset script ${script.relativePath} collides with a scaffold document path.`,
      );
  const explainer =
    metadata.profileId === "lightweight"
      ? null
      : {
          slot: "task.explainer",
          relativePath: "artifacts/explainer.html",
          path: `${packagePath}/artifacts/explainer.html`,
          body: LIVING_EXPLAINER_TEMPLATE(input.title),
          contentSha256: sha256Text(LIVING_EXPLAINER_TEMPLATE(input.title)),
          mediaType: "text/html" as const,
          owner: "doc-sync" as const,
          requiredAnchors: [],
          templateRef: null,
        };
  const prBodyBody = prBodyScaffoldBody(input, snapshot.profile.outputShape),
    prBody =
      prBodyBody === null
        ? null
        : {
            slot: "task.pr-body",
            relativePath: "artifacts/pr-body.md",
            path: `${packagePath}/artifacts/pr-body.md`,
            body: prBodyBody,
            contentSha256: sha256Text(prBodyBody),
            mediaType: "text/markdown" as const,
            owner: "doc-sync" as const,
            requiredAnchors: [],
            templateRef: null,
          };
  const scaffoldDigest = resolved.snapshot.scaffold.resolvedSelectionDigest,
    orderedProse = [bySlot.get("task.plan")!, bySlot.get("task.closeout")!, bySlot.get("task.artifacts.keep")!],
    additions = prose
      .filter((document) => !orderedProse.includes(document))
      .sort((left, right) => left.relativePath.localeCompare(right.relativePath)),
    // With an authored plan body, the task.plan descriptor's readiness contract must still derive
    // from the preset scaffold, never from the authored body: a contract frozen from the authored
    // body would flag that body's own text as retained scaffold and make the task unstartable.
    // Template sections stay required, exactly like the hand-edit-then-doc-sync path.
    withPlanScaffold = (document: CompiledTaskDocument) => descriptor(document, planScaffoldBody),
    descriptors = [
      descriptorStub("task.index", "INDEX.md", "machine"),
      descriptorStub("task.contract", "task-contract.json", "machine"),
      withPlanScaffold(orderedProse[0]!),
      descriptor(orderedProse[1]!),
      descriptor(orderedProse[2]!),
      ...additions.map((document) => descriptor(document)),
      ...(explainer === null ? [] : [descriptor(explainer)]),
      ...(prBody === null ? [] : [descriptor(prBody)]),
      ...presetScripts.map((document) => descriptor(document)),
    ],
    index = machine("task.index", "INDEX.md", renderIndex(input, packagePath, metadata, descriptors)),
    contract = machine(
      "task.contract",
      "task-contract.json",
      `${JSON.stringify(
        {
          schema: "task-contract/v1",
          contractVersion: 1,
          taskId: input.taskId,
          packagePath,
          title: input.title,
          taskClass: input.taskClass ?? "standard",
          verticalId: input.verticalId,
          presetId: input.presetId,
          profileId: metadata.profileId,
          locale: input.locale,
          metadata,
          ...(input.reviewReturnBudget === undefined ? {} : { reviewReturnBudget: input.reviewReturnBudget }),
          ...(snapshot.profile.closeoutOverrides === undefined
            ? {}
            : { closeoutOverrides: snapshot.profile.closeoutOverrides }),
          ...(snapshot.profile.archiveOnComplete === undefined
            ? {}
            : { archiveOnComplete: snapshot.profile.archiveOnComplete }),
          completionGates: snapshot.profile.completionGateIds,
          presetSnapshotDigest: snapshot.digest,
          scaffold: {
            baseVersion: resolved.snapshot.scaffold.baseVersion,
            overlayDigest: resolved.snapshot.scaffold.overlayDigest,
            resolvedSelectionDigest: scaffoldDigest,
          },
          documents: descriptors,
        },
        null,
        2,
      )}\n`,
    ),
    documents = [
      index,
      contract,
      orderedProse[0]!,
      orderedProse[1]!,
      orderedProse[2]!,
      ...additions,
      ...(explainer === null ? [] : [explainer]),
      ...(prBody === null ? [] : [prBody]),
      ...presetScripts,
    ];
  return {
    snapshot,
    packagePath,
    scaffoldDigest,
    documents,
    metadata,
    lightweightPresetIds: resolved.lightweightPresetIds,
  };
  function machine(slot: string, relativePath: string, body: string): CompiledTaskDocument {
    return {
      slot,
      relativePath,
      path: `${packagePath}/${relativePath}`,
      body,
      contentSha256: sha256Text(body),
      mediaType: relativePath.endsWith(".json") ? "application/json" : "text/markdown",
      owner: "machine",
      requiredAnchors: [],
      templateRef: null,
    };
  }
}

/**
 * The PR-body skeleton: when the repository declares `.github/pull_request_template.md`, a
 * repository-diff task materializes its current bytes so the bilingual format is filled in, never
 * guessed — the same template CI's pr-body-lint enforces. Who qualifies is not a new judgment: it
 * is the worktree binding, the same derivation `ha task show` names the workspace kind with. Tasks
 * without a binding — work roots, task-package presets like docs-task — never change repository
 * files and never open a PR of their own. A repository without the template has nothing to
 * materialize.
 */
function prBodyScaffoldBody(input: CompileTaskPackageInput, outputShape: string): string | null {
  if (
    input.repoRoot === undefined ||
    deriveTaskWorktreeBinding({
      taskId: input.taskId,
      taskClass: input.taskClass ?? "standard",
      outputShape,
    }) === null
  )
    return null;
  const templatePath = path.join(input.repoRoot, ".github", "pull_request_template.md");
  return existsSync(templatePath) ? readFileSync(templatePath, "utf8") : null;
}

function withoutCodeDeliveryGates(snapshot: PresetSnapshotV1): PresetSnapshotV1 {
  const completionGateIds = snapshot.profile.completionGateIds.filter(
    (gateId) => gateId !== "ci" && gateId !== "code-doc-reconciliation",
  );
  if (completionGateIds.length === snapshot.profile.completionGateIds.length) return snapshot;
  const { digest: _digest, ...withoutDigest } = snapshot,
    effective = { ...withoutDigest, profile: { ...snapshot.profile, completionGateIds } };
  return {
    ...effective,
    digest: `sha256:${resolverContentHash(canonicalPresetBytes(effective))}`,
  };
}
export function compileTaskBootstrap(input: CompileTaskBootstrapInput): CompiledTaskBootstrap {
  const compiled = compileTaskPackage(input),
    snapshotBody = serializePresetSnapshotV1(compiled.snapshot),
    snapshotSha = sha256Text(snapshotBody),
    snapshotClaim = {
      digest: compiled.snapshot.digest,
      sha256: snapshotSha,
      size: Buffer.byteLength(snapshotBody),
      mediaType: "application/json" as const,
    },
    initialDocumentClaims = compiled.documents.map((document) => ({
      path: document.path,
      sha256: document.contentSha256,
      size: Buffer.byteLength(document.body),
      mediaType: document.mediaType,
      owner: document.owner,
      policyId:
        document.owner === "machine"
          ? ("typed-machine-writer/v1" as const)
          : ((document.relativePath === "artifacts/explainer.html" || document.relativePath === "artifacts/pr-body.md"
              ? OPAQUE_TEXTUAL_POLICY_ID
              : ("markdown-body-replaceable/v1" as const)) as
              | "markdown-body-replaceable/v1"
              | "opaque-textual-whole-file/v1"),
    }));
  const event: TaskBootstrapEventV1 = {
    schema: "task-bootstrap-event/v1",
    eventId: input.eventId,
    workspaceRevision: input.workspaceRevision,
    opId: input.opId,
    taskId: input.taskId,
    type: "task_bootstrapped",
    actor: input.actor,
    source: input.source,
    occurredAt: input.occurredAt,
    payload: {
      task: {
        schema: "task/v2",
        taskId: input.taskId,
        title: input.title,
        taskClass: input.taskClass ?? "standard",
        status: "planned",
        graph: REPLAY_TASK_GRAPH,
        currentNode: "implementation",
        iteration: 0,
        pinned: false,
        createdBy: input.actor,
        completionGateIds: compiled.snapshot.profile.completionGateIds,
        presetSnapshotDigest: compiled.snapshot.digest,
        metadata: compiled.metadata,
        packageDisposition: "active",
        supersededBy: null,
        contractVersion: 1,
        ...(input.reviewReturnBudget === undefined ? {} : { reviewReturnBudget: input.reviewReturnBudget }),
        ...(compiled.snapshot.profile.closeoutOverrides === undefined
          ? {}
          : { closeoutOverrides: compiled.snapshot.profile.closeoutOverrides }),
        ...(compiled.snapshot.profile.archiveOnComplete === undefined
          ? {}
          : { archiveOnComplete: compiled.snapshot.profile.archiveOnComplete }),
      },
      presetSnapshotClaim: snapshotClaim,
      initialDocumentClaims,
    },
  };
  const issues = validateTaskBootstrapEvent(event);
  if (issues.length) throw bootstrapFailure("invalid_bootstrap", issues.join("; "));
  const bodies = [
      { ...snapshotClaim, body: snapshotBody },
      ...compiled.documents.map((document, indexValue) => ({
        ...initialDocumentClaims[indexValue]!,
        body: document.body,
      })),
    ],
    blobs = [...new Map(bodies.map((blob) => [blob.sha256, blob])).values()];
  return { ...compiled, event, plan: taskBootstrapWritePlan(event), blobs };
}
export function compilePresetSnapshotUpgrade(input: CompilePresetSnapshotUpgradeInput): CompiledPresetSnapshotUpgrade {
  let contract: Record<string, unknown>;
  try {
    contract = JSON.parse(input.taskContractBody) as Record<string, unknown>;
  } catch {
    throw bootstrapFailure("invalid_task_contract", "Task contract is not JSON.");
  }
  const documents = Array.isArray(contract.documents) ? contract.documents : [],
    title = typeof contract.title === "string" ? contract.title : "",
    presetId = typeof contract.presetId === "string" ? contract.presetId : "",
    verticalId = typeof contract.verticalId === "string" ? contract.verticalId : "",
    profileId = typeof contract.profileId === "string" ? contract.profileId : "",
    locale = typeof contract.locale === "string" ? contract.locale : "",
    previousDigest = contract.presetSnapshotDigest;
  if (
    contract.taskId !== input.task.taskId ||
    contract.taskClass !== input.task.taskClass ||
    typeof contract.packagePath !== "string" ||
    input.task.presetSnapshotDigest !== previousDigest ||
    typeof previousDigest !== "string" ||
    !/^sha256:[0-9a-f]{64}$/u.test(previousDigest) ||
    !title ||
    !presetId ||
    !verticalId ||
    !profileId ||
    !locale ||
    documents.some((item) => !item || typeof item !== "object" || typeof (item as { path?: unknown }).path !== "string")
  )
    throw bootstrapFailure("invalid_task_contract", "Task contract metadata does not match the canonical task.");
  const currentTask = currentTaskForWrite(input.task),
    {
      closeoutOverrides: _staleCloseoutOverrides,
      archiveOnComplete: _staleArchiveOnComplete,
      ...taskWithoutOverrides
    } = currentTask,
    compiled = compileTaskPackage({
      ...input,
      taskId: input.task.taskId,
      title,
      taskClass: input.task.taskClass,
      slug: input.task.metadata?.slug,
      workKind: input.task.metadata?.workKind ?? undefined,
      reviewReturnBudget: input.task.reviewReturnBudget,
      verticalId,
      profileId: input.toPresetId && input.toPresetId !== presetId ? undefined : profileId,
      locale,
      presetId: input.toPresetId ?? presetId,
    });
  // A preset may retire a document slot (afa7f26fc retired the fact ledger document once facts became
  // entities); the retired file stays on disk as committed prose. Task-creation-only scaffolds
  // are intentionally excluded from upgrade comparison because authors may edit them afterwards.
  const knownPaths = new Set(documents.map((item) => (item as { path: string }).path)),
    addedPaths = compiled.documents
      .map(({ relativePath }) => relativePath)
      .filter(
        (item) =>
          !knownPaths.has(item) &&
          !input.documentExists?.(item) &&
          item !== "artifacts/explainer.html" &&
          item !== "artifacts/pr-body.md",
      );
  if (addedPaths.length)
    throw bootstrapFailure(
      "upgrade_document_set_changed",
      `Preset upgrade adds documents the task package does not have (${addedPaths.join(", ")}); ` +
        "recreate the task instead.",
    );
  if (compiled.snapshot.digest === previousDigest)
    throw bootstrapFailure("snapshot_current", "Task already uses the current preset snapshot.");
  const snapshotBody = serializePresetSnapshotV1(compiled.snapshot),
    snapshotClaim = {
      digest: compiled.snapshot.digest,
      sha256: sha256Text(snapshotBody),
      size: Buffer.byteLength(snapshotBody),
      mediaType: "application/json" as const,
    },
    compiledContract = compiled.documents.find(({ relativePath }) => relativePath === "task-contract.json")!,
    contractBody = `${JSON.stringify(
      {
        ...JSON.parse(compiledContract.body),
        packagePath: contract.packagePath,
        metadata: currentTask.metadata
          ? { ...currentTask.metadata, presetId: input.toPresetId ?? presetId, profileId: compiled.metadata.profileId }
          : null,
      },
      null,
      2,
    )}\n`,
    contractDocument = {
      ...compiledContract,
      path: `${contract.packagePath}/task-contract.json`,
      body: contractBody,
      contentSha256: sha256Text(contractBody),
    },
    taskContractClaim = {
      path: contractDocument.path,
      sha256: contractDocument.contentSha256,
      size: Buffer.byteLength(contractDocument.body),
      mediaType: "application/json" as const,
      owner: "machine" as const,
      policyId: "typed-machine-writer/v1" as const,
    },
    event: PresetSnapshotUpgradeEventV1 = {
      schema: "preset-snapshot-upgrade-event/v1",
      eventId: input.eventId,
      workspaceRevision: input.workspaceRevision,
      opId: input.opId,
      taskId: input.task.taskId,
      type: "preset_snapshot_upgraded",
      actor: input.actor,
      source: input.source,
      occurredAt: input.occurredAt,
      payload: {
        previousDigest: previousDigest as `sha256:${string}`,
        task: {
          ...taskWithoutOverrides,
          ...(input.toPresetId && input.toPresetId !== presetId ? { iteration: input.task.iteration + 1 } : {}),
          ...(input.toPresetId && currentTask.metadata
            ? {
                metadata: {
                  ...currentTask.metadata,
                  presetId: input.toPresetId,
                  profileId: compiled.metadata.profileId,
                },
              }
            : {}),
          completionGateIds: compiled.snapshot.profile.completionGateIds,
          presetSnapshotDigest: compiled.snapshot.digest,
          ...(compiled.snapshot.profile.closeoutOverrides === undefined
            ? {}
            : { closeoutOverrides: compiled.snapshot.profile.closeoutOverrides }),
          ...(compiled.snapshot.profile.archiveOnComplete === undefined
            ? {}
            : { archiveOnComplete: compiled.snapshot.profile.archiveOnComplete }),
        },
        presetSnapshotClaim: snapshotClaim,
        taskContractClaim,
      },
    },
    issues = validatePresetSnapshotUpgradeEvent(event);
  if (issues.length) throw bootstrapFailure("invalid_upgrade", issues.join("; "));
  return {
    snapshot: compiled.snapshot,
    event,
    plan: presetSnapshotUpgradeWritePlan(event),
    blobs: [
      ...new Map(
        [
          { ...snapshotClaim, body: snapshotBody },
          { ...taskContractClaim, body: contractDocument.body },
        ].map((blob) => [blob.sha256, blob]),
      ).values(),
    ],
  };
}
function descriptor(document: CompiledTaskDocument, planScaffold: string | null = null) {
  return {
    slot: document.slot,
    path: document.relativePath,
    owner: document.owner,
    materializeAs: document.relativePath,
    requiredAnchors: document.requiredAnchors,
    templateRef: document.templateRef,
    contentSha256: document.contentSha256,
    // The readiness contract this scaffold declares, frozen at materialization so judging a
    // transition document never needs the scaffold blob or the bundled catalog. Only the
    // readiness-judged slots carry it; the map's ordered keys are the required sections.
    ...(document.slot === "task.plan" || document.slot === "task.closeout"
      ? { readiness: transitionDocumentContract(planScaffold ?? document.body).scaffoldBySection }
      : {}),
  };
}
function descriptorStub(slot: string, path: string, owner: TaskDocumentOwner) {
  return {
    slot,
    path,
    owner,
    materializeAs: path,
    requiredAnchors: [] as readonly string[],
    templateRef: null,
    contentSha256: null as string | null,
  };
}
function renderIndex(
  input: CompileTaskPackageInput,
  packagePath: string,
  metadata: TaskMetadataV1,
  documents: readonly { readonly path: string; readonly owner: TaskDocumentOwner }[],
): string {
  return `---\nschema: task-package/v2\ntask_id: ${input.taskId}\ntitle: ${JSON.stringify(input.title)}\n${
    metadata.parentTaskId ? `parent: ${metadata.parentTaskId}\n` : ""
  }lifecycle:\n  engine: kernel/task-lifecycle/v1\n  status: planned\npackageDisposition: active\n${
    metadata.workKind ? `workKind: ${metadata.workKind}\n` : ""
  }${metadata.riskTier ? `riskTier: ${metadata.riskTier}\n` : ""}${
    metadata.urgency ? `urgency: ${metadata.urgency}\n` : ""
  }vertical: ${metadata.verticalId}\npreset: ${metadata.presetId}\nprofile: ${metadata.profileId}\npackagePath: ${
    packagePath
  }\nowner: machine\n---\n# ${
    input.title
  }\n\nPreset: ${input.presetId}/${metadata.profileId}\n\n## Documents\n\n${documents
    .map((document) => `- \`${document.path}\` — ${document.owner}`)
    .join("\n")}\n\n## Next\n\nEdit \`task_plan.md\`, then run \`ha task start ${input.taskId}\`.\n`;
}
function bootstrapFailure(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}
