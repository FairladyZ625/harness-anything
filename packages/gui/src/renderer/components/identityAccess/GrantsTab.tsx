import { useState } from "react";
import type {
  AccessAdminApi,
  AccessEffectivePermissionsReply,
  AccessGrant,
  AccessRejection,
} from "../../../api/access-admin-contract.ts";
import {
  grantsByPerson,
  isRejection,
  resourceLabel,
  resourceOfScope,
  roleLabel,
  type AccessScope,
} from "../../access-model.ts";
import { t } from "../../i18n/index.tsx";
import { IdText } from "../IdText.tsx";
import { Button } from "../primitives/Button.tsx";
import { Modal } from "../primitives/Modal.tsx";
import { Region } from "../primitives/Region.tsx";
import { BoundedContent } from "../primitives/BoundedContent.tsx";
import { SegCtl } from "../primitives/SegCtl.tsx";
import { ActionDetails } from "./ActionDetails.tsx";
import { AccessNotice, INPUT, asRejection, useAccessRead } from "./AccessParts.tsx";

type Pending = { readonly operation: "grant" | "revoke"; readonly grant: AccessGrant };

export function GrantsTab({
  access,
  repos,
}: {
  readonly access: AccessAdminApi;
  readonly repos: readonly { readonly repoId: string; readonly displayName: string }[];
}) {
  const held = useAccessRead(access.grants),
    catalog = useAccessRead(access.groups),
    nodes = useAccessRead(access.nodes);
  const [repoFilter, setRepoFilter] = useState(""),
    [search, setSearch] = useState("");
  const [personId, setPersonId] = useState<string | null>(null),
    [groupId, setGroupId] = useState("viewer");
  const [scope, setScope] = useState<AccessScope>({ kind: "repository", repoId: repos[0]?.repoId ?? "" });
  const [pending, setPending] = useState<Pending | null>(null),
    [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<{
    readonly rejection: AccessRejection;
    readonly origin: "read" | "write";
  } | null>(null);
  const [effective, setEffective] = useState<AccessEffectivePermissionsReply | null>(null);
  const resource = resourceOfScope(scope);
  const name = (id: string) => roleLabel(id, catalog.data?.groups.find((group) => group.id === id)?.displayName);
  const inspect = async (grant: AccessGrant) => {
    setRefusal(null);
    const reply = await access
      .effectivePermissions({ personId: grant.personId, resource: grant.resource })
      .catch(asRejection);
    setEffective(isRejection(reply) ? null : reply);
    if (isRejection(reply)) setRefusal({ rejection: reply, origin: "read" });
  };
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setRefusal(null);
    const reply = await access[pending.operation](pending.grant).catch(asRejection);
    if (isRejection(reply)) setRefusal({ rejection: reply, origin: "write" });
    else {
      await held.reload();
      setEffective(null);
      setPersonId(null);
    }
    setPending(null);
    setBusy(false);
  };
  const rejection = held.rejection ?? catalog.rejection;
  if (rejection) return <AccessNotice rejection={rejection} origin="read" testId="access-grants-unavailable" />;
  if (!held.data || !catalog.data) return <p role="status">{t("accessControl.loading")}</p>;
  const people = grantsByPerson(held.data.people, held.data.grants, repoFilter).filter((person) =>
    `${person.personId} ${person.username}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3" data-testid="access-grants-board">
      {refusal && <AccessNotice rejection={refusal.rejection} origin={refusal.origin} testId="access-grant-refusal" />}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 ui-meta">
          {t("accessControl.members.filter")}
          <select
            className={INPUT}
            data-testid="access-repo-filter"
            value={repoFilter}
            onChange={(event) => setRepoFilter(event.currentTarget.value)}
          >
            <option value="">{t("accessControl.members.allRepos")}</option>
            {repos.map((repo) => (
              <option key={repo.repoId} value={repo.repoId}>
                {repo.displayName}
              </option>
            ))}
          </select>
        </label>
        <input
          className={INPUT}
          aria-label={t("accessControl.members.search")}
          placeholder={t("accessControl.members.search")}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </div>
      {nodes.rejection && <AccessNotice rejection={nodes.rejection} origin="read" />}
      <Region title={t("accessControl.members.title")}>
        <BoundedContent>
          <div data-testid="access-grant-list" className="divide-y divide-border">
            {people.map((person) => {
              const ownedNodes = nodes.data?.nodes.filter((node) => node.personId === person.personId) ?? [];
              return (
                <section
                  key={person.personId}
                  data-person-id={person.personId}
                  className="flex flex-wrap gap-3 px-3.5 py-3"
                >
                  <div className="w-56 shrink-0">
                    <h3 className="font-semibold ui-body">
                      {person.username === person.personId ? (
                        <IdText value={person.personId} className="text-text" />
                      ) : (
                        person.username
                      )}
                    </h3>
                    {person.username !== person.personId && (
                      <p className="text-text-muted ui-meta">
                        <IdText value={person.personId} />
                      </p>
                    )}
                    <p className="text-text-muted ui-meta">
                      {ownedNodes.length > 0
                        ? `${t("accessControl.members.node")} · ${ownedNodes.map((node) => node.nodeId).join(", ")}`
                        : t("accessControl.members.person")}
                    </p>
                  </div>
                  <div className="min-w-0 flex-1">
                    {person.grants.length === 0 ? (
                      <p className="text-text-muted ui-body">{t("accessControl.members.noGrant")}</p>
                    ) : (
                      person.grants.map((grant) => (
                        <div
                          key={`${grant.groupId} ${grant.resource}`}
                          className="flex flex-wrap items-center gap-2 py-1 ui-body"
                        >
                          <span className="min-w-0 flex-1 break-words">
                            {resourceLabel(grant.resource)} · <b>{name(grant.groupId)}</b>
                          </span>
                          <Button
                            size="sm"
                            testId={`access-inspect-${person.personId}-${grant.groupId}`}
                            disabled={busy}
                            onClick={() => void inspect(grant)}
                          >
                            {t("accessControl.grants.inspect")}
                          </Button>
                          <Button
                            size="sm"
                            testId={`access-revoke-${grant.groupId}`}
                            disabled={busy}
                            onClick={() => setPending({ operation: "revoke", grant })}
                          >
                            {t("accessControl.grants.revoke")}
                          </Button>
                        </div>
                      ))
                    )}
                  </div>
                  <span className="self-start">
                    <Button
                      testId={`access-grant-open-${person.personId}`}
                      disabled={busy}
                      onClick={() => {
                        setPersonId(person.personId);
                        setGroupId("viewer");
                        setScope({ kind: "repository", repoId: repoFilter || repos[0]?.repoId || "" });
                      }}
                    >
                      {t("accessControl.members.openGrant")}
                    </Button>
                  </span>
                </section>
              );
            })}
          </div>
        </BoundedContent>
      </Region>
      <p className="text-text-muted ui-meta">{t("accessControl.members.workPending")}</p>
      {effective && (
        <Region
          title={t("accessControl.effective.title", {
            personId: effective.personId,
            scope: resourceLabel(effective.resource),
          })}
          padded
        >
          <div data-testid="access-effective">
            {effective.grants.map((grant) => (
              <p key={`${grant.groupId} ${grant.resource}`} className="ui-body">
                {resourceLabel(grant.resource)}: {name(grant.groupId)} · {t("accessControl.effective.inherits")}{" "}
                {grant.inheritedGroups.map((id) => name(id)).join(" → ")}
              </p>
            ))}
            <ActionDetails
              actions={catalog.data.actions.filter((action) =>
                effective.actions.some((allowed) => allowed.action === action.action),
              )}
            />
          </div>
        </Region>
      )}
      {personId !== null && !pending && (
        <Modal
          title={t("accessControl.members.openGrant")}
          testId="access-grant-form"
          onClose={() => setPersonId(null)}
          footer={
            <Button
              testId="access-grant-submit"
              variant="primary"
              disabled={busy || !groupId || resource === null}
              onClick={() => setPending({ operation: "grant", grant: { personId, groupId, resource: resource! } })}
            >
              {t("accessControl.grants.grant")}
            </Button>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="ui-body">{personId}</p>
            <label className="flex flex-col gap-1 ui-meta">
              {t("accessControl.grants.group")}
              <select
                className={INPUT}
                data-testid="access-grant-group"
                value={groupId}
                onChange={(event) => setGroupId(event.currentTarget.value)}
              >
                {catalog.data.groups.map((group) => (
                  <option key={group.id} value={group.id}>
                    {name(group.id)}
                  </option>
                ))}
              </select>
            </label>
            <SegCtl<AccessScope["kind"]>
              value={scope.kind}
              onChange={(kind) =>
                setScope(
                  kind === "fleet"
                    ? { kind }
                    : kind === "repository"
                      ? { kind, repoId: repos[0]?.repoId ?? "" }
                      : { kind, repoId: repos[0]?.repoId ?? "", entityRef: "" },
                )
              }
              options={[
                { value: "repository", label: t("accessControl.scope.repository") },
                { value: "entity", label: t("accessControl.scope.entity") },
                { value: "fleet", label: t("accessControl.scope.fleet") },
              ]}
            />
            {scope.kind !== "fleet" && (
              <label className="flex flex-col gap-1 ui-meta">
                {t("accessControl.grants.repository")}
                <input
                  className={INPUT}
                  data-testid="access-grant-repo"
                  value={scope.repoId}
                  list="access-grant-repos"
                  onChange={(event) => setScope({ ...scope, repoId: event.currentTarget.value })}
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
            {scope.kind === "entity" && (
              <label className="flex flex-col gap-1 ui-meta">
                {t("accessControl.grants.entityRef")}
                <input
                  className={INPUT}
                  data-testid="access-grant-entity"
                  placeholder="task/task_…"
                  value={scope.entityRef}
                  onChange={(event) => setScope({ ...scope, entityRef: event.currentTarget.value })}
                />
                <span>{t("accessControl.members.workPending")}</span>
              </label>
            )}
          </div>
        </Modal>
      )}
      {pending && (
        <Modal
          title={t(
            pending.operation === "grant"
              ? "accessControl.members.confirmGrant"
              : "accessControl.members.confirmRevoke",
          )}
          testId="access-grant-confirmation"
          onClose={() => {
            if (!busy) setPending(null);
          }}
          footer={
            <div className="flex gap-2">
              <Button testId="access-change-confirm" variant="primary" disabled={busy} onClick={() => void confirm()}>
                {t(
                  pending.operation === "grant"
                    ? "accessControl.members.confirmGrant"
                    : "accessControl.members.confirmRevoke",
                )}
              </Button>
              <Button disabled={busy} onClick={() => setPending(null)}>
                {t("accessControl.members.cancel")}
              </Button>
            </div>
          }
        >
          <p className="ui-body">
            {pending.grant.personId} · {name(pending.grant.groupId)} · {resourceLabel(pending.grant.resource)}
          </p>
          <p className="mt-2 text-text-muted ui-body">{t("accessControl.members.confirmHint")}</p>
        </Modal>
      )}
    </div>
  );
}
