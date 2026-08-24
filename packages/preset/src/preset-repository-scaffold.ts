import {
  normalizeRelativeDocumentPath,
  resolveHarnessLayout,
} from "../../kernel/src/index.ts";
import {
  assertCanonicalVertical,
  loadCanonicalAssets,
} from "./preset-assets.ts";
import {
  catalogAnchors,
  materializeSelections,
} from "./preset-materialization.ts";
import {
  defaultAssets,
  isWithinPresetAssetRoot,
  normalizeLocale,
  presetFailure,
  resolverContentHash,
} from "./preset-resolver-common.ts";
import type {
  CanonicalAssets,
  RepositoryScaffoldDocument,
  RepositoryScaffoldPlan,
  ResolverScaffoldSelection,
} from "./preset-resolver-types.ts";
import { canonicalPresetBytes } from "./preset.contract.ts";
import { mergeScaffoldOverlay } from "./scaffold-overlay.ts";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export function compileRepositoryScaffold(input: {
  readonly rootDir: string;
  readonly verticalId: string;
  readonly locale: string;
  readonly projectScaffold?: string;
  readonly assetsRoot?: string;
}): RepositoryScaffoldPlan {
  const rootDir = path.resolve(input.rootDir),
    layout = resolveHarnessLayout(rootDir),
    assets = loadCanonicalAssets(
      path.resolve(input.assetsRoot ?? defaultAssets),
    ),
    locale = normalizeLocale(input.locale);
  assertCanonicalVertical(assets, input.verticalId);
  const overlayTarget = input.projectScaffold
    ? path.resolve(input.projectScaffold)
    : undefined;
  if (
    overlayTarget &&
    !isWithinPresetAssetRoot(layout.authoredRoot, overlayTarget)
  )
    throw presetFailure(
      "invalid_repository_scaffold",
      "settings.scaffolds.repository must remain inside the authored root.",
    );
  const agents = composeAgentsSelection(assets, locale),
    baseSlots = new Set([
      ...assets.vertical.repositoryScaffold.seededDocs.map(({ slot }) => slot),
      ...(agents ? [agents.selection.slot] : []),
    ]),
    selections = new Map<string, ResolverScaffoldSelection>([
      ...assets.vertical.repositoryScaffold.seededDocs.map(
        (selection) =>
          [
            selection.slot,
            {
              selection,
              owner: "doc-sync" as const,
              source: assets.catalog,
              requiredAnchors: catalogAnchors(
                assets.catalog,
                selection.templateRef,
                "invalid_vertical",
              ),
            },
          ] as const,
      ),
      ...(agents ? [[agents.selection.slot, agents] as const] : []),
    ]),
    overlay = mergeScaffoldOverlay(
      {
        target: overlayTarget,
        templateRoot: layout.authoredRoot,
        schema: "repository-scaffold/v1",
        errorCode: "invalid_repository_scaffold",
        pathAllowed: repositoryOverlayPath,
        replaceAllowed: (slot) =>
          !slot.startsWith("repository.walls.") &&
          slot !== "repository.agent.entry",
      },
      selections,
    ),
    materialized = materializeSelections([...selections.values()], locale),
    used = new Set<string>();
  const documents = materialized.map((item): RepositoryScaffoldDocument => {
    const target = repositoryPath(
        item.selection.materializeAs,
        rootDir,
        layout,
        used,
        baseSlots.has(item.selection.slot),
      ),
      absolute = path.join(rootDir, ...target.split("/")),
      contentSha256 = resolverContentHash(item.body);
    if (!existsSync(absolute))
      return {
        slot: item.selection.slot,
        path: target,
        body: item.body,
        mediaType: item.mediaType,
        owner: item.owner,
        requiredAnchors: item.requiredAnchors,
        templateRef: item.selection.templateRef,
        contentSha256,
        existingSha256: null,
        disposition: "created",
      };
    if (!lstatSync(absolute).isFile() || lstatSync(absolute).isSymbolicLink())
      throw presetFailure(
        "reserved_path",
        `Repository scaffold path ${target} is not a regular file.`,
      );
    const existing = readFileSync(absolute, "utf8"),
      existingSha256 = resolverContentHash(existing),
      disposition = item.requiredAnchors.every((anchor) =>
        existing.includes(anchor),
      )
        ? ("preserved" as const)
        : ("drifted" as const);
    return {
      slot: item.selection.slot,
      path: target,
      body: item.body,
      mediaType: item.mediaType,
      owner: item.owner,
      requiredAnchors: item.requiredAnchors,
      templateRef: item.selection.templateRef,
      contentSha256,
      existingSha256,
      disposition,
    };
  });
  const plan = {
      schema: "repository-scaffold-plan/v1" as const,
      rootDir,
      verticalId: assets.vertical.id,
      verticalVersion: assets.vertical.version,
      verticalDigest: `sha256:${assets.verticalSha256}` as const,
      baseScaffoldDigest:
        `sha256:${resolverContentHash(canonicalPresetBytes(assets.vertical.repositoryScaffold))}` as const,
      projectOverlayPath:
        overlayTarget && existsSync(overlayTarget)
          ? path.relative(rootDir, overlayTarget).split(path.sep).join("/")
          : null,
      projectOverlayDigest: overlay.digest,
      documents,
    },
    { rootDir: _root, ...portablePlan } = plan,
    digestInput = {
      ...portablePlan,
      documents: documents.map(({ body: _body, ...document }) => document),
    };
  return {
    ...plan,
    digest: `sha256:${resolverContentHash(canonicalPresetBytes(digestInput))}`,
  };
}

