import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { harnessClient, type ResidentCeoConfigureInput } from "../api-client.ts";
import { agentEntityClient, isAvailableAgentEntityRow } from "../agent-entity-client.ts";
import { decisionProviderClient } from "../decision-provider-client.ts";
import { runtimeInstanceClient } from "../runtime-instance-client.ts";
import { t } from "../i18n/index.tsx";
import { PageHeader } from "../components/primitives/PageHeader.tsx";
import { Button } from "../components/primitives/Button.tsx";
import { ActionError } from "../components/runtime/ActionError.tsx";
import { ResidentCeoStatusBar } from "./resident-ceo/ResidentCeoStatusBar.tsx";
import { ResidentCeoProposalsPanel } from "./resident-ceo/ResidentCeoProposalsPanel.tsx";
import { ResidentCeoTimeline } from "./resident-ceo/ResidentCeoTimeline.tsx";
import { ResidentCeoConfigDrawer } from "./resident-ceo/ResidentCeoConfigDrawer.tsx";

const NOOP_NAVIGATE = (): void => undefined;

export function ResidentCeoView({
  repoId,
  onNavigateEntity = NOOP_NAVIGATE,
}: {
  readonly repoId: string;
  readonly onNavigateEntity?: (ref: string) => void;
}) {
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [configSavedNotice, setConfigSavedNotice] = useState(false);
  const [message, setMessage] = useState("");
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  const profileQuery = useQuery({
    queryKey: ["resident-ceo", repoId],
    queryFn: () => harnessClient.getResidentCeo({ repoId }),
    refetchInterval: (query) => (query.state.data?.profile?.status === "running" ? 5_000 : false),
  });
  const profile = profileQuery.data?.profile ?? null;
  const isRunning = profile?.status === "running";

  const historyQuery = useQuery({
    queryKey: ["resident-ceo-history", repoId],
    queryFn: () => harnessClient.getResidentCeoHistory({ repoId, limit: 100 }),
    refetchInterval: isRunning ? 5_000 : false,
  });

  const proposalsQuery = useQuery({
    queryKey: ["resident-ceo-proposals", repoId],
    queryFn: () => harnessClient.listResidentCeoProposals({ repoId }),
    refetchInterval: isRunning ? 5_000 : false,
  });

  const instanceQuery = useQuery({
    queryKey: ["runtime-instances", "machine", repoId],
    queryFn: () => runtimeInstanceClient.list(repoId),
  });

  const agentsQuery = useQuery({
    queryKey: ["agent-entities", repoId],
    queryFn: () => agentEntityClient.listAgents(repoId),
    enabled: settingsOpen,
  });

  const decisionProvidersQuery = useQuery({
    queryKey: ["decision-providers"],
    queryFn: () => decisionProviderClient.list(),
    enabled: settingsOpen,
  });

  const instances = instanceQuery.data?.instances.filter((instance) => instance.enabled) ?? [];
  const agentIds = (agentsQuery.data ?? [])
    .filter(isAvailableAgentEntityRow)
    .map((row) => row.id)
    .sort();
  const decisionProviders = (decisionProvidersQuery.data ?? []).filter((item) => item.enabled);

  const history = historyQuery.data?.history ?? profile?.history ?? [];
  const proposals = proposalsQuery.data?.proposals ?? profile?.proposals ?? [];
  const pendingProposalCount = proposals.filter((item) => item.status === "pending_approval").length;

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["resident-ceo", repoId] });
    void queryClient.invalidateQueries({ queryKey: ["resident-ceo-history", repoId] });
    void queryClient.invalidateQueries({ queryKey: ["resident-ceo-proposals", repoId] });
  };

  const configure = useMutation({
    mutationFn: (input: ResidentCeoConfigureInput) => harnessClient.configureResidentCeo(input),
    onSuccess: () => {
      setConfigSavedNotice(true);
      refreshAll();
    },
  });

  const start = useMutation({
    mutationFn: () => harnessClient.startResidentCeo({ repoId }),
    onSuccess: refreshAll,
  });

  const stop = useMutation({
    mutationFn: () => harnessClient.stopResidentCeo({ repoId }),
    onSuccess: refreshAll,
  });

  const chat = useMutation({
    mutationFn: (text: string) => harnessClient.chatResidentCeo({ repoId, message: text }),
    onSuccess: () => {
      setMessage("");
      refreshAll();
    },
  });

  const approve = useMutation({
    mutationFn: (input: { readonly proposalId: string; readonly workId?: string }) => {
      setApprovingId(input.proposalId);
      return harnessClient.approveResidentCeoProposal({ repoId, ...input });
    },
    onSettled: () => setApprovingId(null),
    onSuccess: refreshAll,
  });

  const reject = useMutation({
    mutationFn: (input: { readonly proposalId: string; readonly reason: string }) => {
      setRejectingId(input.proposalId);
      return harnessClient.rejectResidentCeoProposal({ repoId, ...input });
    },
    onSettled: () => setRejectingId(null),
    onSuccess: refreshAll,
  });

  const pageError =
    profileQuery.error ??
    historyQuery.error ??
    proposalsQuery.error ??
    instanceQuery.error ??
    start.error ??
    stop.error ??
    chat.error ??
    approve.error ??
    reject.error;

  const canSend = isRunning && !chat.isPending && message.trim().length > 0;

  return (
    <section className="flex h-full min-h-0 w-full flex-col" data-testid="resident-ceo-view">
      <PageHeader
        title={t("residentCeo.title")}
        note={t("residentCeo.note")}
        actions={
          <>
            {isRunning ? (
              <Button size="sm" loading={stop.isPending} testId="resident-ceo-stop" onClick={() => stop.mutate()}>
                {t("residentCeo.stop")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                disabled={!profile}
                loading={start.isPending}
                testId="resident-ceo-start"
                onClick={() => start.mutate()}
              >
                {t("residentCeo.start")}
              </Button>
            )}
            <Button size="sm" variant="ghost" testId="resident-ceo-refresh" onClick={refreshAll}>
              {t("residentCeo.refresh")}
            </Button>
            <Button
              size="sm"
              variant={profile ? "plain" : "primary"}
              testId="resident-ceo-open-config"
              onClick={() => {
                setConfigSavedNotice(false);
                setSettingsOpen(true);
              }}
            >
              {t("residentCeo.openConfig")}
            </Button>
          </>
        }
      />

      <ResidentCeoStatusBar profile={profile} pendingProposalCount={pendingProposalCount} />

      {pageError ? (
        <div className="shrink-0 px-5 pt-2">
          <ActionError>{pageError.message}</ActionError>
        </div>
      ) : null}

      <ResidentCeoProposalsPanel
        proposals={proposals}
        defaultWorkId={profile?.defaultWorkId ?? null}
        approvingId={approvingId}
        rejectingId={rejectingId}
        onApprove={(input) => approve.mutate(input)}
        onReject={(input) => reject.mutate(input)}
        onNavigateEntity={onNavigateEntity}
      />

      <ResidentCeoTimeline entries={history} configured={profile !== null} onNavigateEntity={onNavigateEntity} />

      <form
        data-testid="resident-ceo-composer"
        className="shrink-0 border-t border-border bg-surface/80 px-5 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = message.trim();
          if (!trimmed || !isRunning || chat.isPending) return;
          chat.mutate(trimmed);
        }}
      >
        {profile && !isRunning ? <p className="mb-2 ui-micro text-text-faint">{t("residentCeo.stoppedHint")}</p> : null}
        <div className="flex items-center gap-2">
          <input
            className="min-w-0 flex-1 rounded-sm border border-border bg-surface px-3 py-1.5 ui-body text-text outline-none transition-colors hover:border-border-strong focus-visible:border-accent focus-visible:ring-2 focus-visible:ring-accent/20 disabled:opacity-50"
            value={message}
            disabled={!isRunning || chat.isPending}
            onChange={(event) => setMessage(event.target.value)}
            placeholder={t("residentCeo.messagePlaceholder")}
            aria-label={t("residentCeo.sendMessage")}
          />
          <Button
            type="submit"
            variant="primary"
            loading={chat.isPending}
            disabled={!canSend}
            testId="resident-ceo-send"
          >
            {chat.isPending ? t("residentCeo.sending") : t("residentCeo.send")}
          </Button>
        </div>
      </form>

      <ResidentCeoConfigDrawer
        open={settingsOpen}
        repoId={repoId}
        profile={profile}
        instances={instances}
        agentIds={agentIds}
        decisionProviders={decisionProviders}
        saving={configure.isPending}
        savedNotice={configSavedNotice}
        error={configure.error}
        onClose={() => setSettingsOpen(false)}
        onSave={(input) => configure.mutate(input)}
      />
    </section>
  );
}
