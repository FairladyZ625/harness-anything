import {
  assertCanonicalVertical,
  loadCanonicalAssets,
  packageCatalog,
} from "./preset-assets.ts";
import { effectiveCatalog } from "./preset-catalog.ts";
import { catalogRecovery, listCatalog } from "./preset-discovery.ts";
import {
  catalogAnchors,
  materializeSelections,
  requiredRegularFile,
  taskOverlayPath,
} from "./preset-materialization.ts";
import { presetPackageScripts } from "./preset-package.ts";
import {
  asFailure,
  compareVersion,
  defaultAssets,
  defaultBundled,
  isWithinPresetAssetRoot,
  key,
  normalizeLocale,
  presetFailure,
  resolverContentHash,
} from "./preset-resolver-common.ts";
import type {
  Candidate,
  CanonicalAssets,
  InternalPresetResolution,
  OwnedEntrypoint,
  PresetResolverOptions,
  ResolverScaffoldSelection,
} from "./preset-resolver-types.ts";
import { canonicalPresetBytes } from "./preset.contract.ts";
import type {
  CanonicalPresetResolver,
  ExecutablePackageHandle,
  PresetResolveResultV1,
  PresetTaskManifestV3,
  ResolvePresetRequestV1,
} from "./preset.contract.ts";
import { mergeScaffoldOverlay } from "./scaffold-overlay.ts";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";

