import path from "node:path";
import {
  compilePeopleRosterActionEvent,
  compileVerticalDeclarationEvent,
  resolveHarnessLayout,
} from "@harness-anything/kernel";
import { runDocAction } from "./doc-sync-command-actions.ts";
import { declaredRoleBindingsForActor } from "./identity/declared-role-binding-projection.ts";
import type { RepoCellActionContext, RepoCellSettingsState } from "./repo-cell-action-context.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoBootstrapInput } from "./repo-bootstrap.ts";
import { readDefaultVerticalDefinition } from "./vertical-declaration-action.ts";

/**
 * Publishes the canonical documents init authored — Settings, the default vertical, the People roster when init
 * created it, and the scaffold documents init wrote under the authored root — as the ledger's first events. Returns
 * whether the Settings initialization appended an event.
 */
export async function initializeBootstrapLedger(
  cell: RepoCellActionContext,
  settings: RepoCellSettingsState,
  bootstrap: RepoBootstrapInput,
): Promise<boolean> {
  const { store, projection, now } = cell,
    roleBindings = declaredRoleBindingsForActor(cell.rootDir, bootstrap.actor),
    baseBinding = {
      actor: bootstrap.actor,
      source: "local" as const,
      ...(roleBindings === undefined
        ? { authorizationBindingMode: "default" as const }
        : { authorizationBindingMode: "declared" as const, roleBindings }),
    },
    revision = store.readHead()?.revision ?? 0,
    authorizationDecision = await authorizeRepoCellAction({
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
  // The bootstrap owner must be a canonical Person from the start: relations such as a review's awaits edge
  // resolve Person refs through the projected People document, not the authored file init committed.
  const peopleBootstrap = bootstrap.peopleBootstrap;
  if (peopleBootstrap !== undefined && projection.readDocument("people.yaml").document === null) {
    const peopleRevision = (store.readHead()?.revision ?? 0) + 1,
      peopleBundle = compilePeopleRosterActionEvent({
        currentBody: peopleBootstrap,
        action: { kind: "people-replace", sourceBody: peopleBootstrap },
        claimAuthoredBaseline: true,
        eventId: `event-people-bootstrap-${peopleRevision}`,
        opId: `people-bootstrap-${peopleRevision}`,
        workspaceRevision: peopleRevision,
        actor: baseBinding.actor,
        source: baseBinding.source,
        occurredAt: now(),
      }).bundle!;
    store.append(peopleBundle);
    projection.apply(peopleBundle.event, peopleBundle.plan);
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
          authorizationDecision: authorizeRepoCellAction({
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
