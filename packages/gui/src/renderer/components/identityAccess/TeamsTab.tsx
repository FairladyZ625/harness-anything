import { useState } from "react";
import type { AccessAdminApi, AccessReceipt, AccessRejection } from "../../../api/access-admin-contract.ts";
import { isRejection } from "../../access-model.ts";
import { t } from "../../i18n/index.tsx";
import { Button } from "../primitives/Button.tsx";
import { DenseRow } from "../primitives/DenseRow.tsx";
import { Modal } from "../primitives/Modal.tsx";
import { Region } from "../primitives/Region.tsx";
import { BoardColumn, BoardMain, BoardRegion, BoardSide, RegionBoard } from "../primitives/RegionBoard.tsx";
import { AccessNotice, INPUT, asRejection, useAccessRead } from "./AccessParts.tsx";

export function TeamsTab({ access }: { readonly access: AccessAdminApi }) {
  const { data, rejection, reload } = useAccessRead(access.teams),
    [selectedId, select] = useState<string | null>(null),
    [creating, setCreating] = useState(false),
    [pending, setPending] = useState<{ readonly personId: string; readonly adding: boolean } | null>(null),
    [name, setName] = useState(""),
    [busy, setBusy] = useState(false),
    [refusal, setRefusal] = useState<AccessRejection | null>(null),
    selected = data?.teams.find((team) => team.id === selectedId),
    change = selected ? { teamId: selected.id, expectedVersion: selected.version } : null;
  async function mutate(write: () => Promise<({ readonly ok: true } & AccessReceipt) | AccessRejection>) {
    setBusy(true);
    try {
      const reply = await write().catch(asRejection);
      setRefusal(isRejection(reply) ? reply : null);
      if (!isRejection(reply)) {
        await reload();
        setCreating(false);
      }
      setPending(null);
    } finally {
      setBusy(false);
    }
  }
  if (rejection) return <AccessNotice rejection={rejection} origin="read" />;
  if (!data) return <p role="status">{t("accessControl.teams.loading")}</p>;
  return (
    <>
      <RegionBoard data-testid="access-teams">
        <BoardMain>
          <BoardColumn>
            <BoardRegion region="members">
              <Region title={t("accessControl.teams.members")}>
                <div className="flex flex-col gap-3 p-3">
                  <p className="ui-body text-text-muted">{t("accessControl.teams.rule")}</p>
                  {refusal && <AccessNotice rejection={refusal} origin="write" testId="access-team-refusal" />}
                  {(selected || creating) && (
                    <div className="flex flex-wrap items-end gap-2">
                      <label className="flex min-w-0 flex-1 flex-col gap-1 ui-meta">
                        {t("accessControl.teams.name")}
                        <input
                          className={INPUT}
                          data-testid="access-team-name"
                          value={name}
                          disabled={busy}
                          onChange={(event) => setName(event.currentTarget.value)}
                        />
                      </label>
                      <Button
                        testId="access-team-save"
                        disabled={busy || !name.trim()}
                        onClick={() =>
                          void mutate(() =>
                            change
                              ? access.updateTeam({ ...change, teamName: name.trim() })
                              : access.createTeam({ teamName: name.trim() }),
                          )
                        }
                      >
                        {t("accessControl.teams.save")}
                      </Button>
                      {change && (
                        <Button
                          testId="access-team-delete"
                          disabled={busy}
                          onClick={() => void mutate(() => access.deleteTeam(change))}
                        >
                          {t("accessControl.teams.delete")}
                        </Button>
                      )}
                      <Button
                        disabled={busy}
                        onClick={() => {
                          setRefusal(null);
                          void reload();
                        }}
                      >
                        {t("accessControl.teams.refresh")}
                      </Button>
                    </div>
                  )}
                  {selected && change ? (
                    <fieldset disabled={busy} className="flex flex-col gap-1">
                      <legend className="mb-2 font-semibold">{selected.name}</legend>
                      {data.people.map((person) => (
                        <label key={person.personId} className="flex min-h-7 items-center gap-2 ui-body">
                          <input
                            type="checkbox"
                            checked={selected.personIds.includes(person.personId)}
                            onChange={(event) => {
                              setPending({ personId: person.personId, adding: event.currentTarget.checked });
                            }}
                          />
                          {person.username} <span className="text-text-muted">{person.personId}</span>
                        </label>
                      ))}
                    </fieldset>
                  ) : (
                    <p className="ui-body text-text-muted">{t("accessControl.teams.choose")}</p>
                  )}
                </div>
              </Region>
            </BoardRegion>
          </BoardColumn>
        </BoardMain>
        <BoardSide region="teams">
          <Region
            title={t("accessControl.teams.title")}
            footer={
              <Button
                testId="access-team-new"
                disabled={busy}
                onClick={() => {
                  select(null);
                  setCreating(true);
                  setName("");
                  setRefusal(null);
                }}
              >
                {t("accessControl.teams.new")}
              </Button>
            }
          >
            {data.teams.map((team) => (
              <DenseRow
                key={team.id}
                title={team.name}
                selected={selectedId === team.id}
                onClick={() => {
                  if (!busy) {
                    setCreating(false);
                    select(team.id);
                    setName(team.name);
                    setRefusal(null);
                  }
                }}
              />
            ))}
            {!data.teams.length && <p className="p-3 ui-body text-text-muted">{t("accessControl.teams.empty")}</p>}
          </Region>
        </BoardSide>
      </RegionBoard>
      {pending && selected && change && (
        <Modal
          title={t(pending.adding ? "accessControl.teams.confirmAdd" : "accessControl.teams.confirmRemove", {
            person: pending.personId,
            team: selected.name,
          })}
          testId="access-team-confirmation"
          onClose={() => {
            if (!busy) setPending(null);
          }}
          footer={
            <div className="flex gap-2">
              <Button
                testId="access-team-confirm"
                disabled={busy}
                onClick={() =>
                  void mutate(() =>
                    (pending.adding ? access.addTeamMember : access.removeTeamMember)({
                      ...change,
                      personId: pending.personId,
                    }),
                  )
                }
              >
                {t("accessControl.teams.confirm")}
              </Button>
              <Button disabled={busy} onClick={() => setPending(null)}>
                {t("accessControl.members.cancel")}
              </Button>
            </div>
          }
        >
          <p>{t("accessControl.teams.rule")}</p>
        </Modal>
      )}
    </>
  );
}