export function createRuntime(options: PresetResolverOptions): {
  readonly resolver: CanonicalPresetResolver;
  readonly resolveInternal: (
    request: ResolvePresetRequestV1,
  ) => InternalPresetResolution;
} {
  const bundledRoot = path.resolve(options.bundledRoot ?? defaultBundled),
    userRoot = path.resolve(options.userRoot),
    assetsRoot = path.resolve(options.assetsRoot ?? defaultAssets),
    kernelVersion = options.kernelVersion ?? "1.0.0";
  let cachedAssets: CanonicalAssets | undefined;
  const resolveInternal = (
    request: ResolvePresetRequestV1,
  ): InternalPresetResolution => {
    const assets = (cachedAssets ??= loadCanonicalAssets(assetsRoot)),
      inventory = effectiveCatalog(bundledRoot, userRoot),
      selected = inventory.get(key(request.verticalId, request.presetId));
    if (selected && !selected.decoded)
      throw (
        selected.error ??
        presetFailure(
          "shadow_invalid",
          `User shadow ${request.presetId} is invalid.`,
        )
      );
    assertCanonicalVertical(assets, request.verticalId);
    if (!selected)
      throw presetFailure(
        "preset_not_found",
        `Preset ${request.presetId} is not installed.`,
      );
    const ancestry = resolveAncestry(inventory, selected, request.verticalId),
      manifests = ancestry.map((item) => item.decoded!.manifest);
    for (const manifest of manifests)
      if (
        compareVersion(kernelVersion, manifest.kernelVersionRange.min) < 0 ||
        (manifest.kernelVersionRange.maxExclusive &&
          compareVersion(
            kernelVersion,
            manifest.kernelVersionRange.maxExclusive,
          ) >= 0)
      )
        throw presetFailure(
          "incompatible_kernel",
          `Preset ${manifest.id} is incompatible with kernel ${kernelVersion}.`,
        );
    const leaf = ancestry.at(-1)!.decoded!,
      leafManifest = manifests.at(-1)!,
      profiles = manifests.map((manifest, index) =>
        profileFor(
          manifest,
          index === manifests.length - 1 ? request.profileId : undefined,
        ),
      ),
      profile = profiles.at(-1)!,
      imports = manifests.flatMap((manifest, index) => [
        ...manifest.capabilityImports,
        ...(profiles[index]!.capabilityImports ?? []),
      ]),
      providerMap = new Map(assets.providers.map((item) => [item.id, item]));
    let requiredTaskClass: "milestone" | "epic" | undefined;
    const missingProviderIds: string[] = [];
    for (const imported of imports) {
      const provider = providerMap.get(imported.id);
      if (
        !provider ||
        provider.kind !== imported.kind ||
        provider.version !== imported.version
      ) {
        if (!("required" in imported) || imported.required)
          missingProviderIds.push(imported.id);
        continue;
      }
      requiredTaskClass = provider.requiredTaskClass ?? requiredTaskClass;
    }
    if (missingProviderIds.length)
      throw presetFailure(
        "missing_provider",
        `Capability providers ${missingProviderIds.join(", ")} are unavailable.`,
        missingProviderIds,
      );
    const taskPackageScaffold = assets.vertical.packageScaffolds.find(
      (item) => item.entityKind === "task",
    );
    if (!taskPackageScaffold)
      throw presetFailure(
        "invalid_vertical",
        "Vertical task package scaffold is unavailable.",
      );
    const selections = new Map<string, ResolverScaffoldSelection>(
        taskPackageScaffold.templateSelections.map((selection) => [
          selection.slot,
          {
            selection,
            owner: "doc-sync",
            source: assets.catalog,
            requiredAnchors: catalogAnchors(
              assets.catalog,
              selection.templateRef,
            ),
          },
        ]),
      ),
      overlay = mergeScaffoldOverlay(
        {
          target: options.projectScaffold,
          templateRoot:
            options.projectRoot ?? path.dirname(options.projectScaffold ?? ""),
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
        if (
          previous &&
          previous.selection.templateRef !== selection.templateRef
        ) {
          const allowed = imports.some(
            (item) =>
              providerMap.get(item.id)?.templateOverrides?.[selection.slot] ===
              selection.templateRef,
          );
          if (!allowed)
            throw presetFailure(
              "slot_conflict",
              `Template slot ${selection.slot} conflicts without a provider.`,
            );
        }
        selections.set(selection.slot, {
          selection,
          owner: previous?.owner ?? "doc-sync",
          source,
          requiredAnchors: catalogAnchors(source, selection.templateRef),
        });
      }
    }
    const documents = materializeSelections(
        [...selections.values()],
        normalizeLocale(request.locale),
      ),
      catalogDigests = [
        ...new Set(
          [...selections.values()].flatMap((item) =>
            item.source ? [item.source.sha256] : [],
          ),
        ),
      ].sort(),
      templateCatalogSha256 =
        catalogDigests.length === 1
          ? catalogDigests[0]!
          : resolverContentHash(canonicalPresetBytes(catalogDigests));
    const entrypoints: Record<string, OwnedEntrypoint> = Object.assign(
      {},
      ...ancestry.map((item, index) =>
        Object.fromEntries(
          Object.entries(manifests[index]!.entrypoints ?? {}).map(
            ([name, definition]) => [
              name,
              {
                definition,
                root: item.decoded!.root,
                packageDigest: item.decoded!.packageDigest,
              },
            ],
          ),
        ),
      ),
    );
    if (
      request.purpose === "script-run" &&
      (!request.entrypoint || !entrypoints[request.entrypoint])
    )
      throw presetFailure(
        "entrypoint_not_found",
        `Entrypoint ${request.entrypoint ?? "<missing>"} is not declared.`,
      );
    for (const [name, owned] of Object.entries(entrypoints)) {
      const command = path.resolve(owned.root, owned.definition.command);
      if (
        !isWithinPresetAssetRoot(owned.root, command) ||
        !existsSync(command) ||
        !lstatSync(command).isFile() ||
        lstatSync(command).isSymbolicLink()
      )
        throw presetFailure(
          "missing_script",
          `Entrypoint ${name} command is missing or unsafe.`,
        );
      const missing = [
        ...owned.definition.requires,
        ...owned.definition.produces,
        ...owned.definition.sideEffects,
      ]
        .filter((capability) => {
          const provider = providerMap.get(capability.id);
          return (
            !provider ||
            provider.kind !== capability.kind ||
            provider.version !== capability.version
          );
        })
        .map(({ id }) => id);
      if (missing.length)
        throw presetFailure(
          "missing_provider",
          `Entrypoint capabilities ${missing.join(", ")} are unavailable.`,
          missing,
        );
    }
    const resolvedSelectionDigest =
        `sha256:${resolverContentHash(canonicalPresetBytes(documents.map((item) => ({ slot: item.selection.slot, path: item.selection.materializeAs, templateRef: item.selection.templateRef, locale: item.locale, owner: item.owner, requiredAnchors: item.requiredAnchors, sha256: resolverContentHash(item.body) }))))}` as const,
      withoutDigest = {
        schema: "preset-snapshot/v1" as const,
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
        templates: documents.map((item) => ({
          slot: item.selection.slot,
          path: item.selection.materializeAs,
          templateRef: item.selection.templateRef,
          locale: item.locale,
          owner: item.owner,
          requiredAnchors: item.requiredAnchors,
          content: {
            sha256: resolverContentHash(item.body),
            size: Buffer.byteLength(item.body),
            mediaType: item.mediaType,
          },
        })),
        entrypoints: Object.fromEntries(
          Object.entries(entrypoints).map(
            ([name, { definition: item, root }]) => {
              const commandBody = requiredRegularFile(
                path.resolve(root, item.command),
                "missing_script",
              );
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
            },
          ),
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
      digest =
        `sha256:${resolverContentHash(canonicalPresetBytes(withoutDigest))}` as const;
    const executablePackage =
      request.purpose === "script-run" && request.entrypoint
        ? entrypoints[request.entrypoint]!
        : leaf;
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
      scripts:
        request.purpose === "task-create"
          ? presetPackageScripts(leaf.root)
          : [],
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
    list: async ({ verticalId }) =>
      listCatalog(effectiveCatalog(bundledRoot, userRoot), verticalId).map(
        (entry) => {
          if (entry.validity !== "valid") return entry;
          try {
            resolveInternal({
              presetId: entry.id,
              verticalId,
              locale: "en-US",
              purpose: "inspect",
            });
            return entry;
          } catch (error) {
            const known = asFailure(error);
            return {
              ...entry,
              validity:
                known.code === "missing_provider"
                  ? ("unavailable" as const)
                  : ("blocked" as const),
              errorCode: known.code,
              issues: [{ code: known.code, message: known.message }],
              issueCount: 1,
              ...catalogRecovery(entry, known),
            };
          }
        },
      ),
    resolve: async (request): Promise<PresetResolveResultV1> => {
      try {
        const resolved = resolveInternal(request);
        const packageHandle: ExecutablePackageHandle | null =
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
      } catch (error) {
        const known = asFailure(error);
        return {
          ok: false,
          error: {
            code: known.code,
            hint: known.message,
            nextAction: known.message,
          },
        };
      }
    },
  };
  return { resolver, resolveInternal };
}

export function profileFor(manifest: PresetTaskManifestV3, requested?: string) {
  const id = requested ?? manifest.defaultProfile,
    profile = manifest.profiles.find((item) => item.id === id);
  if (!profile)
    throw presetFailure("missing_profile", `Profile ${id} is unavailable.`);
  return profile;
}

export function resolveAncestry(
  catalog: Map<string, Candidate>,
  selected: Candidate,
  verticalId: string,
): Candidate[] {
  const ancestry: Candidate[] = [],
    seen = new Set<string>();
  let current: Candidate | undefined = selected;
  while (current) {
    if (seen.has(current.id))
      throw presetFailure(
        "extends_cycle",
        `Preset extends cycle includes ${current.id}.`,
      );
    seen.add(current.id);
    ancestry.unshift(current);
    const parentId = current.decoded!.manifest.extends;
    if (!parentId) break;
    const parent = catalog.get(key(verticalId, parentId));
    if (!parent?.decoded)
      throw presetFailure(
        "missing_parent",
        `Preset parent ${parentId} is missing or invalid.`,
      );
    current = parent;
  }
  return ancestry;
}
