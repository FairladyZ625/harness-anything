import { useEffect, useState } from "react";
import type { AgentDeclarationV1 } from "../../../../../daemon/src/agent-entities.contract.ts";
import type { RuntimeInstanceSummary } from "../../../../../daemon/src/agent-runtime-instances.ts";
import { runtimeTypeMatchesKind } from "../../../../../daemon/src/agent-runtime-contract.ts";
import type { AgentEntityDetail, AgentEntityRow, AgentSkillRow, SquadEntityRow } from "../../agent-entity-client.ts";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { AddChip, Avatar, Badge, Btn, Card, Chip, ChipZone, Crumbs, CrumbSep, Empty, Hint, KindDot, LiveDot, RoleTag, Sect, SegCtl, TextInput } from "./parts.tsx";

export type AgentDraft = { readonly name: string; readonly role: "worker" | "commander"; readonly runtimeType: string; readonly model: string; readonly preset: string; readonly skills: readonly { readonly id: string; readonly path: string }[]; readonly instructions: string; readonly prompts: readonly string[] };
export const agentDraftFrom = (detail: AgentEntityDetail): AgentDraft => ({ name: detail.name, role: detail.role, runtimeType: detail.runtimeType, model: detail.model ?? "", preset: detail.preset ?? "", skills: detail.skills, instructions: detail.instructions, prompts: detail.prompts });
export function agentDeclarationFrom(id: string, draft: AgentDraft): AgentDeclarationV1 {
  return { schema: "agent-declaration/v1", id, name: draft.name.trim(), instructions: draft.instructions, runtime_type: draft.runtimeType.trim(), role: draft.role, ...(draft.model.trim() ? { model: draft.model.trim() } : {}), ...(draft.skills.length ? { skills: draft.skills } : {}), ...(draft.prompts.filter((prompt) => prompt.trim()).length ? { prompts: draft.prompts.map((prompt) => prompt.trim()).filter(Boolean) } : {}), ...(draft.preset.trim() ? { preset: draft.preset.trim() } : {}) } as AgentDeclarationV1;
}
export const agentDraftDirty = (detail: AgentEntityDetail, draft: AgentDraft): boolean => JSON.stringify(agentDraftFrom(detail)) !== JSON.stringify(draft);

