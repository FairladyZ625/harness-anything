import { useEffect, useState } from "react";
import type { SquadDeclarationV1 } from "../../../../../daemon/src/agent-entities.contract.ts";
import type { AgentEntityRow, SquadEntityDetail, SquadEntityRow } from "../../agent-entity-client.ts";
import { t } from "../../i18n/index.tsx";
import { EntityRefLink } from "../EntityRefLink.tsx";
import { Avatar, Badge, Btn, Card, CardBody, CardHead, CardTitle, Chip, Crumbs, CrumbSep, Empty, Hint, Right, Sect, WarnBar } from "./parts.tsx";

export type SquadDraft = { readonly name: string; readonly leader: string; readonly workers: readonly string[]; readonly roster: string };
export const squadDraftFrom = (detail: SquadEntityDetail): SquadDraft => ({ name: detail.name, leader: detail.leader, workers: detail.workers, roster: detail.roster });
export const squadDeclarationFrom = (id: string, draft: SquadDraft): SquadDeclarationV1 => ({ schema: "squad-declaration/v1", id, name: draft.name.trim(), leader: draft.leader.trim(), workers: draft.workers.filter(Boolean), roster: draft.roster } as SquadDeclarationV1);
export const squadDraftDirty = (detail: SquadEntityDetail, draft: SquadDraft): boolean => JSON.stringify(squadDraftFrom(detail)) !== JSON.stringify(draft);
export type SquadSlot = { readonly kind: "leader" } | { readonly kind: "worker"; readonly index: number };

// Squad org chart geometry, kept pure so the layout is inspectable without a DOM.
export function squadChartLayout(workers: number): { readonly width: number; readonly height: number; readonly startX: number; readonly slotWidth: number } {
  const slotWidth = 150, width = Math.max(380, workers * slotWidth + 50);
  return { width, height: 188, slotWidth, startX: (width - Math.max(0, workers - 1) * slotWidth) / 2 };
}

type Props = { readonly detail: SquadEntityDetail; readonly row: SquadEntityRow | null; readonly agents: readonly AgentEntityRow[]; readonly busy: boolean; readonly onSave: (declaration: SquadDeclarationV1) => void; readonly onLaunch: () => void; readonly onSelectAgent: (agentId: string) => void;
  readonly onSelectSquad: (squadId: string) => void };
export function SquadCard({ detail, row, agents, busy, onSave, onLaunch, onSelectAgent, onSelectSquad }: Props) {
  const [draft, setDraft] = useState<SquadDraft>(() => squadDraftFrom(detail)), [slot, setSlot] = useState<SquadSlot | null>(null);
  useEffect(() => { setDraft(squadDraftFrom(detail)); setSlot(null); }, [detail]);
  const patch = (value: Partial<SquadDraft>) => setDraft((current) => ({ ...current, ...value }));
  const name = (agentId: string) => agents.find((agent) => agent.id === agentId)?.name ?? agentId;
  const dirty = squadDraftDirty(detail, draft), members = draft.workers.length + 1;
  return <div data-testid={`squad-card-${detail.id}`}>
    <Crumbs>
      <span>{t("agentRuntime.segSquads")}</span>
      <CrumbSep />
      <b className="font-semibold text-text-muted">{detail.name}</b>
      <CrumbSep />
      <EntityRefLink
        entityRef={`squad/${detail.id}`}
        onNavigate={() => onSelectSquad(detail.id)}
        title={detail.id}
        className="font-mono text-text-muted hover:text-accent hover:underline"
      />
      <CrumbSep />
      <span className="font-mono">{t("agentRuntime.memberCount", { count: members })}</span>
    </Crumbs>
    <Card>
      <CardHead>
        <CardTitle>{detail.name}</CardTitle>
        <Badge>
          <EntityRefLink
            entityRef={`squad/${detail.id}`}
            onNavigate={() => onSelectSquad(detail.id)}
            title={detail.id}
            className="text-text-muted hover:text-accent hover:underline"
          />
        </Badge>
        {row?.validity === "blocked" && <Badge status="blocked">{t("agentRuntime.declarationBlocked")}</Badge>}
        <Right><input aria-label={t("agentRuntime.squadName")} value={draft.name} onChange={(event) => patch({ name: event.target.value })} className="w-48 rounded border border-transparent bg-transparent px-1 py-px text-[12px] text-text-muted outline-none hover:border-border-strong focus-visible:border-accent focus-visible:bg-surface" /></Right>
      </CardHead>
      <CardBody><Hint>{t("agentRuntime.squadTaskBound")}</Hint></CardBody>

      <Sect title={t("agentRuntime.formation")} desc={t("agentRuntime.formationDesc")} right={<Btn size="sm" variant="ghost" onClick={() => { patch({ workers: [...draft.workers, agents[0]?.id ?? ""] }); setSlot({ kind: "worker", index: draft.workers.length }); }}>{t("agentRuntime.addWorkerSlot")}</Btn>}>
        <div className="overflow-x-auto py-1"><OrgChart leader={name(draft.leader)} workers={draft.workers.map(name)} slot={slot} onPick={setSlot} /></div>
        <div className="mt-2 rounded border border-border bg-surface px-3 py-2.5">{slot === null ? <Empty>{t("agentRuntime.pickSlot")}</Empty> : <SlotConfig agents={agents} slot={slot} draft={draft} onPatch={patch} onClear={() => setSlot(null)} onSelectAgent={onSelectAgent} />}</div>
      </Sect>

      <Sect title={t("agentRuntime.roster")} desc={t("agentRuntime.rosterDesc")}>
        <p className="mb-1.5 text-[11px] text-text-faint">{t("agentRuntime.rosterHint")}</p>
        <textarea aria-label={t("agentRuntime.roster")} data-testid="squad-roster" value={draft.roster} onChange={(event) => patch({ roster: event.target.value })} className="rt-instr min-h-[180px]" />
        <WarnBar><span>{t("agentRuntime.rosterWarn")}</span></WarnBar>
      </Sect>

      <Sect title={t("agentRuntime.actions")}>
        <div className="flex flex-wrap items-center gap-2">
          <Btn variant="primary" disabled={draft.workers.length === 0} onClick={onLaunch}>{t("agentRuntime.launchSquad")}</Btn><Hint>{t("agentRuntime.launchSquadHint")}</Hint>
          <span className="flex-1" />
          <Btn variant="primary" testId="squad-save" disabled={busy || !dirty || !draft.name.trim() || !draft.leader.trim() || !draft.roster.trim()} onClick={() => onSave(squadDeclarationFrom(detail.id, draft))}>{t(dirty ? "agentRuntime.saveDeclaration" : "agentRuntime.saved")}</Btn>
        </div>
      </Sect>
    </Card>
  </div>;
}

