import { SegCtl } from "../primitives/SegCtl.tsx";
import { useEffect, useState } from "react";
import type {
  AccessAdminApi,
  AccessGroupsReply,
  AccessPolicyGroup,
  AccessRejection,
} from "../../../api/access-admin-contract.ts";
import {
  ACTION_FACETS,
  groupActionsByFacet,
  inheritedScopes,
  isRejection,
  type ActionFacet,
} from "../../access-model.ts";
import { t, type MessageKey } from "../../i18n/index.tsx";
import { DenseRow } from "../primitives/DenseRow.tsx";
import { Region } from "../primitives/Region.tsx";
import { BoardColumn, BoardMain, BoardRegion, BoardSide, RegionBoard } from "../primitives/RegionBoard.tsx";
import { StatusTag } from "../primitives/StatusTag.tsx";
import { Button } from "../primitives/Button.tsx";
import { AccessNotice, INPUT, asRejection, useAccessRead } from "./AccessParts.tsx";

const NEW_GROUP = "\u0000new";

const FACET_LABEL: Readonly<Record<ActionFacet, MessageKey>> = {
  policyTier: "accessControl.facet.policyTier",
  executionClass: "accessControl.facet.executionClass",
  residencyScope: "accessControl.facet.residencyScope",
};

interface Draft {
  readonly groupId: string;
  readonly displayName: string;
  readonly scopes: ReadonlySet<string>;
  readonly composites: ReadonlySet<string>;
  /** The version this draft was read at; a save is made against it. */
  readonly version: string | null;
}

function draftOf(group: AccessPolicyGroup | undefined): Draft {
  return {
    groupId: group?.id ?? "",
    displayName: group?.displayName ?? "",
    scopes: new Set(group?.scopes),
    composites: new Set(group?.composites),
    version: group?.version ?? null,
  };
}

function toggled(values: ReadonlySet<string>, names: readonly string[], on: boolean): ReadonlySet<string> {
  const next = new Set(values);
  for (const name of names)
    if (on) next.add(name);
    else next.delete(name);
  return next;
}

/**
 * Policy groups: the list on the right, the selected group on the left. Base groups are generated
 * from the declared actions and shown with every control disabled; the daemon refuses a write to one all the same.
 */
