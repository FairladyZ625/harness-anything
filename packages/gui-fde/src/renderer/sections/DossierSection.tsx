import { Plus, Trash } from "@phosphor-icons/react";
import type { FdeDomainDraft, FdeDossierSlotDraft } from "../../studio/domain-draft.ts";
import type { FdeDossierValidation } from "../../studio/studio-api.ts";

interface DossierSectionProps {
  readonly draft: FdeDomainDraft;
  readonly validation?: FdeDossierValidation;
  readonly onChange: (next: FdeDomainDraft) => void;
}

export function DossierSection({ draft, validation, onChange }: DossierSectionProps) {
  const allEntityKinds = ["task", "decision", "fact", ...draft.entities.map((entity) => entity.id)];

  const updateSlot = (index: number, patch: Partial<FdeDossierSlotDraft>) => {
    const livingDossier = draft.livingDossier.map((slot, idx) => (idx === index ? { ...slot, ...patch } : slot));
    onChange({ ...draft, livingDossier });
  };

  const addSlot = () => {
    const idx = draft.livingDossier.length + 1;
    onChange({
      ...draft,
      livingDossier: [
        ...draft.livingDossier,
        {
          id: `dossier-${idx}`,
          path: `dossier-${idx}.md`,
          kind: "markdown",
          title: `${draft.title} Dossier ${idx}`,
          summary: `Living dossier slot ${idx}`,
          entityKinds: ["task"],
          requiredAnchors: ["overview"],
          minimumDelta: 1,
          periodicMs: null,
        },
      ],
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Living Dossier Slots ({draft.livingDossier.length})
          </h2>
          {validation ? (
            <span
              className={`rounded-full border px-2 py-0.5 font-mono text-[11px] ${
                validation.ok
                  ? "border-[var(--color-pass)] text-[var(--color-pass)]"
                  : "border-[var(--color-fail)] text-[var(--color-fail)]"
              }`}
            >
              {validation.ok ? "SCHEMA OK" : (validation.error ?? "INVALID")}
            </span>
          ) : null}
        </div>
        <button
          type="button"
          onClick={addSlot}
          className="inline-flex h-7 items-center gap-1 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2.5 text-xs font-medium hover:border-[var(--color-accent)]"
        >
          <Plus size={13} /> Add Slot
        </button>
      </div>

      {draft.livingDossier.map((slot, index) => (
        <div
          key={`${slot.id}-${index}`}
          className="space-y-2.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        >
          <div className="grid grid-cols-[1fr_1fr_100px_auto] items-end gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Slot ID
              <input
                value={slot.id}
                onChange={(event) => updateSlot(index, { id: event.target.value })}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Path
              <input
                value={slot.path}
                onChange={(event) => updateSlot(index, { path: event.target.value })}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Kind
              <select
                value={slot.kind}
                onChange={(event) => {
                  const kind = event.target.value as "markdown" | "html";
                  const nextPath =
                    kind === "html" && !slot.path.endsWith(".html")
                      ? `${slot.path.replace(/\.md$/u, "")}.html`
                      : kind === "markdown" && !slot.path.endsWith(".md")
                        ? `${slot.path.replace(/\.html$/u, "")}.md`
                        : slot.path;
                  updateSlot(index, { kind, path: nextPath });
                }}
              >
                <option value="html">html</option>
                <option value="markdown">markdown</option>
              </select>
            </label>
            <button
              type="button"
              aria-label={`Remove dossier slot ${slot.id}`}
              onClick={() =>
                onChange({ ...draft, livingDossier: draft.livingDossier.filter((_, idx) => idx !== index) })
              }
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-fail)]"
            >
              <Trash size={14} />
            </button>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Required Anchors
              <input
                value={slot.requiredAnchors.join(", ")}
                onChange={(event) =>
                  updateSlot(index, {
                    requiredAnchors: event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Watermark Delta
              <input
                type="number"
                min={1}
                value={slot.minimumDelta}
                onChange={(event) => updateSlot(index, { minimumDelta: Math.max(1, Number(event.target.value) || 1) })}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Periodic (ms)
              <input
                type="number"
                min={0}
                value={slot.periodicMs ?? ""}
                placeholder="off"
                onChange={(event) => {
                  const val = Number(event.target.value);
                  updateSlot(index, { periodicMs: val > 0 ? val : null });
                }}
                className="font-mono"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[11px] text-[var(--color-text-muted)]">Entities</span>
            {allEntityKinds.map((kind) => {
              const selected = slot.entityKinds.includes(kind);
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={selected}
                  onClick={() =>
                    updateSlot(index, {
                      entityKinds: selected
                        ? slot.entityKinds.filter((item) => item !== kind)
                        : [...slot.entityKinds, kind],
                    })
                  }
                  className={`h-6 rounded border px-2 font-mono text-[11px] ${
                    selected
                      ? "border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]"
                      : "border-[var(--color-border)] text-[var(--color-text-muted)]"
                  }`}
                >
                  {kind}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
