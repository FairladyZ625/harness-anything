import { Plus, Trash } from "@phosphor-icons/react";
import type { FdeDomainDraft, FdeGateDraft, FdeGateFieldDraft } from "../../studio/domain-draft.ts";

interface GatesSectionProps {
  readonly draft: FdeDomainDraft;
  readonly onChange: (next: FdeDomainDraft) => void;
}

export function GatesSection({ draft, onChange }: GatesSectionProps) {
  const updateGate = (index: number, patch: Partial<FdeGateDraft>) => {
    const gates = draft.gates.map((gate, idx) => (idx === index ? { ...gate, ...patch } : gate));
    onChange({ ...draft, gates });
  };

  const updateField = (gateIndex: number, fieldIndex: number, patch: Partial<FdeGateFieldDraft>) => {
    const gate = draft.gates[gateIndex];
    if (!gate) return;
    const fields = gate.fields.map((field, idx) => (idx === fieldIndex ? { ...field, ...patch } : field));
    updateGate(gateIndex, { fields });
  };

  const addField = (gateIndex: number) => {
    const gate = draft.gates[gateIndex];
    if (!gate) return;
    const name = `field${gate.fields.length + 1}`;
    updateGate(gateIndex, {
      fields: [...gate.fields, { name, type: "string", required: true, minLength: 1, pointer: `/${name}` }],
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Declarative Gates &amp; JSON Pointer Bindings ({draft.gates.length})
        </h2>
      </div>

      {draft.gates.map((gate, gateIndex) => (
        <div
          key={`${gate.gateId}-${gateIndex}`}
          className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        >
          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Gate ID
              <input
                value={gate.gateId}
                onChange={(event) => updateGate(gateIndex, { gateId: event.target.value })}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Source Kind
              <select
                value={gate.sourceKind}
                onChange={(event) => updateGate(gateIndex, { sourceKind: event.target.value as "command" | "manual" })}
              >
                <option value="command">command</option>
                <option value="manual">manual</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Artifact Path
              <input
                value={gate.artifactPath}
                onChange={(event) => updateGate(gateIndex, { artifactPath: event.target.value })}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Artifact Schema
              <input
                value={gate.artifactSchema}
                onChange={(event) => updateGate(gateIndex, { artifactSchema: event.target.value })}
                className="font-mono"
              />
            </label>
          </div>

          <div className="space-y-1.5 border-t border-[var(--color-border)] pt-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
                Predicate Fields &amp; JSON Pointers ({gate.fields.length})
              </span>
              <button
                type="button"
                onClick={() => addField(gateIndex)}
                className="inline-flex h-6 items-center gap-1 rounded border border-[var(--color-border)] px-2 text-[11px] hover:border-[var(--color-accent)]"
              >
                <Plus size={11} /> Binding
              </button>
            </div>
            {gate.fields.map((field, fieldIndex) => (
              <div key={fieldIndex} className="grid grid-cols-[1fr_84px_1fr_1fr_auto] items-center gap-1.5">
                <input
                  aria-label={`Gate ${gate.gateId} field name`}
                  value={field.name}
                  onChange={(event) => updateField(gateIndex, fieldIndex, { name: event.target.value })}
                  className="font-mono"
                />
                <select
                  aria-label={`Gate ${gate.gateId} field ${field.name} type`}
                  value={field.type}
                  onChange={(event) =>
                    updateField(gateIndex, fieldIndex, {
                      type: event.target.value as FdeGateFieldDraft["type"],
                    })
                  }
                >
                  <option value="string">string</option>
                  <option value="boolean">boolean</option>
                  <option value="integer">integer</option>
                  <option value="number">number</option>
                </select>
                <input
                  aria-label={`Gate ${gate.gateId} field ${field.name} JSON Pointer`}
                  value={field.pointer}
                  onChange={(event) => updateField(gateIndex, fieldIndex, { pointer: event.target.value })}
                  placeholder="/path"
                  className="font-mono"
                />
                <input
                  aria-label={`Gate ${gate.gateId} field ${field.name} const value`}
                  value={field.constValue === undefined ? "" : String(field.constValue)}
                  placeholder="const (optional)"
                  onChange={(event) => {
                    const raw = event.target.value;
                    if (raw === "") {
                      updateField(gateIndex, fieldIndex, { constValue: undefined });
                      return;
                    }
                    const constValue =
                      field.type === "boolean"
                        ? raw === "true"
                        : field.type === "integer" || field.type === "number"
                          ? Number(raw)
                          : raw;
                    updateField(gateIndex, fieldIndex, { constValue });
                  }}
                  className="font-mono"
                />
                <button
                  type="button"
                  aria-label={`Remove binding ${field.name}`}
                  onClick={() => updateGate(gateIndex, { fields: gate.fields.filter((_, idx) => idx !== fieldIndex) })}
                  className="inline-flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-fail)]"
                >
                  <Trash size={12} />
                </button>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-2 gap-2 border-t border-[var(--color-border)] pt-2">
            <label className="flex flex-col gap-1 text-[11px] font-medium text-[var(--color-pass)]">
              Positive Sample JSON (expect PASS)
              <textarea
                rows={7}
                value={gate.positiveSampleJson}
                onChange={(event) => updateGate(gateIndex, { positiveSampleJson: event.target.value })}
                className="font-mono text-[11px] leading-relaxed"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] font-medium text-[var(--color-fail)]">
              Negative Sample JSON (expect FAIL)
              <textarea
                rows={7}
                value={gate.negativeSampleJson}
                onChange={(event) => updateGate(gateIndex, { negativeSampleJson: event.target.value })}
                className="font-mono text-[11px] leading-relaxed"
              />
            </label>
          </div>
        </div>
      ))}
    </div>
  );
}