type Props = {
  readonly detail: AgentEntityDetail; readonly row: AgentEntityRow | null; readonly squads: readonly SquadEntityRow[]; readonly instances: readonly RuntimeInstanceSummary[]; readonly availableSkills?: readonly AgentSkillRow[]; readonly presets?: readonly { readonly id: string; readonly title: string; readonly description: string }[];
  readonly busy: boolean; readonly onSave: (declaration: AgentDeclarationV1) => void; readonly onDispatch: (mission: string) => void; readonly onSelectSquad: (squadId: string) => void; readonly onSelectRuntime: (instanceId: string) => void;
  readonly onSelectAgent: (agentId: string) => void;
};
export function AgentCard({
  detail, row, squads, instances, availableSkills = [], presets = [], busy,
  onSave, onDispatch, onSelectSquad, onSelectRuntime, onSelectAgent,
}: Props) {

  const [draft, setDraft] = useState<AgentDraft>(() => agentDraftFrom(detail)), [runtimeListOpen, setRuntimeListOpen] = useState(false), [skillSearch, setSkillSearch] = useState(""), [presetSearch, setPresetSearch] = useState(""), [customModelOpen, setCustomModelOpen] = useState(false);
  useEffect(() => { setDraft(agentDraftFrom(detail)); }, [detail]);
  const patch = (value: Partial<AgentDraft>) => setDraft((current) => ({ ...current, ...value }));
  const compatible = instances.filter((instance) => instance.enabled && runtimeTypeMatchesKind(draft.runtimeType, instance.kindId));
  const models = [...new Set(compatible.flatMap((instance) => instance.models))].sort(), filteredSkills = availableSkills.filter((skill) => !draft.skills.some((selected) => selected.id === skill.id) && `${skill.id} ${skill.path} ${skill.source}`.toLowerCase().includes(skillSearch.trim().toLowerCase())), filteredPresets = presets.filter((preset) => `${preset.id} ${preset.title} ${preset.description}`.toLowerCase().includes(presetSearch.trim().toLowerCase()));
  const referencing = squads.filter((squad) => squad.leader === detail.id || squad.workers.includes(detail.id));
  const dirty = agentDraftDirty(detail, draft);
  return <div data-testid={`agent-card-${detail.id}`}>
    <Crumbs>
      <span>{t("agentRuntime.segAgents")}</span>
      <CrumbSep />
      <b className="font-semibold text-text-muted">{detail.name}</b>
      <CrumbSep />
      <EntityRefLink
        entityRef={`agent/${detail.id}`}
        onNavigate={() => onSelectAgent(detail.id)}
        title={detail.id}
        className="font-mono text-text-muted hover:text-accent hover:underline"
      />
    </Crumbs>
    <Card>
      <div className="flex items-start gap-3 px-3.5 py-3">
        <Avatar id={detail.id} size="lg" />
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <input aria-label={t("agentRuntime.agentName")} value={draft.name} onChange={(event) => patch({ name: event.target.value })} className="min-w-[200px] rounded border border-transparent bg-transparent px-1 py-px text-[15px] font-bold text-text outline-none hover:border-border-strong focus-visible:border-accent focus-visible:bg-surface" />
            <EntityRefLink
              entityRef={`agent/${detail.id}`}
              onNavigate={() => onSelectAgent(detail.id)}
              title={detail.id}
              className="font-mono text-[10.5px] text-text-faint hover:text-accent hover:underline"
            />
            {row && <Badge tip={t("agentRuntime.layerTip", { layer: row.layer })}>{row.layer}</Badge>}
            {row?.validity === "blocked" && <Badge status="blocked">{t("agentRuntime.declarationBlocked")}</Badge>}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SegCtl label={t("agentRuntime.role")} value={draft.role} onChange={(role) => patch({ role })} options={[{ value: "worker" as const, label: t("agentRuntime.roleWorker"), tip: t("agentRuntime.roleWorkerTip") }, { value: "commander" as const, label: t("agentRuntime.roleCommander"), tip: t("agentRuntime.roleCommanderTip") }]} />
            <Hint>{t("agentRuntime.roleModelDecoupled")}</Hint>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Hint>{t("agentRuntime.referencedBySquads", { count: referencing.length })}</Hint>
            {referencing.map((squad) => <Chip key={squad.id} tone="link" onClick={() => onSelectSquad(squad.id)}>{squad.name}<RoleTag>{squad.leader === detail.id ? t("agentRuntime.roleCommander") : t("agentRuntime.roleWorker")}</RoleTag></Chip>)}
          </div>
        </div>
      </div>

      <Sect title={t("agentRuntime.instructions")} desc={t("agentRuntime.instructionsDesc")} right={<span className="font-mono">{t("agentRuntime.charCount", { count: draft.instructions.length })}</span>}>
        <p className="mb-1.5 text-[11px] text-text-faint">{t("agentRuntime.instructionsHint")}</p>
        <textarea aria-label={t("agentRuntime.instructions")} data-testid="agent-instructions" value={draft.instructions} onChange={(event) => patch({ instructions: event.target.value })} className="rt-instr" />
      </Sect>

      <Sect title={t("agentRuntime.skills")} desc={t("agentRuntime.skillsDesc")}>
        <ChipZone>{draft.skills.length ? draft.skills.map((skill) => <Chip key={skill.path} tone="mono" tip={skill.path} onClick={() => patch({ skills: draft.skills.filter((selected) => selected.path !== skill.path) })}>{skill.id} ×</Chip>) : <Empty>{t("agentRuntime.noSkills")}</Empty>}</ChipZone>
        <div className="mt-2 grid gap-1.5"><TextInput label={t("agentRuntime.skillSearch")} testId="agent-skill-search" mono value={skillSearch} onChange={setSkillSearch} placeholder={t("agentRuntime.skillSearchPlaceholder")} />
          {skillSearch.trim() && <div className="max-h-36 overflow-y-auto rounded border border-border bg-surface p-1">{filteredSkills.length ? filteredSkills.map((skill) => <button key={skill.path} type="button" onClick={() => { patch({ skills: [...draft.skills, { id: skill.id, path: skill.path }] }); setSkillSearch(""); }} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-surface-raised"><b className="font-mono text-[11px]">{skill.id}</b><Badge>{skill.source}</Badge><span className="min-w-0 truncate font-mono text-[10px] text-text-faint">{skill.path}</span></button>) : <Empty>{t("agentRuntime.noSkillMatches")}</Empty>}</div>}
        </div>
      </Sect>

      <Sect title={t("agentRuntime.preset")} desc={t("agentRuntime.presetDesc")}>
        <div className="flex flex-wrap items-center gap-2">{draft.preset && <Chip tone="mono" onClick={() => patch({ preset: "" })}>{draft.preset} ×</Chip>}<TextInput label={t("agentRuntime.presetSearch")} testId="agent-preset" mono value={presetSearch} onChange={setPresetSearch} placeholder={t("agentRuntime.presetSearchPlaceholder")} /><Hint>{t("agentRuntime.presetHint")}</Hint></div>
        {presetSearch.trim() && <div className="mt-1.5 max-h-36 overflow-y-auto rounded border border-border bg-surface p-1">{filteredPresets.length ? filteredPresets.map((preset) => <button key={preset.id} type="button" onClick={() => { patch({ preset: preset.id }); setPresetSearch(""); }} className="block w-full rounded px-2 py-1 text-left hover:bg-surface-raised"><b className="text-[11px]">{preset.title}</b><span className="ml-2 font-mono text-[10px] text-text-faint">{preset.id}</span></button>) : <Empty>{t("agentRuntime.noPresetMatches")}</Empty>}</div>}
      </Sect>

      <Sect title={t("agentRuntime.prompts")} desc={t("agentRuntime.promptsDesc")} right={<AddChip onClick={() => patch({ prompts: [...draft.prompts, ""] })}>{t("agentRuntime.addPrompt")}</AddChip>}>
        {draft.prompts.length ? draft.prompts.map((prompt, index) => <div key={index} className="mb-1.5 flex items-center gap-2 rounded border border-border bg-surface px-2 py-1.5">
          <span className="font-mono text-[10px] text-text-faint">{String(index + 1).padStart(2, "0")}</span>
          <input aria-label={t("agentRuntime.promptAt", { index: index + 1 })} value={prompt} onChange={(event) => patch({ prompts: draft.prompts.map((entry, position) => position === index ? event.target.value : entry) })} className="min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 py-px font-mono text-[11px] text-text outline-none focus-visible:border-accent" />
          <Btn size="sm" variant="ghost" disabled={index === 0} onClick={() => patch({ prompts: swap(draft.prompts, index, index - 1) })} tip={t("agentRuntime.moveUp")}>↑</Btn>
          <Btn size="sm" variant="ghost" disabled={index === draft.prompts.length - 1} onClick={() => patch({ prompts: swap(draft.prompts, index, index + 1) })} tip={t("agentRuntime.moveDown")}>↓</Btn>
          <Btn size="sm" variant="primary" disabled={!prompt.trim()} onClick={() => onDispatch(prompt)}>{t("agentRuntime.dispatchWithPrompt")}</Btn>
          <Btn size="sm" variant="ghost" onClick={() => patch({ prompts: draft.prompts.filter((_, position) => position !== index) })} tip={t("agentRuntime.remove")}>✕</Btn>
        </div>) : <Empty>{t("agentRuntime.noPrompts")}</Empty>}
      </Sect>

      <Sect title={t("agentRuntime.runtimeConstraint")} desc={t("agentRuntime.runtimeConstraintDesc")}>
        <div className="flex flex-wrap items-center gap-2">
          <SegCtl label={t("agentRuntime.runtimeConstraint")} value={draft.runtimeType} onChange={(runtimeType) => patch({ runtimeType })} options={[{ value: "any", label: t("agentRuntime.anyRuntime") }, { value: "claude", label: "claude" }, { value: "codex", label: "codex" }, { value: "agy", label: "agy" }]} />
          <Hint>{t("agentRuntime.compatibleCount", { count: compatible.length })}</Hint>
          <Btn size="sm" variant="ghost" onClick={() => setRuntimeListOpen(!runtimeListOpen)}>{t(runtimeListOpen ? "agentRuntime.collapse" : "agentRuntime.expand")}</Btn>
          <select aria-label={t("agentRuntime.modelPreference")} data-testid="agent-model-select" value={models.includes(draft.model) ? draft.model : ""} onChange={(event) => { patch({ model: event.target.value }); setCustomModelOpen(false); }} className="control"><option value="">{t("agentRuntime.providerDefault")}</option>{models.map((model) => <option key={model} value={model}>{model}</option>)}</select>
          <Btn size="sm" variant="ghost" onClick={() => setCustomModelOpen(!customModelOpen)}>{t("agentRuntime.customModelOverride")}</Btn>
          {(customModelOpen || draft.model && !models.includes(draft.model)) && <TextInput label={t("agentRuntime.customModelOverride")} testId="agent-model-custom" mono value={draft.model} onChange={(model) => patch({ model })} placeholder={t("agentRuntime.modelPreferencePlaceholder")} />}
        </div>
        {runtimeListOpen && <div className="mt-2 rounded border border-border px-2 py-1.5">{compatible.length ? compatible.map((instance) => <button key={instance.instanceId} type="button" onClick={() => onSelectRuntime(instance.instanceId)} className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11px] hover:text-accent"><KindDot kind={instance.kindId} /><span>{instance.name}</span><span className="font-mono text-[10px] text-text-faint">{instance.defaultModel}</span><LiveDot state={instance.enabled ? "live" : "idle"} /></button>) : <Empty>{t("agentRuntime.noCompatibleInstance")}</Empty>}</div>}
        <p className="mt-2 text-[11px] text-text-faint">{t("agentRuntime.runtimeConstraintNote")}</p>
      </Sect>

      <Sect title={t("agentRuntime.actions")}>
        <div className="flex flex-wrap items-center gap-2">
          {row?.validity === "blocked" ? <Hint>{t("agentRuntime.dispatchBlocked")}</Hint> : <><Btn variant="primary" testId={`dispatch-entry-${detail.id}`} onClick={() => onDispatch("")}>{t("agentRuntime.dispatch")}</Btn><Hint>{t("agentRuntime.dispatchHint")}</Hint></>}<span className="flex-1" />
          <Btn variant="primary" testId="agent-save" disabled={busy || !dirty || !draft.name.trim() || !draft.instructions.trim()} onClick={() => onSave(agentDeclarationFrom(detail.id, draft))}>{t(dirty ? "agentRuntime.saveDeclaration" : "agentRuntime.saved")}</Btn>
        </div>
      </Sect>
    </Card>
  </div>;
}
const swap = <T,>(items: readonly T[], from: number, to: number): readonly T[] => { const next = [...items]; const [moved] = next.splice(from, 1); next.splice(to, 0, moved as T); return next; };
