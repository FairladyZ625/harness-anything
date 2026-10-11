import path from "node:path";
import { compileVerticalDeclarationEvent, resolveHarnessLayout } from "@harness-anything/kernel";
import { runDocAction } from "./doc-sync-command-actions.ts";
import type { RepoCellActionContext, RepoCellSettingsState } from "./repo-cell-action-context.ts";
import { evaluateRepoCellAction } from "./repo-cell-authorization.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoBootstrapInput } from "./repo-bootstrap.ts";
import { readCanonicalVerticalDeclaration, readDefaultVerticalDefinition } from "./vertical-declaration-action.ts";

/**
 * Publishes the canonical documents init authored — Settings, the default vertical, and the scaffold documents init wrote under the authored root — as the ledger's first events. Returns
 * whether the Settings initialization appended an event.
 */
export async function initializeBootstrapLedger(
  cell: RepoCellActionContext,
  settings: RepoCellSettingsState,
  bootstrap: RepoBootstrapInput,
): Promise<boolean> {
  const { store, projection, now } = cell,
    baseBinding = {
      actor: bootstrap.actor,
      source: "local" as const,
      ...(bootstrap.keycloakAuthorization ? { keycloakAuthorization: bootstrap.keycloakAuthorization } : {}),
    },
    revision = store.readHead()?.revision ?? 0,
    authorizationDecision = await evaluateRepoCellAction({
      repoId: cell.input.repoId,
      action: { kind: "repo-bootstrap" },
      binding: baseBinding,
      actionId: `repo-bootstrap:${cell.input.repoId}:${revision}`,
      revision,
      now: now(),
    });
  if (authorizationDecision.outcome === "denied")
    throw cellCodedError(
      "authorization_denied",
      authorizationDecision.nextActions.join(" ") || "Repository bootstrap requires owner authority.",
    );
  const appended = settings.initialize(...bootstrap.settingsBootstrap, {
    ...baseBinding,
    authorizationDecision,
  });
  if (!readCanonicalVerticalDeclaration(projection)) {
    const verticalRevision = (store.readHead()?.revision ?? 0) + 1,
      verticalBundle = compileVerticalDeclarationEvent({
        type: "vertical_declared",
        definition: readDefaultVerticalDefinition(),
        eventId: `event-vertical-declaration-${verticalRevision}`,
        opId: `vertical-declaration-initialize-${verticalRevision}`,
        workspaceRevision: verticalRevision,
        actor: baseBinding.actor,
        source: baseBinding.source,
        occurredAt: now(),
      });
    store.append(verticalBundle);
    projection.apply(verticalBundle.event, verticalBundle.plan);
  }
  // Scaffold documents enter the ledger the way every later document does: a file init wrote without an event
  // is absent from the document projection, so no replica cut would ever carry it to an edge node. Only the
  // entry files init writes outside the authored root (AGENTS.md, CLAUDE.md) are not ledger documents.
  const authoredRoot = resolveHarnessLayout(cell.rootDir).authoredRoot,
    scaffoldPaths = bootstrap.repositoryPlan.documents
      .filter(({ disposition }) => disposition === "created")
      .map((document) =>
        path
          .relative(authoredRoot, path.resolve(cell.rootDir, ...document.path.split("/")))
          .split(path.sep)
          .join("/"),
      )
      .filter((logical) => !logical.startsWith("../"));
  if (scaffoldPaths.length > 0) {
    const scaffoldAction = { kind: "doc-submit", paths: scaffoldPaths },
      scaffoldRevision = store.readHead()?.revision ?? 0,
      submitted = await runDocAction({
        action: scaffoldAction,
        binding: {
          ...baseBinding,
          authorizationDecision: await evaluateRepoCellAction({
            repoId: cell.input.repoId,
            action: scaffoldAction,
            binding: baseBinding,
            actionId: `repo-bootstrap-scaffold:${cell.input.repoId}:${scaffoldRevision}`,
            revision: scaffoldRevision,
            now: now(),
          }),
        },
        workspaceId: cell.input.repoId,
        rootDir: cell.rootDir,
        store,
        projection,
        now,
        killpoint: cell.input.killpoint,
      });
    if (submitted.outcome !== "applied")
      throw cellCodedError(
        submitted.code ?? "bootstrap_scaffold_unpublished",
        `Init could not publish its scaffold documents to the ledger: ${submitted.summary ?? submitted.outcome}`,
      );
  }
  await store.settlePendingMaterialization?.("repository vertical initialization");
  return Boolean(appended);
}
