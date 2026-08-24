import { useState } from "react";
import type { AgentEntityRow, SquadEntityRow } from "../../agent-entity-client.ts";
import { t } from "../../i18n/index.tsx";
import { Avatar, Badge, Btn, CfgRow, Hint, KindDot, Modal, TextInput, WarnBar } from "./parts.tsx";

export type NewEntityRequest = {
  readonly kind: "agent" | "squad";
  readonly id: string;
  readonly name: string;
  readonly templateId: string | null;
};
export const entitySlug = (value: string): boolean => /^[a-z0-9][a-z0-9-]{0,63}$/u.test(value.trim());

// New Agent / New Squad: pick a role template or start blank, then name it. Copying a
// template reads that entity's declaration and rewrites only the identity, so a new
// worker inherits the instructions the template author actually wrote.
export function NewEntityDialog({
  kind,
  agents,
  squads,
  busy,
  taken,
  onCancel,
  onCreate,
}: {
  readonly kind: "agent" | "squad";
  readonly agents: readonly AgentEntityRow[];
  readonly squads: readonly SquadEntityRow[];
  readonly busy: boolean;
  readonly taken: readonly string[];
  readonly onCancel: () => void;
  readonly onCreate: (request: NewEntityRequest) => void;
}) {
  const [templateId, setTemplateId] = useState<string | null>(null),
    [picked, setPicked] = useState(false),
    [id, setId] = useState(""),
    [name, setName] = useState("");
  const collision = taken.includes(id.trim()),
    valid = picked && entitySlug(id) && !collision && name.trim() !== "";
  const choose = (value: string | null) => {
    setTemplateId(value);
    setPicked(true);
    if (value) {
      const suggestion = `${value}-2`;
      setId(suggestion);
      setName(suggestion);
    }
  };
  return (
    <Modal
      testId={`new-${kind}-dialog`}
      wide
      title={t(kind === "agent" ? "agentRuntime.newAgentTitle" : "agentRuntime.newSquadTitle")}
      hint={t(kind === "agent" ? "agentRuntime.newAgentHint" : "agentRuntime.newSquadHint")}
      onClose={onCancel}
      footer={
        <div className="flex items-center gap-2">
          <Hint>{t(kind === "agent" ? "agentRuntime.newAgentFooter" : "agentRuntime.newSquadFooter")}</Hint>
          <span className="flex-1" />
          <Btn onClick={onCancel}>{t("agentRuntime.cancel")}</Btn>
          <Btn
            variant="primary"
            testId={`new-${kind}-create`}
            disabled={busy || !valid}
            onClick={() => onCreate({ kind, id: id.trim(), name: name.trim(), templateId })}
          >
            {t("agentRuntime.create")}
          </Btn>
        </div>
      }
    >
      <div className="grid gap-2.5 sm:grid-cols-2">
        {kind === "agent"
          ? agents.map((agent) => (
              <TemplateCard
                key={agent.id}
                on={templateId === agent.id}
                onPick={() => choose(agent.id)}
                icon={<Avatar id={agent.id} />}
                title={agent.name}
                desc={t("agentRuntime.agentTemplateDesc", { role: agent.role, runtime: agent.runtimeType || "any" })}
                meta={agent.layer}
              />
            ))
          : squads.map((squad) => (
              <TemplateCard
                key={squad.id}
                on={templateId === squad.id}
                onPick={() => choose(squad.id)}
                icon={<KindDot kind="any" />}
                title={squad.name}
                desc={t("agentRuntime.squadTemplateDesc", { leader: squad.leader, count: squad.workers.length })}
                meta={squad.layer}
              />
            ))}
        <TemplateCard
          on={picked && templateId === null}
          onPick={() => choose(null)}
          dashed
          icon={<span aria-hidden>＋</span>}
          title={t("agentRuntime.blankTitle")}
          desc={t(kind === "agent" ? "agentRuntime.blankAgentDesc" : "agentRuntime.blankSquadDesc")}
          meta={t("agentRuntime.fromScratch")}
        />
      </div>
      {picked && (
        <div className="mt-3">
          <CfgRow label={t("agentRuntime.entityId")}>
            <TextInput
              label={t("agentRuntime.entityId")}
              testId={`new-${kind}-id`}
              mono
              value={id}
              onChange={setId}
              placeholder="kebab-case"
            />
            {collision && <Badge status="blocked">{t("agentRuntime.idTaken")}</Badge>}
            {!collision && id.trim() !== "" && !entitySlug(id) && (
              <Badge status="blocked">{t("agentRuntime.idInvalid")}</Badge>
            )}
          </CfgRow>
          <CfgRow label={t("agentRuntime.name")}>
            <TextInput label={t("agentRuntime.name")} value={name} onChange={setName} />
          </CfgRow>
          {templateId === null && (
            <WarnBar>
              <span>{t(kind === "agent" ? "agentRuntime.blankAgentWarn" : "agentRuntime.blankSquadWarn")}</span>
            </WarnBar>
          )}
        </div>
      )}
    </Modal>
  );
}
function TemplateCard({
  on,
  dashed = false,
  icon,
  title,
  desc,
  meta,
  onPick,
}: {
  readonly on: boolean;
  readonly dashed?: boolean;
  readonly icon: React.ReactNode;
  readonly title: string;
  readonly desc: string;
  readonly meta: string;
  readonly onPick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onPick}
      className={`rounded-lg border px-3 py-2.5 text-left ${dashed ? "border-dashed" : ""} ${on ? "border-accent bg-accent/[0.07]" : "border-border bg-surface hover:border-accent"}`}
    >
      <span className="flex items-center gap-1.5 text-[12px] font-[650]">
        {icon}
        {title}
      </span>
      <span className="my-1 block text-[11px] leading-[1.45] text-text-muted">{desc}</span>
      <span className="block font-mono text-[10px] text-text-faint">{meta}</span>
    </button>
  );
}
