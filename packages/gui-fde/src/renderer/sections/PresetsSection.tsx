import { Plus, Trash } from "@phosphor-icons/react";
import type {
  FdeDomainDraft,
  FdePresetDraft,
  FdePresetProfileDraft,
  FdeTemplateSlotDraft,
} from "../../studio/domain-draft.ts";

interface PresetsSectionProps {
  readonly draft: FdeDomainDraft;
  readonly onChange: (next: FdeDomainDraft) => void;
}

export function PresetsSection({ draft, onChange }: PresetsSectionProps) {
  const gateIds = draft.gates.map((gate) => gate.gateId);

  const updatePreset = (index: number, patch: Partial<FdePresetDraft>) => {
    const presets = draft.presets.map((preset, idx) => (idx === index ? { ...preset, ...patch } : preset));
    const defaultPresetId = index === 0 && patch.presetId ? patch.presetId : draft.defaultPresetId;
    onChange({ ...draft, defaultPresetId, presets });
  };

  const updateProfile = (presetIndex: number, profileIndex: number, patch: Partial<FdePresetProfileDraft>) => {
    const preset = draft.presets[presetIndex];
    if (!preset) return;
    const profiles = preset.profiles.map((profile, idx) => (idx === profileIndex ? { ...profile, ...patch } : profile));
    updatePreset(presetIndex, { profiles });
  };

  const updateTemplate = (presetIndex: number, templateIndex: number, patch: Partial<FdeTemplateSlotDraft>) => {
    const preset = draft.presets[presetIndex];
    if (!preset) return;
    const templates = preset.templates.map((tpl, idx) => (idx === templateIndex ? { ...tpl, ...patch } : tpl));
    updatePreset(presetIndex, { templates });
  };

  return (
    <div className="space-y-4">
      <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
        Presets, Profiles &amp; Bilingual Templates ({draft.presets.length})
      </h2>

      {draft.presets.map((preset, presetIndex) => (
        <div
          key={`${preset.presetId}-${presetIndex}`}
          className="space-y-3 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
        >
          <div className="grid grid-cols-3 gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Preset ID
              <input
                value={preset.presetId}
                onChange={(event) => updatePreset(presetIndex, { presetId: event.target.value })}
                className="font-mono"
              />
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Kind
              <select
                value={preset.presetKind}
                onChange={(event) =>
                  updatePreset(presetIndex, {
                    presetKind: event.target.value as "template-content" | "process-action",
                  })
                }
              >
                <option value="template-content">template-content</option>
                <option value="process-action">process-action</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
              Default Profile
              <select
                value={preset.defaultProfile}
                onChange={(event) => updatePreset(presetIndex, { defaultProfile: event.target.value })}
                className="font-mono"
              >
                {preset.profiles.map((profile) => (
                  <option key={profile.id} value={profile.id}>
                    {profile.id}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="space-y-1.5 border-t border-[var(--color-border)] pt-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] font-medium text-[var(--color-text-muted)]">
                Profiles ({preset.profiles.length})
              </span>
              <button
                type="button"
                onClick={() =>
                  updatePreset(presetIndex, {
                    profiles: [
                      ...preset.profiles,
                      { id: `tier-${preset.profiles.length + 1}`, title: "Custom Tier", completionGates: [] },
                    ],
                  })
                }
                className="inline-flex h-6 items-center gap-1 rounded border border-[var(--color-border)] px-2 text-[11px] hover:border-[var(--color-accent)]"
              >
                <Plus size={11} /> Profile
              </button>
            </div>
            {preset.profiles.map((profile, profileIndex) => (
              <div
                key={profileIndex}
                className="grid grid-cols-[120px_1fr_auto_auto] items-center gap-2 rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2"
              >
                <input
                  aria-label={`Profile ${profileIndex + 1} id`}
                  value={profile.id}
                  onChange={(event) => updateProfile(presetIndex, profileIndex, { id: event.target.value })}
                  className="font-mono"
                />
                <input
                  aria-label={`Profile ${profileIndex + 1} title`}
                  value={profile.title}
                  onChange={(event) => updateProfile(presetIndex, profileIndex, { title: event.target.value })}
                />
                <div className="flex flex-wrap gap-1">
                  {gateIds.map((gateId) => {
                    const enabled = profile.completionGates.includes(gateId);
                    return (
                      <button
                        key={gateId}
                        type="button"
                        aria-pressed={enabled}
                        onClick={() =>
                          updateProfile(presetIndex, profileIndex, {
                            completionGates: enabled
                              ? profile.completionGates.filter((item) => item !== gateId)
                              : [...profile.completionGates, gateId],
                          })
                        }
                        className={`h-6 rounded border px-2 font-mono text-[11px] ${
                          enabled
                            ? "border-[var(--color-pass)] bg-[color-mix(in_oklch,var(--color-pass)_16%,transparent)] text-[var(--color-pass)]"
                            : "border-[var(--color-border)] text-[var(--color-text-muted)]"
                        }`}
                      >
                        {gateId}
                      </button>
                    );
                  })}
                </div>
                <button
                  type="button"
                  aria-label={`Remove profile ${profile.id}`}
                  disabled={preset.profiles.length <= 1}
                  onClick={() =>
                    updatePreset(presetIndex, {
                      profiles: preset.profiles.filter((_, idx) => idx !== profileIndex),
                    })
                  }
                  className="inline-flex h-6 w-6 items-center justify-center rounded border border-[var(--color-border)] text-[var(--color-text-muted)] hover:text-[var(--color-fail)] disabled:opacity-40"
                >
                  <Trash size={12} />
                </button>
              </div>
            ))}
          </div>

          {preset.templates.map((template, templateIndex) => (
            <div key={template.slot} className="space-y-2 border-t border-[var(--color-border)] pt-2">
              <div className="flex items-center justify-between text-[11px] text-[var(--color-text-muted)]">
                <span className="font-mono">{template.slot}</span>
                <span className="font-mono">{template.materializeAs}</span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
                  zh-CN Template
                  <textarea
                    rows={6}
                    value={template.zhCN}
                    onChange={(event) => updateTemplate(presetIndex, templateIndex, { zhCN: event.target.value })}
                    className="font-mono text-[11px]"
                  />
                </label>
                <label className="flex flex-col gap-1 text-[11px] text-[var(--color-text-muted)]">
                  en-US Template
                  <textarea
                    rows={6}
                    value={template.enUS}
                    onChange={(event) => updateTemplate(presetIndex, templateIndex, { enUS: event.target.value })}
                    className="font-mono text-[11px]"
                  />
                </label>
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
