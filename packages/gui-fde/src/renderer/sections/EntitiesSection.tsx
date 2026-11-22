import { Plus, Trash } from "@phosphor-icons/react";
import {
  DEFAULT_GOVERNED_RELATION_PIN,
  DEFAULT_GOVERNED_RELATION_REF,
  FDE_LOCATOR_KINDS,
  FDE_RELATION_KINDS,
  updateEntityInDraft,
  type FdeAttributeType,
  type FdeDomainDraft,
  type FdeEntityAttributeDraft,
  type FdeEntityKindDraft,
  type FdeEntityRelationDraft,
  type FdeRelationKind,
} from "@harness-anything/preset/fde-studio-draft";

interface EntitiesSectionProps {
  readonly draft: FdeDomainDraft;
  readonly onChange: (next: FdeDomainDraft) => void;
}

export function EntitiesSection({ draft, onChange }: EntitiesSectionProps) {
  const entityIds = ["task", "decision", "fact", ...draft.entities.map((entity) => entity.id)];

  const updateEntity = (index: number, patch: Partial<FdeEntityKindDraft>) => {
    onChange(updateEntityInDraft(draft, index, patch));
  };

  const addEntity = () => {
    const idx = draft.entities.length + 1;
    const id = `artifact-${idx}`;
    const nextEntity: FdeEntityKindDraft = {
      id,
      idPrefix: `ART${idx}`,
      singular: `Artifact ${idx}`,
      plural: `Artifacts ${idx}`,
      pathTemplate: `entities/${id}/{id}.json`,
      locatorKinds: ["repository-path"],
      maturityVocabulary: ["draft", "ready"],
      attributes: [{ name: "owner", type: "string", required: true, enumValues: [] }],
    };
    onChange({ ...draft, entities: [...draft.entities, nextEntity] });
  };

  const removeEntity = (index: number) => {
    const removed = draft.entities[index];
    const entities = draft.entities.filter((_, idx) => idx !== index);
    const relations = removed
      ? draft.relations.filter((rel) => rel.sourceKind !== removed.id && rel.targetKind !== removed.id)
      : draft.relations;
    onChange({ ...draft, entities, relations });
  };

  const updateAttribute = (entityIndex: number, attrIndex: number, patch: Partial<FdeEntityAttributeDraft>) => {
    const target = draft.entities[entityIndex];
    if (!target) return;
    const attributes = target.attributes.map((attr, idx) => (idx === attrIndex ? { ...attr, ...patch } : attr));
    updateEntity(entityIndex, { attributes });
  };

  const addAttribute = (entityIndex: number) => {
    const target = draft.entities[entityIndex];
    if (!target) return;
    updateEntity(entityIndex, {
      attributes: [
        ...target.attributes,
        { name: `field${target.attributes.length + 1}`, type: "string", required: false, enumValues: [] },
      ],
    });
  };

  const removeAttribute = (entityIndex: number, attrIndex: number) => {
    const target = draft.entities[entityIndex];
    if (!target) return;
    updateEntity(entityIndex, { attributes: target.attributes.filter((_, idx) => idx !== attrIndex) });
  };

  const updateRelation = (index: number, patch: Partial<FdeEntityRelationDraft>) => {
    const relations = draft.relations.map((rel, idx) => (idx === index ? { ...rel, ...patch } : rel));
    onChange({ ...draft, relations });
  };

  const addRelation = () => {
    const sourceKind = draft.entities[0]?.id ?? "deliverable";
    const nextRelation: FdeEntityRelationDraft = {
      type: "relates",
      sourceKind,
      targetKind: "task",
      reads: "relates to",
      strength: "weak",
      sourceDecisionRef: DEFAULT_GOVERNED_RELATION_REF,
      sourceDecisionPin: DEFAULT_GOVERNED_RELATION_PIN,
    };
    onChange({ ...draft, relations: [...draft.relations, nextRelation] });
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Entity Kinds ({draft.entities.length})
        </h2>
        <button
          type="button"
          onClick={addEntity}
          className="inline-flex h-7 items-center gap-1 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2.5 text-xs font-medium hover:border-[var(--color-accent)]"
        >
          <Plus size={13} /> Add Entity
        </button>
      </div>

      {draft.entities.map((entity, entityIndex) => (
        <div
          key={`${entity.id}-${entityIndex}`}
          className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        >
          <div className="grid grid-cols-[1fr_92px_1fr_auto] items-end gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Kind ID
              <input
                value={entity.id}
                onChange={(event) => updateEntity(entityIndex, { id: event.target.value })}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Prefix
              <input
                value={entity.idPrefix}
                onChange={(event) => updateEntity(entityIndex, { idPrefix: event.target.value.toUpperCase() })}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Path Template
              <input
                value={entity.pathTemplate}
                onChange={(event) => updateEntity(entityIndex, { pathTemplate: event.target.value })}
                className="font-mono"
              />
            </label>
            <button
              type="button"
              aria-label={`Remove entity ${entity.id}`}
              onClick={() => removeEntity(entityIndex)}
              disabled={draft.entities.length <= 1}
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:border-[var(--color-fail)] hover:text-[var(--color-fail)] disabled:opacity-40"
            >
              <Trash size={14} />
            </button>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Singular
              <input
                value={entity.singular}
                onChange={(event) => updateEntity(entityIndex, { singular: event.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Maturity Vocabulary (comma-separated)
              <input
                value={entity.maturityVocabulary.join(", ")}
                onChange={(event) =>
                  updateEntity(entityIndex, {
                    maturityVocabulary: event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean),
                  })
                }
                className="font-mono"
              />
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-[var(--color-text-muted)]">Locators</span>
            {FDE_LOCATOR_KINDS.map((locator) => {
              const active = entity.locatorKinds.includes(locator);
              return (
                <button
                  key={locator}
                  type="button"
                  aria-pressed={active}
                  onClick={() => {
                    const next = active
                      ? entity.locatorKinds.filter((item) => item !== locator)
                      : [...entity.locatorKinds, locator];
                    if (next.length > 0) updateEntity(entityIndex, { locatorKinds: next });
                  }}
                  className={`h-6 rounded border px-2 font-mono text-[11px] ${
                    active
                      ? "border-[var(--color-accent)] bg-[color-mix(in_oklch,var(--color-accent)_16%,transparent)] text-[var(--color-accent)]"
                      : "border-[var(--color-border)] text-[var(--color-text-muted)]"
                  }`}
                >
                  {locator}
                </button>
              );
            })}
          </div>

          <div className="space-y-1.5 border-t border-[var(--color-border)] pt-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
                Attributes ({entity.attributes.length})
              </span>
              <button
                type="button"
                onClick={() => addAttribute(entityIndex)}
                className="inline-flex h-6 items-center gap-1 rounded border border-[var(--color-border)] px-2 text-[11px] hover:border-[var(--color-accent)]"
              >
                <Plus size={11} /> Field
              </button>
            </div>
            {entity.attributes.map((attr, attrIndex) => (
              <div key={attrIndex} className="grid grid-cols-[1fr_92px_1fr_auto_auto] items-center gap-1.5">
                <input
                  aria-label={`Entity ${entity.id} attribute name`}
                  value={attr.name}
                  onChange={(event) => updateAttribute(entityIndex, attrIndex, { name: event.target.value })}
                  className="font-mono"
                />
                <select
                  aria-label={`Entity ${entity.id} attribute ${attr.name} type`}
                  value={attr.type}
                  onChange={(event) =>
                    updateAttribute(entityIndex, attrIndex, { type: event.target.value as FdeAttributeType })
                  }
                >
                  <option value="string">string</option>
                  <option value="number">number</option>
                  <option value="integer">integer</option>
                  <option value="boolean">boolean</option>
                </select>
                <input
                  aria-label={`Entity ${entity.id} attribute ${attr.name} enum values`}
                  placeholder="enum: a, b, c"
                  value={attr.enumValues.join(", ")}
                  onChange={(event) =>
                    updateAttribute(entityIndex, attrIndex, {
                      enumValues: event.target.value
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean),
                    })
                  }
                  className="font-mono"
                />
                <label className="inline-flex items-center gap-1 text-[11px] text-[var(--color-text-muted)]">
                  <input
                    type="checkbox"
                    checked={attr.required}
                    onChange={(event) => updateAttribute(entityIndex, attrIndex, { required: event.target.checked })}
                  />
                  req
                </label>
                <button
                  type="button"
                  aria-label={`Remove attribute ${attr.name}`}
                  onClick={() => removeAttribute(entityIndex, attrIndex)}
                  className="inline-flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-fail)]"
                >
                  <Trash size={12} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ))}

      <div className="space-y-2 border-t border-[var(--color-border)] pt-3">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
            Allowed Relations ({draft.relations.length})
          </h2>
          <button
            type="button"
            onClick={addRelation}
            className="inline-flex h-7 items-center gap-1 rounded border border-[var(--color-border-strong)] bg-[var(--color-surface-raised)] px-2.5 text-xs font-medium hover:border-[var(--color-accent)]"
          >
            <Plus size={13} /> Add Relation
          </button>
        </div>

        {draft.relations.map((relation, relIndex) => (
          <div
            key={relIndex}
            className="grid grid-cols-[1fr_115px_1fr_92px_auto] items-center gap-1.5 rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2"
          >
            <select
              aria-label={`Relation ${relIndex + 1} source`}
              value={relation.sourceKind}
              onChange={(event) => updateRelation(relIndex, { sourceKind: event.target.value })}
              className="font-mono"
            >
              {draft.entities.map((entity) => (
                <option key={entity.id} value={entity.id}>
                  {entity.id}
                </option>
              ))}
            </select>
            <select
              aria-label={`Relation ${relIndex + 1} type`}
              value={relation.type}
              onChange={(event) => updateRelation(relIndex, { type: event.target.value as FdeRelationKind })}
              className="font-mono"
            >
              {FDE_RELATION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
            <select
              aria-label={`Relation ${relIndex + 1} target`}
              value={relation.targetKind}
              onChange={(event) => updateRelation(relIndex, { targetKind: event.target.value })}
              className="font-mono"
            >
              {entityIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
            <select
              aria-label={`Relation ${relIndex + 1} strength`}
              value={relation.strength}
              onChange={(event) => updateRelation(relIndex, { strength: event.target.value as "strong" | "weak" })}
            >
              <option value="strong">strong</option>
              <option value="weak">weak</option>
            </select>
            <button
              type="button"
              aria-label={`Remove relation ${relIndex + 1}`}
              onClick={() => onChange({ ...draft, relations: draft.relations.filter((_, idx) => idx !== relIndex) })}
              className="inline-flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-fail)]"
            >
              <Trash size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
