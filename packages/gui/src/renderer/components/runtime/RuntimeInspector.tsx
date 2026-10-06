import { type ReactNode } from "react";
import type { AgentRuntimeSessionDto } from "@harness-anything/daemon/protocol";
import type { RuntimeInstanceSummary } from "@harness-anything/daemon/protocol";
import { formatTime } from "../../model/time.ts";
import { t } from "../../i18n/index.tsx";
import {
  runtimeAuthPresentation,
  runtimeAuthPresentationText,
  type RuntimeAuthProbeState,
} from "../../runtime-auth-presentation.ts";
import { CapDot, KindDot, LiveDot } from "./parts.tsx";
import { KV, KVRow } from "../primitives/Fields.tsx";
import { Empty } from "../primitives/Empty.tsx";

// W6 IA 拆分:原四类通吃的 RuntimeInspector 拆成三个页级 inspector——右栏仍是
// "同一个选中,从会话侧看过去:这东西最近在干什么",但跨页跳转(session/<id>、
// agent/<id>)改走可寻址路由;同页的互跳(agent↔squad、sibling session)保持页内选择。
// Provider 页的相关会话行取 overview 的 session DTO(liveness 投影),不为此读
// dispatch 台账——agent/task 归属在会话详情里,点行直达。
// IdentityInspector 已随 Agent·Squad 页密度改造撤销(业主 2026-10-06):右栏与详情
// 重复,相关会话段并入 AgentCard;此处只剩 ProviderInspector。

type OpenSession = (runtimeSessionId: string) => void;

/** 会话段整行渲染的按需渲染类:离屏行跳过布局与绘制。 */
const SESSION_ROW_CV = "cv-auto-2r";

// Liveness maps, not point comparisons (dec_8DCD52E98BAB268B0194B1E399): the daemon's
// liveness word decides the dot through a table lookup alone.
const LIVENESS_DOT: Record<string, "live" | "idle"> = { live: "live" };

export function ProviderInspector({
  instance,
  probeState,
  sessions,
  onOpenSession,
}: {
  readonly instance: RuntimeInstanceSummary | null;
  readonly probeState?: RuntimeAuthProbeState;
  readonly sessions: readonly AgentRuntimeSessionDto[];
  readonly onOpenSession: OpenSession;
}) {
  return (
    <aside
      data-testid="runtime-inspector"
      aria-label={t("agentRuntime.inspectorRuntime")}
      className="@max-[719px]:hidden basis-1/4 shrink-0 overflow-y-auto border-l border-border bg-surface"
    >
      <h2
        className="sticky top-0 border-b border-border bg-surface px-3 py-2 ui-micro font-bold uppercase
        tracking-[0.09em] text-text-faint"
      >
        {t("agentRuntime.inspectorRuntime")}
      </h2>
      <RuntimeFacts instance={instance} probeState={probeState} />
      <Section title={t("agentRuntime.inspectorSessions", { count: sessions.length })}>
        {sessions.length === 0 ? (
          <Empty>{t("agentRuntime.noSessions")}</Empty>
        ) : (
          sessions.map((session) => (
            <LiveSessionRow key={session.runtimeSessionId} session={session} onOpenSession={onOpenSession} />
          ))
        )}
      </Section>
    </aside>
  );
}

function Section({ title, children }: { readonly title: string; readonly children: ReactNode }) {
  return (
    <section className="border-b border-border px-3 py-2 last:border-b-0">
      <h3 className="mb-1.5 font-mono ui-micro uppercase tracking-[0.07em] text-text-faint">{title}</h3>
      {children}
    </section>
  );
}
function LiveSessionRow({
  session,
  onOpenSession,
}: {
  readonly session: AgentRuntimeSessionDto;
  readonly onOpenSession: OpenSession;
}) {
  return (
    <button
      type="button"
      onClick={() => onOpenSession(session.runtimeSessionId)}
      className={[
        "flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left hover:bg-surface-raised",
        SESSION_ROW_CV,
      ].join(" ")}
    >
      <LiveDot state={LIVENESS_DOT[session.liveness] ?? "idle"} tip={session.liveness} />
      <span className="min-w-0 flex-1">
        <span className="block truncate ui-micro">{session.instanceId}</span>
        <span className="block truncate font-mono ui-micro text-text-faint">{session.runtimeSessionId}</span>
      </span>
      <span className="shrink-0 font-mono ui-micro text-text-faint">
        {formatTime(session.activity.lastObservedAt, { style: "time" }) ?? session.activity.lastObservedAt}
      </span>
    </button>
  );
}
function RuntimeFacts({
  instance,
  probeState,
}: {
  readonly instance: RuntimeInstanceSummary | null;
  readonly probeState?: RuntimeAuthProbeState;
}) {
  if (!instance)
    return (
      <Section title={t("agentRuntime.inspectorHealth")}>
        <Empty>{t("agentRuntime.notFound")}</Empty>
      </Section>
    );
  const auth = runtimeAuthPresentation(instance, probeState),
    authText = runtimeAuthPresentationText(instance, auth);
  return (
    <Section title={t("agentRuntime.inspectorHealth")}>
      <div data-auth-status={auth.state} className="mb-2 flex items-center gap-1.5 ui-micro">
        <CapDot state={auth.cap} tip={authText} />
        <span>{authText}</span>
      </div>
      <KV>
        <KVRow name="kind">
          <span className="inline-flex items-center gap-1">
            <KindDot kind={instance.kindId} />
            {instance.kindId}
          </span>
        </KVRow>
        <KVRow name="auth">
          {instance.authMode} · {instance.authState}
        </KVRow>
        <KVRow name="enabled">{String(instance.enabled)}</KVRow>
        <KVRow name="isolation">{instance.isolationState}</KVRow>
        <KVRow name="permission">{instance.permissionMode ?? t("agentRuntime.providerDefault")}</KVRow>
      </KV>
    </Section>
  );
}