function OrgChart({ leader, workers, slot, onPick }: { readonly leader: string; readonly workers: readonly string[]; readonly slot: SquadSlot | null; readonly onPick: (slot: SquadSlot) => void }) {
  const { width, height, startX, slotWidth } = squadChartLayout(workers.length), centre = width / 2;
  const node = (x: number, y: number, w: number, h: number, label: string, sub: string, selected: boolean, commander: boolean, onClick: () => void) => <g key={`${label}-${x}`} role="button" tabIndex={0} onClick={onClick} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") onClick(); }} className={`rt-node cursor-pointer ${commander ? "rt-node-cmd" : ""} ${selected ? "rt-node-sel" : ""}`}>
    <rect x={x - w / 2} y={y - h / 2} width={w} height={h} rx={5} /><text x={x} y={y - 3} textAnchor="middle" fontWeight={600}>{label}</text><text className="rt-node-sub" x={x} y={y + 12} textAnchor="middle">{sub}</text></g>;
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label="squad formation" className="mx-auto block">
    <path className="rt-edge" d={`M ${centre} 61 L ${centre} 80`} strokeWidth={1.5} />
    {workers.length > 1 && <path className="rt-edge" d={`M ${startX} 80 L ${startX + (workers.length - 1) * slotWidth} 80`} />}
    {workers.map((_, index) => <path key={index} className="rt-edge" d={`M ${startX + index * slotWidth} 80 L ${startX + index * slotWidth} 101`} />)}
    {node(centre, 36, 160, 50, t("agentRuntime.commanderSlot"), leader, slot?.kind === "leader", true, () => onPick({ kind: "leader" }))}
    {workers.map((worker, index) => node(startX + index * slotWidth, 128, 122, 54, t("agentRuntime.workerSlot", { index: index + 1 }), worker, slot?.kind === "worker" && slot.index === index, false, () => onPick({ kind: "worker", index })))}
  </svg>;
}

function SlotConfig({ agents, slot, draft, onPatch, onClear, onSelectAgent }: { readonly agents: readonly AgentEntityRow[]; readonly slot: SquadSlot; readonly draft: SquadDraft; readonly onPatch: (value: Partial<SquadDraft>) => void; readonly onClear: () => void; readonly onSelectAgent: (agentId: string) => void }) {
  const current = slot.kind === "leader" ? draft.leader : draft.workers[slot.index] ?? "";
  const assign = (agentId: string) => slot.kind === "leader" ? onPatch({ leader: agentId }) : onPatch({ workers: draft.workers.map((worker, index) => index === slot.index ? agentId : worker) });
  return <div>
    <div className="mb-2 flex flex-wrap items-center gap-2"><Avatar id={current || "unassigned"} /><b className="text-[11px] font-[650]">{slot.kind === "leader" ? t("agentRuntime.commanderSlot") : t("agentRuntime.workerSlot", { index: slot.index + 1 })}</b><Hint>{t(slot.kind === "leader" ? "agentRuntime.commanderSlotHint" : "agentRuntime.workerSlotHint")}</Hint><span className="flex-1" />
      {slot.kind === "worker" && <Btn size="sm" variant="danger" onClick={() => { onPatch({ workers: draft.workers.filter((_, index) => index !== slot.index) }); onClear(); }}>{t("agentRuntime.removeSlot")}</Btn>}</div>
    <div className="flex flex-wrap items-center gap-2">
      <select aria-label={t("agentRuntime.assignAgent")} value={current} onChange={(event) => assign(event.target.value)} className="control">{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name} · {agent.role} · {agent.runtimeType}</option>)}{agents.some((agent) => agent.id === current) ? null : <option value={current}>{current || t("agentRuntime.unassigned")}</option>}</select>
      {current && <Chip tone="link" onClick={() => onSelectAgent(current)}>{t("agentRuntime.openAgent")}</Chip>}
      <Hint>{t("agentRuntime.slotRoleHint")}</Hint>
    </div>
  </div>;
}
