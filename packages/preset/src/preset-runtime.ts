import {
  assertCanonicalVertical,
  loadCanonicalAssets,
  packageCatalog,
  resolveVerticalAssetsRoot,
} from "./preset-assets.ts";
import { validateCompletionDeclaration } from "./preset-extension-model.ts";
import { effectiveCatalog, missingPresetFailure } from "./preset-catalog.ts";
import { listCatalogWithResolution, type PresetResolutionAttempt } from "./preset-discovery.ts";
import {
  missingProviderFailure,
  presetAvailability,
  presetsDeclaringProfile,
  providerIndex,
  requireAncestry,
} from "./preset-resolution-inputs.ts";
import { catalogAnchors, materializeSelections, taskOverlayPath } from "./preset-materialization.ts";
import { file, presetPackageScripts } from "./preset-package.ts";
import {
  asFailure,
  compareVersion,
  isWithinPresetAssetRoot,
  key,
  normalizeLocale,
  presetFailure,
  resolverContentHash,
} from "./preset-resolver-common.ts";
import type {
  InternalPresetResolution,
  OwnedEntrypoint,
  PresetFailure,
  PresetResolverOptions,
  ResolverScaffoldSelection,
} from "./preset-resolver-types.ts";
import { canonicalPresetBytes } from "./preset.contract.ts";
import type {
  CanonicalPresetResolver,
  ExecutablePackageHandle,
  PresetResolveResultV1,
  ResolvePresetRequestV1,
  FrozenCompletionPackage,
} from "./preset.contract.ts";
import { mergeScaffoldOverlay } from "./scaffold-overlay.ts";
import path from "node:path";

type ResolutionAttempt =
  | { readonly ok: true; readonly resolution: InternalPresetResolution }
  | { readonly ok: false; readonly error: PresetFailure };

function attemptResolution(
  resolveInternal: (request: ResolvePresetRequestV1) => InternalPresetResolution,
  request: ResolvePresetRequestV1,
): ResolutionAttempt {
  try {
    return { ok: true, resolution: resolveInternal(request) };
  } catch (error) {
    return { ok: false, error: asFailure(error) };
  }
}

