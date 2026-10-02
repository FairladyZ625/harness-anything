import { SegCtl } from "../primitives/SegCtl.tsx";
import { useState } from "react";
import type {
  AccessAdminApi,
  AccessEffectivePermissionsReply,
  AccessGrant,
  AccessGrantsReply,
  AccessGroupsReply,
  AccessRejection,
} from "../../../api/access-admin-contract.ts";
import { isRejection, resourceLabel, resourceOfScope, scopeOfResource, type AccessScope } from "../../access-model.ts";
import { t } from "../../i18n/index.tsx";
import { DenseRow } from "../primitives/DenseRow.tsx";
import { ChainStrip } from "../primitives/ChainStrip.tsx";
import { PillFlow } from "../primitives/PillFlow.tsx";
import { Region } from "../primitives/Region.tsx";
import { BoardColumn, BoardMain, BoardRegion, BoardSide, RegionBoard } from "../primitives/RegionBoard.tsx";
import { Button } from "../primitives/Button.tsx";
import { AccessNotice, INPUT, ReceiptRows, asRejection, useAccessRead } from "./AccessParts.tsx";

type ScopeKind = AccessScope["kind"];

interface Target {
  readonly personId: string;
  readonly groupId: string;
  readonly kind: ScopeKind;
  readonly repoId: string;
  readonly entityRef: string;
}

function targetResource(target: Target): string | null {
  return resourceOfScope(
    target.kind === "fleet"
      ? { kind: "fleet" }
      : target.kind === "repository"
        ? { kind: "repository", repoId: target.repoId }
        : { kind: "entity", repoId: target.repoId, entityRef: target.entityRef },
  );
}

type Source = AccessEffectivePermissionsReply["actions"][number]["sources"][number];

/** Allowed actions gathered under the grant and group each one comes from, so a source is stated once. */
function actionsBySource(
  effective: AccessEffectivePermissionsReply,
): readonly { readonly source: Source; readonly actions: readonly string[] }[] {
  const gathered = new Map<string, { readonly source: Source; readonly actions: string[] }>();
  for (const item of effective.actions)
    for (const source of item.sources) {
      const key = `${source.sourceGroup} ${source.grantedGroup} ${source.resource}`;
      if (!gathered.has(key)) gathered.set(key, { source, actions: [] });
      gathered.get(key)!.actions.push(item.action);
    }
  return [...gathered.values()];
}

/**
 * Grants: a policy group given to a person on the fleet, a repository, or one object in a repository.
 * The strip on top names a person and a scope and grants on it; below, what that person can do there
 * and why, next to every grant held.
 */
