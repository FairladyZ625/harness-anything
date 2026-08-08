import { useMemo, useState } from "react";
import { t } from "../../i18n/index.tsx";
import { BTN, Row, Section } from "../ui/widgets.tsx";
import { useToast } from "../MutationToast.tsx";
import {
  useAgentRuntimeProfilesQuery,
  useWriteAgentRuntimeCredentialsMutation,
  type AgentRuntimeAuthProfile
} from "../../agent-runtime-data.ts";
import { AgentRuntimeCredentialModal } from "./AgentRuntimeCredentialModal.tsx";

export interface AgentRuntimeConfigPanelProps {
  readonly repoId?: string | null;
}

interface ProfileGroup {
  readonly kindId: "claude-code" | "codex";
  readonly profiles: ReadonlyArray<AgentRuntimeAuthProfile>;
}

function stateLabel(state: AgentRuntimeAuthProfile["state"]): { readonly text: string; readonly color: string } {
  switch (state) {
    case "configured":
      return { text: t("views.agentRuntimeView.configured"), color: "text-emerald-500" };
    case "invalid":
      return { text: t("views.agentRuntimeView.invalid"), color: "text-amber-500" };
    default:
      return { text: t("views.agentRuntimeView.notConfigured"), color: "text-text-faint" };
  }
}

export function AgentRuntimeConfigPanel({ repoId }: AgentRuntimeConfigPanelProps) {
  const profilesQuery = useAgentRuntimeProfilesQuery(repoId);
  const profiles = profilesQuery.data ?? [];
  const showToast = useToast();
  const writeMutation = useWriteAgentRuntimeCredentialsMutation();
  const [editing, setEditing] = useState<{ readonly kindId: "claude-code" | "codex" } | null>(null);

  const groups = useMemo<ReadonlyArray<ProfileGroup>>(() => {
    const byKind = new Map<"claude-code" | "codex", AgentRuntimeAuthProfile[]>();
    for (const profile of profiles) {
      const kindId = profile.kindId as "claude-code" | "codex";
      const list = byKind.get(kindId) ?? [];
      list.push(profile);
      byKind.set(kindId, list);
    }
    return [...byKind.entries()].map(([kindId, kindProfiles]) => ({ kindId, profiles: kindProfiles }));
  }, [profiles]);

  const handleSubmit = (payload: { readonly kindId: "claude-code" | "codex"; readonly apiKey: string; readonly baseUrl?: string }) => {
    writeMutation.mutate(payload, {
      onSuccess: (result) => {
        setEditing(null);
        showToast(t("views.agentRuntimeView.credentialsSaved", { path: result.path }), "success");
      },
      onError: (error: Error) => showToast(t("views.agentRuntimeView.credentialsSaveFailed", { error: error.message }), "error")
    });
  };

  return (
    <section className="flex min-w-0 flex-col">
      <Section
        title={t("views.agentRuntimeView.configurationTitle")}
        action={
          <span className="font-mono text-[11px] text-text-faint">
            {profilesQuery.isLoading
              ? t("views.agentRuntimeView.configurationLoading")
              : t("views.agentRuntimeView.configurationProfileCount", { count: profiles.length })}
          </span>
        }
      >
        {profilesQuery.isError && (
          <p className="px-3 py-2 text-sm text-danger">
            {t("views.agentRuntimeView.configurationLoadFailed")}
          </p>
        )}
        {groups.map((group) =>
          group.profiles.map((profile) => {
            const meta = stateLabel(profile.state);
            const isApiKey = profile.profileKind === "api-key";
            return (
              <Row
                key={`${group.kindId}-${profile.profileKind}`}
                label={
                  <span className="flex items-baseline gap-2">
                    <span className="font-mono text-[13px] text-text">{group.kindId}</span>
                    <span className="font-mono text-[11px] text-text-faint">• {profile.profileKind}</span>
                  </span>
                }
                desc={profile.guidance}
              >
                <span className={`font-mono text-[12px] uppercase ${meta.color}`}>
                  {profile.state === "configured" ? "✓ " : ""}{meta.text}
                </span>
                {isApiKey && (
                  <button
                    type="button"
                    className={BTN}
                    onClick={() => setEditing({ kindId: group.kindId })}
                    title={t("views.agentRuntimeView.editApiKey")}
                  >
                    {t("views.agentRuntimeView.edit")}
                  </button>
                )}
              </Row>
            );
          })
        )}
        {!profilesQuery.isLoading && !profilesQuery.isError && profiles.length === 0 && (
          <p className="px-3 py-3 text-sm text-text-muted">{t("views.agentRuntimeView.noProfiles")}</p>
        )}
      </Section>
      {editing && (
        <AgentRuntimeCredentialModal
          kindId={editing.kindId}
          onClose={() => setEditing(null)}
          onSubmit={handleSubmit}
          pending={writeMutation.isPending}
        />
      )}
    </section>
  );
}