export function PolicyGroupsTab({ access }: { readonly access: AccessAdminApi }) {
  const { data, rejection, reload } = useAccessRead<AccessGroupsReply>(access.groups),
    [selectedId, setSelectedId] = useState<string | null>(null),
    [draft, setDraft] = useState<Draft>(draftOf(undefined)),
    [facet, setFacet] = useState<ActionFacet>("policyTier"),
    [busy, setBusy] = useState(false),
    [refusal, setRefusal] = useState<AccessRejection | null>(null),
    [confirmingDelete, setConfirmingDelete] = useState(false);
  const groups = data?.groups ?? [],
    creating = selectedId === NEW_GROUP,
    selected = groups.find((group) => group.id === selectedId),
    readOnly = selected?.base === true;

  const open = (id: string, from: readonly AccessPolicyGroup[] = groups) => {
    setSelectedId(id);
    setDraft(draftOf(from.find((group) => group.id === id)));
    setRefusal(null);
    setConfirmingDelete(false);
  };
  // The first answer opens the first group, so the page never shows an empty editor next to a full list.
  useEffect(() => {
    if (selectedId === null && data && data.groups.length > 0) open(data.groups[0]!.id, data.groups);
  }, [data]);

  /** Runs one write; on success the list is read again and `next` is opened at its new version. */
  const write = async (operation: () => ReturnType<AccessAdminApi["createGroup"]>, next: string | null) => {
    setBusy(true);
    setRefusal(null);
    const reply = await operation().catch(asRejection);
    if (isRejection(reply)) setRefusal(reply);
    else {
      const fresh = await reload();
      if (fresh) open(next ?? fresh.groups[0]?.id ?? NEW_GROUP, fresh.groups);
    }
    setBusy(false);
    setConfirmingDelete(false);
  };
  const body = () => ({
      groupId: draft.groupId.trim(),
      displayName: draft.displayName.trim() || draft.groupId.trim(),
      scopes: [...draft.scopes].sort(),
      composites: [...draft.composites].sort(),
    }),
    save = () =>
      write(
        () =>
          creating
            ? access.createGroup(body())
            : access.updateGroup({ ...body(), expectedVersion: draft.version ?? "" }),
        draft.groupId.trim(),
      ),
    remove = () =>
      write(() => access.deleteGroup({ groupId: draft.groupId, expectedVersion: draft.version ?? "" }), null),
    loadLatest = async () => {
      const fresh = await reload();
      // The group may be gone: another administrator can delete it as well as change it.
      if (fresh)
        open(
          fresh.groups.find((group) => group.id === selectedId)?.id ?? fresh.groups[0]?.id ?? NEW_GROUP,
          fresh.groups,
        );
    };

  if (rejection) return <AccessNotice rejection={rejection} origin="read" testId="access-groups-unavailable" />;
  if (!data) return <p className="text-text-muted ui-meta">{t("accessControl.loading")}</p>;

  const inherited = inheritedScopes(groups, draft.composites),
    effectiveCount = new Set([...draft.scopes, ...inherited]).size;
  return (
    <RegionBoard data-testid="access-groups-board">
      <BoardMain>
        <BoardColumn>
          <BoardRegion region="group" fill data-testid="access-group-editor">
            <Region
              title={creating ? t("accessControl.groups.newTitle") : draft.displayName || draft.groupId}
              tag={
                creating ? undefined : (
                  <StatusTag
                    tone={readOnly ? "neutral" : "active"}
                    label={t(readOnly ? "accessControl.groups.baseTag" : "accessControl.groups.customTag")}
                  />
                )
              }
              big={effectiveCount}
              padded
              footer={
                <>
                  <span className="min-w-0 truncate">
                    {readOnly
                      ? t("accessControl.groups.baseFooter")
                      : t("accessControl.groups.effectiveFooter", {
                          own: draft.scopes.size,
                          inherited: effectiveCount - draft.scopes.size,
                        })}
                  </span>
                  <span className="ml-auto flex flex-none items-center gap-2">
                    {!creating && (
                      <Button
                        testId="access-group-delete"
                        disabled={busy || readOnly}
                        onClick={() => (confirmingDelete ? void remove() : setConfirmingDelete(true))}
                      >
                        {t(confirmingDelete ? "accessControl.groups.confirmDelete" : "accessControl.groups.delete")}
                      </Button>
                    )}
                    <Button
                      testId="access-group-save"
                      variant="primary"
                      disabled={busy || readOnly || draft.groupId.trim() === ""}
                      onClick={() => void save()}
                    >
                      {t(creating ? "accessControl.groups.create" : "accessControl.groups.save")}
                    </Button>
                  </span>
                </>
              }
            >
              <div className="flex flex-col gap-4">
                {refusal?.code === "version_conflict" ? (
                  <div
                    role="alert"
                    data-testid="access-group-conflict"
                    className="sticky top-0 z-10 flex flex-wrap items-center gap-3 border-l-2 border-status-submitted bg-surface px-3 py-2 ui-meta"
                  >
                    <span className="min-w-0 flex-1">
                      {t("accessControl.groups.conflict", {
                        expected: (refusal.expectedVersion ?? "").slice(0, 8),
                        current: (refusal.currentVersion ?? "").slice(0, 8),
                      })}
                    </span>
                    <Button testId="access-group-load-latest" onClick={() => void loadLatest()}>
                      {t("accessControl.groups.loadLatest")}
                    </Button>
                  </div>
                ) : refusal ? (
                  <div className="sticky top-0 z-10 bg-surface">
                    <AccessNotice rejection={refusal} origin="write" testId="access-group-refusal" />
                  </div>
                ) : null}
                {readOnly && (
                  <p className="text-text-muted ui-meta" data-testid="access-group-base-rule">
                    {t("accessControl.groups.baseRule", {
                      own: selected.scopes.length,
                      inherits:
                        selected.composites.length > 0 ? selected.composites.join(", ") : t("accessControl.none"),
                      effective: selected.effectiveScopes.length,
                    })}
                  </p>
                )}
                <div className="grid grid-cols-[repeat(auto-fit,minmax(14rem,1fr))] gap-3">
                  <label className="flex flex-col gap-1 ui-meta text-text-muted">
                    {t("accessControl.groups.id")}
                    <input
                      data-testid="access-group-id"
                      className={`${INPUT} font-mono`}
                      value={draft.groupId}
                      disabled={!creating}
                      placeholder={t("accessControl.groups.idHint")}
                      onChange={(event) => setDraft({ ...draft, groupId: event.currentTarget.value })}
                    />
                  </label>
                  <label className="flex flex-col gap-1 ui-meta text-text-muted">
                    {t("accessControl.groups.displayName")}
                    <input
                      data-testid="access-group-name"
                      className={INPUT}
                      value={draft.displayName}
                      disabled={readOnly}
                      onChange={(event) => setDraft({ ...draft, displayName: event.currentTarget.value })}
                    />
                  </label>
                </div>
                <fieldset className="flex flex-col gap-1.5" data-testid="access-group-inherits">
                  <legend className="mb-1.5 font-semibold ui-meta">{t("accessControl.groups.inherits")}</legend>
                  <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                    {groups
                      .filter((group) => group.id !== selectedId)
                      .map((group) => (
                        <label key={group.id} className="flex min-h-7 items-center gap-1.5 ui-body">
                          <input
                            type="checkbox"
                            checked={draft.composites.has(group.id)}
                            disabled={readOnly}
                            onChange={(event) =>
                              setDraft({
                                ...draft,
                                composites: toggled(draft.composites, [group.id], event.currentTarget.checked),
                              })
                            }
                          />
                          {group.displayName}
                        </label>
                      ))}
                  </div>
                </fieldset>
                <div className="flex flex-col gap-3" data-testid="access-action-picker">
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-semibold ui-meta">{t("accessControl.groups.actions")}</span>
                    <SegCtl
                      value={facet}
                      onChange={setFacet}
                      options={ACTION_FACETS.map((key) => ({ value: key, label: t(FACET_LABEL[key]) }))}
                    />
                  </div>
                  {groupActionsByFacet(data.actions, facet).map((section) => {
                    const free = section.actions.filter((action) => !inherited.has(action)),
                      held = section.actions.filter((action) => draft.scopes.has(action) || inherited.has(action));
                    return (
                      <fieldset key={section.value} data-testid={`access-actions-${section.value}`}>
                        <legend className="mb-1.5 flex w-full items-center gap-2 border-b border-border pb-1 ui-meta">
                          <label className="flex items-center gap-1.5 font-semibold">
                            <input
                              type="checkbox"
                              aria-label={t("accessControl.groups.selectAll", { section: section.value })}
                              disabled={readOnly || free.length === 0}
                              checked={held.length === section.actions.length}
                              onChange={(event) =>
                                setDraft({
                                  ...draft,
                                  scopes: toggled(draft.scopes, free, event.currentTarget.checked),
                                })
                              }
                            />
                            <span className="font-mono">{section.value}</span>
                          </label>
                          <span className="ml-auto font-mono tabular-nums text-text-faint">
                            {held.length}/{section.actions.length}
                          </span>
                        </legend>
                        <div className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-3">
                          {section.actions.map((action) => {
                            const viaInheritance = inherited.has(action) && !draft.scopes.has(action);
                            return (
                              <label
                                key={action}
                                title={viaInheritance ? t("accessControl.groups.inheritedAction") : undefined}
                                className={`flex min-h-7 items-center gap-1.5 font-mono ui-meta ${
                                  viaInheritance ? "text-text-faint" : "text-text"
                                }`}
                              >
                                <input
                                  type="checkbox"
                                  data-action={action}
                                  checked={draft.scopes.has(action) || inherited.has(action)}
                                  disabled={readOnly || viaInheritance}
                                  onChange={(event) =>
                                    setDraft({
                                      ...draft,
                                      scopes: toggled(draft.scopes, [action], event.currentTarget.checked),
                                    })
                                  }
                                />
                                <span className="min-w-0 truncate">{action}</span>
                              </label>
                            );
                          })}
                        </div>
                      </fieldset>
                    );
                  })}
                </div>
              </div>
            </Region>
          </BoardRegion>
        </BoardColumn>
      </BoardMain>
      <BoardSide region="groups" data-testid="access-group-list">
        <Region
          title={t("accessControl.groups.listTitle")}
          big={groups.length}
          footer={
            <span className="ml-auto">
              <Button testId="access-group-new" disabled={busy} onClick={() => open(NEW_GROUP)}>
                {t("accessControl.groups.new")}
              </Button>
            </span>
          }
        >
          {groups.map((group) => (
            <DenseRow
              key={group.id}
              relaxed
              selected={group.id === selectedId}
              title={group.displayName}
              reason={t(group.base ? "accessControl.groups.baseRow" : "accessControl.groups.customRow", {
                inherits: group.composites.length > 0 ? group.composites.join(", ") : t("accessControl.none"),
              })}
              time={group.effectiveScopes.length}
              onClick={() => open(group.id)}
            />
          ))}
        </Region>
      </BoardSide>
    </RegionBoard>
  );
}