export function GrantsTab({
  access,
  repos,
}: {
  readonly access: AccessAdminApi;
  readonly repos: readonly { readonly repoId: string; readonly displayName: string }[];
}) {
  const held = useAccessRead<AccessGrantsReply>(access.grants),
    catalog = useAccessRead<AccessGroupsReply>(access.groups),
    [target, setTarget] = useState<Target>({
      personId: "",
      groupId: "",
      kind: "repository",
      repoId: repos[0]?.repoId ?? "",
      entityRef: "",
    }),
    [effective, setEffective] = useState<AccessEffectivePermissionsReply | null>(null),
    [refusal, setRefusal] = useState<AccessRejection | null>(null),
    [busy, setBusy] = useState(false);
  const resource = targetResource(target),
    groupName = (id: string) => catalog.data?.groups.find((group) => group.id === id)?.displayName ?? id;

  /** Reads what the person can do on the scope; a refusal clears the previous answer rather than leaving it up. */
  const inspect = async (personId: string, onResource: string) => {
      const reply = await access.effectivePermissions({ personId, resource: onResource }).catch(asRejection);
      setEffective(isRejection(reply) ? null : reply);
      if (isRejection(reply)) setRefusal(reply);
    },
    run = async (operation: () => Promise<{ readonly ok: boolean }>, personId: string, onResource: string) => {
      setBusy(true);
      setRefusal(null);
      const reply = await operation().catch(asRejection);
      if (isRejection(reply)) setRefusal(reply);
      else {
        await held.reload();
        await inspect(personId, onResource);
      }
      setBusy(false);
    },
    look = (grant: AccessGrant) => {
      const scope = scopeOfResource(grant.resource);
      setTarget({
        personId: grant.personId,
        groupId: grant.groupId,
        kind: scope.kind,
        repoId: scope.kind === "fleet" ? target.repoId : scope.repoId,
        entityRef: scope.kind === "entity" ? scope.entityRef : "",
      });
      setRefusal(null);
      void inspect(grant.personId, grant.resource);
    };

  if (held.rejection) return <AccessNotice rejection={held.rejection} testId="access-grants-unavailable" />;
  if (!held.data || !catalog.data) return <p className="text-text-muted ui-meta">{t("accessControl.loading")}</p>;

  const allowed = new Set(effective?.actions.map((item) => item.action)),
    denied = catalog.data.actions.map((item) => item.action).filter((action) => !allowed.has(action)),
    field = "flex min-w-[11rem] flex-1 flex-col gap-1 ui-meta text-text-muted";
  return (
    <>
      <div className="glass flex flex-none flex-col gap-3 rounded-sm p-3" data-testid="access-grant-form">
        {refusal && <AccessNotice rejection={refusal} testId="access-grant-refusal" />}
        <div className="flex flex-wrap items-end gap-3">
          <label className={field}>
            {t("accessControl.grants.person")}
            <select
              data-testid="access-grant-person"
              className={INPUT}
              value={target.personId}
              onChange={(event) => setTarget({ ...target, personId: event.currentTarget.value })}
            >
              <option value="">{t("accessControl.grants.choosePerson")}</option>
              {held.data.people.map((person) => (
                <option key={person.personId} value={person.personId}>
                  {person.personId === person.username ? person.personId : `${person.personId} (${person.username})`}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col gap-1 ui-meta text-text-muted">
            {t("accessControl.grants.scope")}
            <SegCtl<ScopeKind>
              value={target.kind}
              onChange={(kind) => setTarget({ ...target, kind })}
              options={[
                { value: "repository", label: t("accessControl.scope.repository") },
                { value: "entity", label: t("accessControl.scope.entity") },
                { value: "fleet", label: t("accessControl.scope.fleet") },
              ]}
            />
          </div>
          {target.kind !== "fleet" && (
            <label className={field}>
              {t("accessControl.grants.repository")}
              <input
                data-testid="access-grant-repo"
                className={`${INPUT} font-mono`}
                list="access-grant-repos"
                value={target.repoId}
                onChange={(event) => setTarget({ ...target, repoId: event.currentTarget.value })}
              />
              <datalist id="access-grant-repos">
                {repos.map((repo) => (
                  <option key={repo.repoId} value={repo.repoId}>
                    {repo.displayName}
                  </option>
                ))}
              </datalist>
            </label>
          )}
          {target.kind === "entity" && (
            <label className={field}>
              {t("accessControl.grants.entityRef")}
              <input
                data-testid="access-grant-entity"
                className={`${INPUT} font-mono`}
                placeholder="task/task_…"
                value={target.entityRef}
                onChange={(event) => setTarget({ ...target, entityRef: event.currentTarget.value })}
              />
            </label>
          )}
          <Button
            testId="access-grant-inspect"
            disabled={busy || target.personId === "" || resource === null}
            onClick={() => {
              setRefusal(null);
              void inspect(target.personId, resource!);
            }}
          >
            {t("accessControl.grants.inspect")}
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <label className={field}>
            {t("accessControl.grants.group")}
            <select
              data-testid="access-grant-group"
              className={INPUT}
              value={target.groupId}
              onChange={(event) => setTarget({ ...target, groupId: event.currentTarget.value })}
            >
              <option value="">{t("accessControl.grants.chooseGroup")}</option>
              {catalog.data.groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.displayName}
                </option>
              ))}
            </select>
          </label>
          <Button
            testId="access-grant-submit"
            variant="primary"
            disabled={busy || target.personId === "" || target.groupId === "" || resource === null}
            onClick={() =>
              void run(
                () => access.grant({ personId: target.personId, groupId: target.groupId, resource: resource! }),
                target.personId,
                resource!,
              )
            }
          >
            {t("accessControl.grants.grant")}
          </Button>
        </div>
      </div>
      <RegionBoard side="primary" data-testid="access-grants-board">
        <BoardMain>
          <BoardColumn>
            <BoardRegion region="effective" fill data-testid="access-effective">
              {effective ? (
                <Region
                  title={t("accessControl.effective.title", {
                    personId: effective.personId,
                    scope: resourceLabel(effective.resource),
                  })}
                  big={`${effective.actions.length}/${catalog.data.actions.length}`}
                  bigTone={effective.actions.length > 0 ? "done" : "neutral"}
                >
                  {effective.grants.map((grant) => (
                    <DenseRow
                      key={`${grant.groupId} ${grant.resource}`}
                      relaxed
                      title={t("accessControl.effective.grantRow", {
                        group: groupName(grant.groupId),
                        scope: resourceLabel(grant.resource),
                      })}
                      reason={
                        // 继承组链随组嵌套深度无界增长:不再整串截断(截断读不到全文),
                        // 链进 ChainStrip 单行横滚,aria-label 带完整链,滚动/键盘可到末项。
                        <span className="flex min-w-0 items-center gap-1">
                          <span className="flex-none">{t("accessControl.effective.inherits")}</span>
                          <ChainStrip
                            testId="inherit-chain"
                            label={`${t("accessControl.effective.inherits")} ${grant.inheritedGroups.join(" → ")}`}
                          >
                            <span className="whitespace-nowrap">{grant.inheritedGroups.join(" → ")}</span>
                          </ChainStrip>
                        </span>
                      }
                      time={
                        <Button
                          size="sm"
                          disabled={busy}
                          testId={`access-revoke-${grant.groupId}`}
                          onClick={() =>
                            void run(
                              () =>
                                access.revoke({
                                  personId: effective.personId,
                                  groupId: grant.groupId,
                                  resource: grant.resource,
                                }),
                              effective.personId,
                              effective.resource,
                            )
                          }
                        >
                          {t("accessControl.grants.revoke")}
                        </Button>
                      }
                    />
                  ))}
                  {actionsBySource(effective).map(({ source, actions }) => (
                    <div
                      key={`${source.sourceGroup} ${source.grantedGroup} ${source.resource}`}
                      data-testid={`access-source-${source.sourceGroup}`}
                      className="flex flex-col gap-2 border-t border-border px-3.5 py-3"
                    >
                      <p className="ui-meta">
                        <span className="font-semibold text-status-done">
                          {t("accessControl.effective.allowedCount", { count: actions.length })}
                        </span>
                        <span className="ml-2 text-text-muted">
                          {t("accessControl.effective.source", {
                            source: groupName(source.sourceGroup),
                            granted: groupName(source.grantedGroup),
                            scope: resourceLabel(source.resource),
                          })}
                        </span>
                      </p>
                      <PillFlow items={actions.map((action) => ({ label: action }))} />
                    </div>
                  ))}
                  <div className="flex flex-col gap-2 border-t border-border px-3.5 py-3" data-testid="access-denied">
                    <p className="text-text-muted ui-meta">
                      {t(
                        effective.grants.length === 0
                          ? "accessControl.effective.deniedNoGrant"
                          : "accessControl.effective.deniedNotIncluded",
                        { count: denied.length },
                      )}
                    </p>
                    <PillFlow items={denied.map((action) => ({ label: action }))} />
                  </div>
                  {effective.receipts.length > 0 && (
                    <div data-testid="access-effective-receipts">
                      <p className="border-t border-border px-3.5 py-2.5 font-semibold ui-meta">
                        {t("accessControl.effective.receipts")}
                      </p>
                      <ReceiptRows receipts={effective.receipts} busy={busy} />
                    </div>
                  )}
                </Region>
              ) : (
                <Region title={t("accessControl.effective.emptyTitle")} padded>
                  <p className="text-text-muted ui-body">{t("accessControl.effective.emptyHint")}</p>
                </Region>
              )}
            </BoardRegion>
          </BoardColumn>
        </BoardMain>
        <BoardSide region="held" data-testid="access-grant-list">
          <Region
            title={t("accessControl.grants.listTitle")}
            big={held.data.grants.length}
            footer={held.data.grants.length === 0 ? t("accessControl.grants.empty") : undefined}
          >
            {held.data.grants.map((grant) => (
              <DenseRow
                key={`${grant.personId} ${grant.groupId} ${grant.resource}`}
                relaxed
                selected={
                  grant.personId === effective?.personId &&
                  grant.resource === effective.resource &&
                  grant.groupId === target.groupId
                }
                title={grant.personId}
                reason={`${groupName(grant.groupId)} · ${resourceLabel(grant.resource)}`}
                onClick={() => look(grant)}
              />
            ))}
          </Region>
        </BoardSide>
      </RegionBoard>
    </>
  );
}
