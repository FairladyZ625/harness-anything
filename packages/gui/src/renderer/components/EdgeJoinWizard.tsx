import { useEffect, useRef, useState } from "react";
import { Globe, SpinnerGap } from "@phosphor-icons/react";
import { t } from "../i18n/index.tsx";
import type {
  EdgeJoinDeviceLogin,
  EdgeJoinJoined,
  EdgeJoinProgress,
  EdgeJoinRejection,
} from "../../api/edge-join-entry-contract.ts";
import { beginEdgeJoin, openEdgeJoinLogin, pollEdgeJoinLogin, readEdgeJoinProgress } from "../edge-join-client.ts";
import { explainEdgeJoinFailure, type EdgeJoinFailureView } from "../edge-join-errors.ts";
import { CopyContextButton } from "./CopyContextButton.tsx";
import { Modal } from "./primitives/Modal.tsx";
import { Button } from "./primitives/Button.tsx";
import { StatusTag } from "./primitives/StatusTag.tsx";

const LINK_PREFIX = "harness-edge://join/";
type Phase = "paste" | "device" | "joining" | "done" | "failed";
type ProgressRow = EdgeJoinProgress["repositories"][number];

const isRejection = (value: unknown): value is EdgeJoinRejection =>
  typeof value === "object" && value !== null && (value as { ok?: unknown }).ok === false;

const phaseTone = { workspace: "wait", register: "wait", sync: "wait", synced: "done", failed: "bad" } as const;

function phaseKey(phase: ProgressRow["phase"]) {
  return `views.edgeJoin.phase.${phase}` as const;
}

/**
 * 边缘节点加入向导(task_0499bcc75d0f0):粘贴邀请链接 → daemon 既有 edge join。未登录时第一次
 * 调用返回设备登录(显示网址与验证码、自动轮询),批准后自动重调完成逐仓库注册与首次同步,
 * 成功后自动切到第一个加入的仓库。链接只存在于本组件的内存状态,不写任何持久化。
 */
