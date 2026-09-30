import { compilePeopleRosterActionEvent, compileVerticalDeclarationEvent } from "@harness-anything/kernel";
import { declaredRoleBindingsForActor } from "./identity/declared-role-binding-projection.ts";
import type { RepoCellActionContext, RepoCellSettingsState } from "./repo-cell-action-context.ts";
import { authorizeRepoCellAction } from "./repo-cell-authorization.ts";
import { cellCodedError } from "./repo-cell-errors.ts";
import type { RepoBootstrapInput } from "./repo-bootstrap.ts";
import { readDefaultVerticalDefinition } from "./vertical-declaration-action.ts";

/**
 * Publishes the canonical documents init authored — Settings, the default vertical and, when init created it, the
 * People roster — as the ledger's first events. Returns whether the Settings initialization appended an event.
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
  await store.settlePendingMaterialization?.("repository vertical initialization");
  return Boolean(appended);
}
