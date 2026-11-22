import { Plus, Trash } from "@phosphor-icons/react";
import type { FdeAgentDraft, FdeDomainDraft } from "../../studio/domain-draft.ts";

interface AgentsSectionProps {
  readonly draft: FdeDomainDraft;
  readonly onChange: (next: FdeDomainDraft) => void;
}

export function AgentsSection({ draft, onChange }: AgentsSectionProps) {
  const updateAgent = (index: number, patch: Partial<FdeAgentDraft>) => {
    const agents = draft.agents.map((agent, idx) => (idx === index ? { ...agent, ...patch } : agent));
    onChange({ ...draft, agents });
  };

  const addAgent = () => {
    const id = `specialist-${draft.agents.length + 1}`;
    onChange({
      ...draft,
      agents: [
        ...draft.agents,
        {
          id,
          name: `${draft.title} Specialist`,
          role: "worker",
          preset: draft.defaultPresetId,
          skills: [],
          instructions: `Execute ${draft.verticalId} tasks under ${draft.defaultPresetId}.`,
        },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Domain Role Agents ({draft.agents.length})
        </h2>
        <button
          type="button"
          onClick={addAgent}
          className="inline-flex h-7 items-center gap-1 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2.5 text-xs font-medium hover:border-[var(--color-accent)]"
        >
          <Plus size={13} /> Add Agent
        </button>
      </div>

      {draft.agents.map((agent, index) => (
        <div
          key={`${agent.id}-${index}`}
          className="space-y-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        >
          <div className="grid grid-cols-[1fr_1fr_110px_auto] items-end gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Agent ID
              <input
                value={agent.id}
                onChange={(event) => updateAgent(index, { id: event.target.value })}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Name
              <input value={agent.name} onChange={(event) => updateAgent(index, { name: event.target.value })} />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Role
              <select
                value={agent.role}
                onChange={(event) => updateAgent(index, { role: event.target.value as FdeAgentDraft["role"] })}
              >
                <option value="worker">worker</option>
                <option value="reviewer">reviewer</option>
                <option value="coordinator">coordinator</option>
              </select>
            </label>
            <button
              type="button"
              aria-label={`Remove agent ${agent.id}`}
              disabled={draft.agents.length <= 1}
              onClick={() => onChange({ ...draft, agents: draft.agents.filter((_, idx) => idx !== index) })}
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-fail)] disabled:opacity-40"
            >
              <Trash size={14} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Preset
              <input
                value={agent.preset}
                onChange={(event) => updateAgent(index, { preset: event.target.value })}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Skills (comma-separated)
              <input
                value={agent.skills.join(", ")}
                onChange={(event) =>
                  updateAgent(index, {
                    skills: event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
                className="font-mono"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
            Instructions
            <textarea
              rows={3}
              value={agent.instructions}
              onChange={(event) => updateAgent(index, { instructions: event.target.value })}
            />
          </label>
        </div>
      ))}
    </div>
  );
}