export function EdgeJoinWizard({
  open,
  initialLink,
  onClose,
  onJoined,
}: {
  readonly open: boolean;
  /** OS 协议激活(harness-edge:// 链接唤起)预填的邀请链接。 */
  readonly initialLink: string | null;
  readonly onClose: () => void;
  /** 加入成功后以成功的 repoIds(邀请顺序)回调;App 用它自动切到第一个仓库。 */
  readonly onJoined: (repoIds: readonly string[]) => void;
}) {
  const [phase, setPhase] = useState<Phase>("paste");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [device, setDevice] = useState<EdgeJoinDeviceLogin | null>(null);
  const [transportNotice, setTransportNotice] = useState(false);
  const [rows, setRows] = useState<readonly ProgressRow[]>([]);
  const [receipt, setReceipt] = useState<EdgeJoinJoined | null>(null);
  const [failure, setFailure] = useState<EdgeJoinFailureView | null>(null);
  const [failureDetail, setFailureDetail] = useState<string | null>(null);
  const runRef = useRef(0);
  const linkRef = useRef("");
  const progressTimer = useRef<number | null>(null);
  const joinedNotified = useRef(false);

  useEffect(() => {
    if (!open) {
      runRef.current += 1;
      return;
    }
    joinedNotified.current = false;
    setPhase("paste");
    setBusy(false);
    setDevice(null);
    setTransportNotice(false);
    setRows([]);
    setReceipt(null);
    setFailure(null);
    setFailureDetail(null);
    setLink(initialLink ?? "");
    linkRef.current = initialLink ?? "";
  }, [open, initialLink]);

  useEffect(
    () => () => {
      if (progressTimer.current !== null) window.clearInterval(progressTimer.current);
    },
    [],
  );

  const stopProgressPoll = () => {
    if (progressTimer.current !== null) {
      window.clearInterval(progressTimer.current);
      progressTimer.current = null;
    }
  };

  const fail = (rejection: {
    readonly code?: string;
    readonly explanation?: string;
    readonly rejectionExplanation?: string;
  }) => {
    // daemon refusals carry their hint as rejectionExplanation; a refused IPC call carries explanation.
    const detail = rejection.explanation ?? rejection.rejectionExplanation;
    stopProgressPoll();
    setFailure(explainEdgeJoinFailure({ ...rejection, ...(detail === undefined ? {} : { explanation: detail }) }));
    setFailureDetail(detail?.trim() || null);
    setPhase("failed");
  };

  const settleJoined = (joined: EdgeJoinJoined) => {
    stopProgressPoll();
    setReceipt(joined);
    setRows(joined.repositories.map((row) => ({ repoId: row.repoId, phase: row.ok ? "synced" : "failed" })));
    setPhase("done");
    if (!joinedNotified.current) {
      joinedNotified.current = true;
      const synced = joined.repositories.filter((row) => row.ok).map((row) => row.repoId);
      if (synced.length > 0) onJoined(synced);
    }
  };

  /** The daemon joins repo by repo; this read-only poll just paints each phase as it happens. */
  const startProgressPoll = (run: number) => {
    stopProgressPoll();
    progressTimer.current = window.setInterval(() => {
      if (run !== runRef.current) {
        stopProgressPoll();
        return;
      }
      void readEdgeJoinProgress()
        .then((progress) => {
          if (run === runRef.current) setRows(progress.repositories);
        })
        .catch(() => {
          // 进度读口只是显示;失败即停轮询,join 调用本身的回执仍是唯一真相。
          stopProgressPoll();
        });
    }, 1_000);
  };

  const runJoin = async (run: number, value: string) => {
    setPhase("joining");
    setBusy(true);
    setRows([]);
    startProgressPoll(run);
    // A refused IPC call is reported like a daemon refusal; the promise form keeps the failure
    // path explicit rather than a try/catch that could swallow it.
    const outcome = await beginEdgeJoin(value).catch((error: unknown) => {
      if (run === runRef.current) fail({ explanation: error instanceof Error ? error.message : String(error) });
      return null;
    });
    if (run !== runRef.current) return;
    setBusy(false);
    if (outcome === null) return;
    if (isRejection(outcome)) {
      fail(outcome);
      return;
    }
    if ("pending" in outcome) {
      // 批准后的会话没有生效时 daemon 会重新开始一次设备登录;继续等待即可。
      setDevice(outcome);
      setPhase("device");
      void waitForApproval(run, outcome);
      return;
    }
    settleJoined(outcome);
  };

  /** Keycloak 的 interval/expiresAt 驱动轮询;登录服务暂时不可达时继续等,其它错误就地收口。 */
  const waitForApproval = async (run: number, begun: EdgeJoinDeviceLogin) => {
    let interval = Math.max(1, begun.interval);
    // 终止信号来自 daemon:它按同一份 expiresAt 判过期,超时后 poll 返回 oidc_device_expired;
    // 这里不再复制一份时钟判断,GUI 与 daemon 对「过期」只有一个权威。
    while (run === runRef.current) {
      await new Promise((resolve) => window.setTimeout(resolve, interval * 1_000));
      if (run !== runRef.current) return;
      const reply = await pollEdgeJoinLogin().catch((error: unknown) =>
        error instanceof Error ? error : new Error(String(error)),
      );
      if (run !== runRef.current) return;
      if (reply instanceof Error) {
        fail({ explanation: reply.message });
        return;
      }
      if (isRejection(reply)) {
        if (reply.code === "oidc_device_transport_unavailable") {
          setTransportNotice(true);
          continue;
        }
        fail(reply);
        return;
      }
      if (reply.pending) {
        setTransportNotice(false);
        if (reply.interval !== undefined) interval = Math.max(1, reply.interval);
        continue;
      }
      setTransportNotice(false);
      await runJoin(run, linkRef.current);
      return;
    }
  };

  const submit = async () => {
    const value = link.trim();
    if (!value.startsWith(LINK_PREFIX) || value.length <= LINK_PREFIX.length) return;
    const run = ++runRef.current;
    linkRef.current = value;
    setFailure(null);
    await runJoin(run, value);
  };

  const backToPaste = () => {
    runRef.current += 1;
    stopProgressPoll();
    setDevice(null);
    setTransportNotice(false);
    setRows([]);
    setFailure(null);
    setPhase("paste");
    setBusy(false);
  };

  const trimmedLink = link.trim();
  // The bare scheme prefix has no invitation payload, so it is incomplete rather than valid.
  const invalid =
    trimmedLink !== "" && (!trimmedLink.startsWith(LINK_PREFIX) || trimmedLink.length <= LINK_PREFIX.length);
  const failureRows = receipt?.repositories.filter((row) => !row.ok) ?? [];

  return (
    <Modal
      open={open}
      title={t("views.edgeJoin.title")}
      testId="edge-join-wizard"
      onClose={onClose}
      footer={
        phase === "paste" ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              testId="edge-join-start"
              disabled={busy || invalid || link.trim() === ""}
              onClick={() => void submit()}
            >
              {busy ? t("views.edgeJoin.pastePending") : t("views.edgeJoin.pasteAction")}
            </Button>
          </div>
        ) : phase === "device" ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button testId="edge-join-cancel-login" onClick={backToPaste}>
              {t("views.edgeJoin.deviceCancel")}
            </Button>
          </div>
        ) : phase === "done" ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button testId="edge-join-done" onClick={onClose}>
              {t("views.edgeJoin.doneAction")}
            </Button>
          </div>
        ) : phase === "failed" ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button testId="edge-join-retry" onClick={backToPaste}>
              {t("views.edgeJoin.errorRetry")}
            </Button>
            <Button testId="edge-join-error-close" onClick={onClose}>
              {t("views.edgeJoin.errorClose")}
            </Button>
          </div>
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        {phase === "paste" ? (
          <>
            <p className="ui-meta text-text-muted">{t("views.edgeJoin.pasteHint")}</p>
            <input
              data-testid="edge-join-link-input"
              aria-label={t("views.edgeJoin.pasteLabel")}
              autoFocus
              spellCheck={false}
              className="w-full rounded border border-border bg-surface-raised px-2 py-1.5 font-mono ui-meta text-text"
              value={link}
              onChange={(event) => setLink(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !invalid && !busy) void submit();
              }}
            />
            {invalid ? (
              <p data-testid="edge-join-link-invalid" role="alert" className="ui-meta text-status-blocked">
                {t("views.edgeJoin.pasteInvalid")}
              </p>
            ) : null}
          </>
        ) : null}

        {phase === "device" && device !== null ? (
          <>
            <p className="ui-meta text-text-muted">{t("views.edgeJoin.deviceHint")}</p>
            <div className="flex flex-col gap-2 rounded border border-border bg-surface-raised p-3">
              <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">
                {t("views.edgeJoin.deviceUrlLabel")}
              </span>
              <span data-testid="edge-join-login-uri" className="break-all font-mono ui-meta text-text">
                {device.verificationUri}
              </span>
              <Button testId="edge-join-open-login" onClick={() => void openEdgeJoinLogin().catch(() => undefined)}>
                <Globe className="mr-1 inline size-3" />
                {t("views.edgeJoin.deviceOpenBrowser")}
              </Button>
            </div>
            <div className="flex flex-wrap items-center gap-3 rounded border border-border bg-surface-raised p-3">
              <span className="flex flex-col gap-1">
                <span className="font-mono ui-micro uppercase tracking-wide text-text-faint">
                  {t("views.edgeJoin.deviceCodeLabel")}
                </span>
                <span data-testid="edge-join-user-code" className="text-2xl font-semibold tracking-widest text-text">
                  {device.userCode}
                </span>
              </span>
              <CopyContextButton
                buildText={() => device.userCode}
                label={t("views.edgeJoin.deviceCopyCode")}
                title={t("views.edgeJoin.deviceCopyCode")}
                testId="edge-join-copy-code"
              />
              <span className="ml-auto flex items-center gap-1 ui-meta text-text-faint" role="status">
                <SpinnerGap weight="bold" className="inline size-3.5 animate-spin" aria-hidden />
                {t("views.edgeJoin.deviceWaiting")}
              </span>
            </div>
            {transportNotice ? (
              <p data-testid="edge-join-transport-notice" className="ui-meta text-status-submitted" role="status">
                {t("views.edgeJoin.deviceTransportNotice")}
              </p>
            ) : null}
          </>
        ) : null}

        {phase === "joining" ? (
          <>
            <p className="ui-meta text-text-muted">{t("views.edgeJoin.joinHint")}</p>
            <RepositoryRows rows={rows} placeholder />
          </>
        ) : null}

        {phase === "done" && receipt !== null ? (
          <>
            <p className="ui-body font-medium">{t("views.edgeJoin.doneTitle")}</p>
            {receipt.ok ? null : <p className="ui-meta text-status-blocked">{t("views.edgeJoin.donePartial")}</p>}
            <RepositoryRows rows={rows} placeholder={false} />
            {failureRows.length > 0 ? (
              <ul data-testid="edge-join-failed-repos" className="flex flex-col gap-1">
                {failureRows.map((row) => (
                  <li key={row.repoId} className="ui-micro text-text-faint">
                    <span className="font-mono">{row.repoId}</span>
                    {row.error ? ` — ${row.error}` : row.code ? ` — ${row.code}` : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        ) : null}

        {phase === "failed" && failure !== null ? (
          <>
            <p className="ui-body font-medium">{t("views.edgeJoin.errorTitle")}</p>
            <p data-testid="edge-join-error-message" role="alert" className="ui-meta text-status-blocked">
              {failure.message}
            </p>
            {failure.next !== null ? <p className="ui-meta text-text-muted">{failure.next}</p> : null}
            {failureDetail !== null && failureDetail !== failure.message ? (
              <p data-testid="edge-join-error-detail" className="break-all font-mono ui-micro text-text-faint">
                {failureDetail}
              </p>
            ) : null}
          </>
        ) : null}
      </div>
    </Modal>
  );
}

function RepositoryRows({
  rows,
  placeholder,
}: {
  readonly rows: readonly ProgressRow[];
  /** 加入刚开始、进度读口尚无行时给出占位说明,不假装有任何仓库状态。 */
  readonly placeholder: boolean;
}) {
  if (rows.length === 0)
    return placeholder ? <p className="ui-meta text-text-faint">{t("views.edgeJoin.joinStarting")}</p> : null;
  return (
    <ul data-testid="edge-join-repositories" className="flex flex-col gap-1.5">
      {rows.map((row) => (
        <li key={row.repoId} className="flex items-center gap-2 rounded border border-border px-2 py-1.5">
          <span className="min-w-0 flex-1 break-all font-mono ui-meta text-text">{row.repoId}</span>
          <StatusTag tone={phaseTone[row.phase]} label={t(phaseKey(row.phase))} />
        </li>
      ))}
    </ul>
  );
}