export function composeAgentsSelection(
  assets: CanonicalAssets,
  locale: "zh-CN" | "en-US",
): ResolverScaffoldSelection | undefined {
  const entry = assets.vertical.repositoryScaffold.agentsEntry;
  if (!entry) return undefined;
  const layer = (slot: string, templateRef: string) =>
      materializeSelections(
        [
          {
            selection: {
              slot,
              templateRef,
              materializeAs: entry.materializeAs,
              localePolicy: entry.localePolicy,
            },
            owner: "doc-sync",
            source: assets.catalog,
            requiredAnchors: catalogAnchors(
              assets.catalog,
              templateRef,
              "invalid_vertical",
            ),
          },
        ],
        locale,
      )[0]!,
    base = layer("repository.agent.base", entry.baseRef),
    overlay = layer("repository.agent.overlay", entry.overlayRef),
    anchor = entry.repoSpecificsAnchor ?? "## Repository Specifics",
    body =
      `${base.body.trimEnd()}\n\n${overlay.body.trimEnd()}\n\n${anchor}\n\n` +
      "Repository-specific rules may be added here after explicit diagnosis; " +
      "the deterministic base and vertical overlay above remain unchanged.\n";
  return {
    selection: {
      slot: "repository.agent.entry",
      templateRef: "builtin://software/coding/agents-entry@1",
      materializeAs: entry.materializeAs,
      localePolicy: entry.localePolicy,
    },
    owner: "doc-sync",
    requiredAnchors: [
      ...new Set([...base.requiredAnchors, ...overlay.requiredAnchors, anchor]),
    ],
    project: {
      body,
      mediaType: "text/markdown",
      ref: "builtin://software/coding/agents-entry@1",
    },
  };
}

export function assertRepositoryScaffoldPlanCurrent(
  plan: RepositoryScaffoldPlan,
): void {
  for (const document of plan.documents) {
    const target = path.join(plan.rootDir, ...document.path.split("/"));
    if (document.existingSha256 === null) {
      if (existsSync(target))
        throw presetFailure(
          "repository_plan_changed",
          `${document.path} appeared after repository planning.`,
        );
      continue;
    }
    if (
      !existsSync(target) ||
      !lstatSync(target).isFile() ||
      lstatSync(target).isSymbolicLink() ||
      resolverContentHash(readFileSync(target, "utf8")) !==
        document.existingSha256
    )
      throw presetFailure(
        "repository_plan_changed",
        `${document.path} changed after repository planning.`,
      );
  }
}

export function repositoryOverlayPath(value: string): boolean {
  return !/^\.harness(?:\/|$)/iu.test(value);
}

export function repositoryPath(
  value: string,
  rootDir: string,
  layout: ReturnType<typeof resolveHarnessLayout>,
  used: Set<string>,
  base: boolean,
): string {
  const relative = (target: string) =>
      path.relative(rootDir, target).split(path.sep).join("/"),
    authored = relative(layout.authoredRoot),
    context = relative(layout.contextRoot),
    substitutions = {
      "{{paths.authoredRoot}}": authored,
      "{{paths.contextRoot}}": context,
      "{{paths.governanceRoot}}": relative(layout.governanceRoot),
      "{{paths.standardsRoot}}": relative(layout.standardsRoot),
      "{{paths.adrRoot}}": relative(layout.adrRoot),
      "{{paths.milestonesRoot}}": relative(layout.milestonesRoot),
    };
  let expanded = value
    .replaceAll("{{paths.rootDir}}/", "")
    .replaceAll("{{paths.rootDir}}", "");
  for (const [token, target] of Object.entries(substitutions))
    expanded = expanded.replaceAll(token, target);
  let normalized: string;
  try {
    normalized = normalizeRelativeDocumentPath(expanded);
  } catch {
    throw presetFailure(
      "reserved_path",
      `Repository scaffold path ${value} is unsafe.`,
    );
  }
  const folded = normalized.toLocaleLowerCase("en-US"),
    forbidden = [
      relative(layout.localRoot),
      ".harness",
      `${authored}/events`,
      `${authored}/objects`,
      `${context}/architecture/architecture-manifest.json`,
      `${context}/architecture/model`,
      ...(base
        ? []
        : [
            relative(layout.standardsRoot),
            relative(path.join(layout.governanceRoot, "walls")),
          ]),
    ].map((target) => target.toLocaleLowerCase("en-US"));
  if (
    expanded !== normalized ||
    used.has(folded) ||
    !repositoryOverlayPath(normalized) ||
    (!base && /(?:^|\/)standards(?:\/|$)/iu.test(normalized)) ||
    forbidden.some(
      (target) => folded === target || folded.startsWith(`${target}/`),
    )
  )
    throw presetFailure(
      "reserved_path",
      `Repository scaffold path ${value} is unsafe or duplicated.`,
    );
  used.add(folded);
  return normalized;
}