export function createRuntime(options: PresetResolverOptions): {
  readonly resolver: CanonicalPresetResolver;
  readonly resolveInternal: (request: ResolvePresetRequestV1) => InternalPresetResolution;
} {
  const userRoot = path.resolve(options.userRoot),
    kernelVersion = options.kernelVersion ?? "1.0.0";
  const resolveInternal = (request: ResolvePresetRequestV1): InternalPresetResolution => {
    const assetsRoot = options.assetsRoot ?? resolveVerticalAssetsRoot(request.verticalId, options.repoRoot),
      assets = loadCanonicalAssets(assetsRoot),
      inventory = effectiveCatalog(options.bundledRoot ?? path.join(assetsRoot, "presets"), userRoot),
      selected = inventory.get(key(request.verticalId, request.presetId));
    if (selected && !selected.decoded)
      throw selected.error ?? presetFailure("shadow_invalid", `User shadow ${request.presetId} is invalid.`);
    assertCanonicalVertical(assets, request.verticalId);
    if (!selected)
      throw missingPresetFailure(inventory, request.verticalId, request.presetId, (presetId) => {
        const attempt = attemptResolution(resolveInternal, { ...request, presetId });
        return attempt.ok ? { ok: true } : attempt;
      });
    const ancestry = requireAncestry(inventory, selected, request.verticalId),
      manifests = ancestry.map((item) => item.decoded!.manifest);
    for (const manifest of manifests)
      if (
        compareVersion(kernelVersion, manifest.kernelVersionRange.min) < 0 ||
        (manifest.kernelVersionRange.maxExclusive &&
          compareVersion(kernelVersion, manifest.kernelVersionRange.maxExclusive) >= 0)
      )
        throw presetFailure(
          "incompatible_kernel",
          `Preset ${manifest.id} is incompatible with kernel ${kernelVersion}.`,
        );
    const leaf = ancestry.at(-1)!.decoded!,
      leafManifest = manifests.at(-1)!,
      providerMap = providerIndex(assets.providers),
      { profiles, imports, missingProviderIds, requiredTaskClass } = presetAvailability({
        catalog: inventory,
        verticalId: request.verticalId,
        ancestry,
        providers: providerMap,
        ...(request.profileId ? { requestedProfile: request.profileId } : {}),
      }),
      profile = profiles.at(-1)!;
    if (missingProviderIds.length) throw missingProviderFailure(missingProviderIds);
    const taskPackageScaffold = assets.compiledVertical.definition.packageScaffolds.find(
      (item) => item.entityKind === "task",
    );
    if (!taskPackageScaffold) throw presetFailure("invalid_vertical", "Vertical task package scaffold is unavailable.");
    const selections = new Map<string, ResolverScaffoldSelection>(
        taskPackageScaffold.templateSelections.map((selection) => [
          selection.slot,
          {
            selection,
            owner: "doc-sync",
            source: assets.catalog,
            requiredAnchors: catalogAnchors(assets.catalog, selection.templateRef),
          },
        ]),
      ),
      overlay = mergeScaffoldOverlay(
        {
          target: options.projectScaffold,
          templateRoot: options.projectRoot ?? path.dirname(options.projectScaffold ?? ""),
          schema: "task-scaffold/v1",
          errorCode: "invalid_task_scaffold",
          pathAllowed: taskOverlayPath,
        },
        selections,
      );
    for (const [index, selectedProfile] of profiles.entries()) {
      const candidate = ancestry[index]!,
        source = selectedProfile.templateSelections.length
          ? packageCatalog(candidate.decoded!, assets.catalog)
          : assets.catalog;
      for (const selection of selectedProfile.templateSelections) {
        const previous = selections.get(selection.slot);
        if (previous && previous.selection.templateRef !== selection.templateRef) {
          const allowed = imports.some(
            (item) => providerMap.get(item.id)?.templateOverrides?.[selection.slot] === selection.templateRef,
          );
          if (!allowed)
            throw presetFailure("slot_conflict", `Template slot ${selection.slot} conflicts without a provider.`);
        }
        selections.set(selection.slot, {
          selection,
          owner: previous?.owner ?? "doc-sync",
          source,
          requiredAnchors: catalogAnchors(source, selection.templateRef),
        });
      }
    }
    const documents = materializeSelections([...selections.values()], normalizeLocale(request.locale)),
      documentHashes = documents.map((item) => resolverContentHash(item.body)),
      catalogDigests = [
        ...new Set([...selections.values()].flatMap((item) => (item.source ? [item.source.sha256] : []))),
      ].sort(),
      templateCatalogSha256 =
        catalogDigests.length === 1 ? catalogDigests[0]! : resolverContentHash(canonicalPresetBytes(catalogDigests));
    const entrypoints: Record<string, OwnedEntrypoint> = Object.assign(
      {},
      ...ancestry.map((item, index) =>
        Object.fromEntries(
          Object.entries(manifests[index]!.entrypoints ?? {}).map(([name, definition]) => [
            name,
            {
              definition,
              root: item.decoded!.root,
              packageDigest: item.decoded!.packageDigest,
              files: item.decoded!.files,
            },
          ]),
        ),
      ),
    );
    if (request.purpose === "script-run" && (!request.entrypoint || !entrypoints[request.entrypoint]))
      throw presetFailure("entrypoint_not_found", `Entrypoint ${request.entrypoint ?? "<missing>"} is not declared.`);
    for (const [name, owned] of Object.entries(entrypoints)) {
      const command = path.resolve(owned.root, owned.definition.command);
      if (!isWithinPresetAssetRoot(owned.root, command) || !owned.files.has(owned.definition.command))
        throw presetFailure("missing_script", `Entrypoint ${name} command is missing or unsafe.`);
      const missing = [...owned.definition.requires, ...owned.definition.produces, ...owned.definition.sideEffects]
        .filter((capability) => {
          const provider = providerMap.get(capability.id);
          return !provider || provider.kind !== capability.kind || provider.version !== capability.version;
        })
        .map(({ id }) => id);
      if (missing.length)
        throw presetFailure(
          "missing_provider",
          `Entrypoint capabilities ${missing.join(", ")} are unavailable.`,
          missing,
        );
    }
    const completion = {
      sources: { ...assets.compiledVertical.definition.completion.sources },
      gates: { ...assets.compiledVertical.definition.completion.gates },
      closeoutDefaults: { ...assets.compiledVertical.definition.completion.closeoutDefaults },
    };
    for (const manifest of manifests) {
      if (!manifest.completion) continue;
      for (const [id, source] of Object.entries(manifest.completion.sources)) {
        if (Object.hasOwn(completion.sources, id))
          throw presetFailure("duplicate_source", `Completion source ${id} is declared more than once.`);
        completion.sources[id] = source;
      }
      for (const [id, gate] of Object.entries(manifest.completion.gates)) {
        if (Object.hasOwn(completion.gates, id))
          throw presetFailure("duplicate_gate", `Completion gate ${id} is declared more than once.`);
        completion.gates[id] = gate;
      }
      Object.assign(completion.closeoutDefaults, manifest.completion.closeoutDefaults);
    }
    const completionValidation = validateCompletionDeclaration(completion);
    if (!completionValidation.ok)
      throw presetFailure(
        "invalid_completion",
        completionValidation.issues.map(({ path, message }) => `${path}: ${message}`).join("; "),
      );
    for (const gateId of profile.completionGates)
      if (!completion.gates[gateId])
        throw presetFailure("missing_gate", `Profile ${profile.id} selects undeclared completion gate ${gateId}.`);
    const completionPackages: Record<string, FrozenCompletionPackage> = {};
    for (const [sourceId, source] of Object.entries(completion.sources)) {
      if (source.kind !== "command") continue;
      const separator = source.entrypoint.lastIndexOf("/"),
        packageId = source.entrypoint.slice(0, separator),
        entrypointId = source.entrypoint.slice(separator + 1),
        candidate = inventory.get(key(request.verticalId, packageId)),
        decoded = candidate?.decoded,
        definition = decoded?.manifest.entrypoints?.[entrypointId];
      if (!decoded || !definition)
        throw presetFailure(
          "entrypoint_not_found",
          `Completion source ${sourceId} requires installed entrypoint ${source.entrypoint}.`,
        );
      if (
        !definition.produces.some(
          ({ id, kind, version }) => id === "completion-witness" && kind === "checker" && version === "1",
        ) ||
        !decoded.manifest.capabilityImports.some(
          ({ id, kind, version }) => id === "completion-witness" && kind === "checker" && version === "1",
        )
      )
        throw presetFailure(
          "missing_provider",
          `Completion source ${sourceId} must import and produce completion-witness@1.`,
        );
      const script = path.resolve(decoded.root, definition.command);
      if (!isWithinPresetAssetRoot(decoded.root, script) || !decoded.files.has(definition.command))
        throw presetFailure("missing_script", `Completion source ${sourceId} has no safe script command.`);
      for (const capability of [...definition.requires, ...definition.produces, ...definition.sideEffects]) {
        const provider = providerMap.get(capability.id);
        if (!provider || provider.kind !== capability.kind || provider.version !== capability.version)
          throw presetFailure(
            "missing_provider",
            `Completion source ${sourceId} references unavailable capability ${capability.id}.`,
          );
      }
      completionPackages[sourceId] = {
        id: decoded.manifest.id,
        version: decoded.manifest.version,
        packageDigest: decoded.packageDigest,
        entrypoint: definition,
        produceActions: Object.fromEntries(
          definition.produces.map(({ id }) => {
            const provider = providerMap.get(id);
            if (!provider?.actionKind)
              throw presetFailure("missing_provider", `Source ${sourceId} has no provider for ${id}.`);
            return [id, { actionKind: provider.actionKind, payloadFields: provider.payloadFields ?? [] }];
          }),
        ),
        files: Object.fromEntries(decoded.files),
      };
    }
    const resolvedSelectionDigest = `sha256:${resolverContentHash(
        canonicalPresetBytes(
          documents.map((item, index) => ({
            slot: item.selection.slot,
            path: item.selection.materializeAs,
            templateRef: item.selection.templateRef,
            locale: item.locale,
            owner: item.owner,
            requiredAnchors: item.requiredAnchors,
            sha256: documentHashes[index]!,
          })),
        ),
      )}` as const,
      withoutDigest = {
        schema: "preset-snapshot/v1" as const,
        completion,
        completionPackages,
        identity: {
          id: leaf.manifest.id,
          version: leaf.manifest.version,
          verticalId: request.verticalId,
          layer: selected.layer,
        },
        profile: {
          id: profile.id,
          outputShape: leafManifest.outputShape,
          completionGateIds: profile.completionGates,
          ...(profile.closeoutOverrides === undefined ? {} : { closeoutOverrides: profile.closeoutOverrides }),
          ...(profile.archiveOnComplete === undefined ? {} : { archiveOnComplete: profile.archiveOnComplete }),
        },
        guidance: {
          description: leaf.document.description,
          whenToUse: leaf.document.whenToUse,
          bodySha256: resolverContentHash(leaf.document.body),
        },
        scaffold: {
          baseVersion: "software-coding/v1" as const,
          overlayDigest: overlay.digest,
          resolvedSelectionDigest,
        },
        templates: documents.map((item, index) => ({
          slot: item.selection.slot,
          path: item.selection.materializeAs,
          templateRef: item.selection.templateRef,
          locale: item.locale,
          owner: item.owner,
          requiredAnchors: item.requiredAnchors,
          content: {
            sha256: documentHashes[index]!,
            size: Buffer.byteLength(item.body),
            mediaType: item.mediaType,
          },
        })),
        entrypoints: Object.fromEntries(
          Object.entries(entrypoints).map(([name, { definition: item, files }]) => {
            const commandBody = file(files, item.command, "missing_script");
            return [
              name,
              {
                type: "script" as const,
                intent: item.intent,
                inputs: item.inputs,
                requires: item.requires,
                produces: item.produces,
                sideEffects: item.sideEffects,
                commandRef: item.command,
                commandSha256: resolverContentHash(commandBody),
              },
            ];
          }),
        ),
        provenance: {
          manifestSha256: leaf.manifestSha256,
          packageSha256: leaf.packageDigest,
          verticalSha256: assets.verticalSha256,
          templateCatalogSha256,
          resolverVersion: "1" as const,
          ancestry: ancestry.map((item) => item.id),
        },
      },
      digest = `sha256:${resolverContentHash(canonicalPresetBytes(withoutDigest))}` as const;
    const executablePackage =
      request.purpose === "script-run" && request.entrypoint ? entrypoints[request.entrypoint]! : leaf;
    return {
      manifest: leaf.manifest,
      document: leaf.document,
      snapshot: { ...withoutDigest, digest },
      documents: documents.map((item) => ({
        slot: item.selection.slot,
        path: item.selection.materializeAs,
        body: item.body,
        mediaType: item.mediaType,
        owner: item.owner,
        requiredAnchors: item.requiredAnchors,
        templateRef: item.selection.templateRef,
      })),
      scripts: request.purpose === "task-create" ? presetPackageScripts(leaf.files) : [],
      lightweightPresetIds: presetsDeclaringProfile(inventory, request.verticalId, "lightweight"),
      ...(requiredTaskClass ? { requiredTaskClass } : {}),
      packageRoot: executablePackage.root,
      packageDigest: executablePackage.packageDigest,
      produceActions: Object.fromEntries(
        assets.providers
          .filter((provider) => provider.actionKind)
          .map((provider) => [
            provider.id,
            {
              actionKind: provider.actionKind!,
              payloadFields: provider.payloadFields ?? [],
            },
          ]),
      ),
    };
  };
  const resolver: CanonicalPresetResolver = {
    list: async ({ verticalId }) => {
      const assetsRoot = options.assetsRoot ?? resolveVerticalAssetsRoot(verticalId, options.repoRoot),
        catalog = effectiveCatalog(options.bundledRoot ?? path.join(assetsRoot, "presets"), userRoot),
        assets = loadCanonicalAssets(assetsRoot);
      assertCanonicalVertical(assets, verticalId);
      const resolveAttempt: PresetResolutionAttempt = (presetId) => {
        const attempt = attemptResolution(resolveInternal, {
          presetId,
          verticalId,
          locale: "en-US",
          purpose: "inspect",
        });
        return attempt.ok ? { ok: true } : attempt;
      };
      return listCatalogWithResolution(catalog, verticalId, resolveAttempt);
    },
    resolve: async (request): Promise<PresetResolveResultV1> => {
      const attempt = attemptResolution(resolveInternal, request);
      if (!attempt.ok)
        return {
          ok: false,
          error: {
            code: attempt.error.code,
            hint: attempt.error.message,
            nextAction: attempt.error.message,
          },
        };
      const { resolution: resolved } = attempt,
        packageHandle: ExecutablePackageHandle | null =
          request.purpose === "script-run"
            ? {
                packageDigest: resolved.packageDigest,
                opaque: Symbol("preset-package"),
              }
            : null;
      return {
        ok: true,
        snapshot: resolved.snapshot,
        package: packageHandle,
      };
    },
  };
  return { resolver, resolveInternal };
}

export function presetDocumentBody(input: {
  readonly bundledRoot?: string;
  readonly repoRoot?: string;
  readonly userRoot: string;
  readonly verticalId: string;
  readonly presetId: string;
}): string {
  const assetsRoot = resolveVerticalAssetsRoot(input.verticalId, input.repoRoot),
    bundledRoot = input.bundledRoot ?? path.join(assetsRoot, "presets"),
    catalog = effectiveCatalog(bundledRoot, input.userRoot),
    selected = catalog.get(key(input.verticalId, input.presetId));
  if (selected?.decoded) return selected.decoded.document.body;
  if (selected?.error) throw selected.error;
  const runtime = createRuntime({
      bundledRoot,
      userRoot: input.userRoot,
      assetsRoot,
      ...(input.repoRoot ? { repoRoot: input.repoRoot } : {}),
    }),
    resolveAttempt: PresetResolutionAttempt = (presetId) => {
      const attempt = attemptResolution(runtime.resolveInternal, {
        presetId,
        verticalId: input.verticalId,
        locale: "en-US",
        purpose: "inspect",
      });
      return attempt.ok ? { ok: true } : attempt;
    };
  throw missingPresetFailure(catalog, input.verticalId, input.presetId, resolveAttempt);
}
