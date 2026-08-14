import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TerminalSessionRow } from "../../../../daemon/src/gui-s3-control.ts";
import { closeTerminalTab, reconcileTerminalGeneration, reduceTerminalStream, requestTerminalTermination, type TerminalTab } from "../terminal-model.ts";
import { terminalClient, terminalQueryKeys, type TerminalAttachInitial, type TerminalSpawnInput } from "../terminal-client.ts";

export interface TerminalDockHandle { readonly detachAll: () => Promise<void> }
interface Props { readonly repoId: string; readonly daemonGeneration: number | null; readonly tasks: readonly { readonly taskId: string; readonly title: string }[]; readonly open: boolean; readonly onToggle: () => void }

export const TerminalDock = forwardRef<TerminalDockHandle, Props>(function TerminalDock({ repoId, daemonGeneration, tasks, open, onToggle }, ref) {
  const queryClient = useQueryClient(), [tabs, setTabs] = useState<readonly TerminalTab[]>([]), tabsRef = useRef(tabs), stops = useRef(new Map<string, () => void>()), clientSeq = useRef(new Map<string, number>());
  const [activeId, setActiveId] = useState<string | null>(null), [error, setError] = useState<string | null>(null), [input, setInput] = useState(""), [confirmId, setConfirmId] = useState<string | null>(null);
  const [spawn, setSpawn] = useState({ name: "Terminal", cwdScope: "repo-root" as "repo-root" | "repo-relative", path: "", shellProfileId: "default", taskId: "" });
  const sessions = useQuery({ queryKey: terminalQueryKeys.sessions(repoId), queryFn: () => terminalClient.list(repoId), enabled: open && repoId !== "unselected", staleTime: 1_000 });
  tabsRef.current = tabs;
  const generation = daemonGeneration ?? sessions.data?.daemonGeneration;

  const detachAll = async (): Promise<void> => {
    const current = [...tabsRef.current];
    await Promise.all(current.map(async (tab) => { try { await closeTerminalTab(repoId, tab, { stopStream: stops.current.get(tab.sessionId) ?? (() => undefined), detach: terminalClient.detach }); } catch (cause) { consumeKnownError(cause); /* daemon restart can invalidate an attachment */ } }));
    stops.current.clear(); setTabs([]); setActiveId(null);
  };
  useImperativeHandle(ref, () => ({ detachAll }), [repoId]);
  useEffect(() => () => { for (const stop of stops.current.values()) stop(); stops.current.clear(); }, []);
  useEffect(() => { if (generation !== null && generation !== undefined) setTabs((current) => reconcileTerminalGeneration(current, generation)); }, [generation]);

  const attach = (row: Pick<TerminalSessionRow, "sessionId" | "name" | "status" | "outputSeq">, afterSeq = 0) => {
    stops.current.get(row.sessionId)?.();
    setTabs((current) => current.some((tab) => tab.sessionId === row.sessionId) ? current : [...current, { sessionId: row.sessionId, name: row.name, state: row.status, daemonGeneration: generation ?? 0, attachmentId: null, lastSeq: afterSeq, output: "", notice: null }]);
    setActiveId(row.sessionId); setError(null);
    try {
      const stop = terminalClient.attach(repoId, row.sessionId, afterSeq, (value) => setTabs((current) => current.map((tab) => tab.sessionId !== row.sessionId ? tab : isInitial(value)
        ? { ...tab, daemonGeneration: value.daemonGeneration, attachmentId: value.attachmentId, notice: value.status === "gap" ? "Bounded replay could not cover the requested sequence; transcript continuity is unknown." : tab.notice }
        : reduceTerminalStream(tab, value))));
      stops.current.set(row.sessionId, stop);
    } catch (cause) { consumeKnownError(cause); setError(message(cause)); }
  };
  const create = async (event: FormEvent) => {
    event.preventDefault(); setError(null);
    const cwd: TerminalSpawnInput["cwd"] = spawn.cwdScope === "repo-root" ? { scope: "repo-root" } : { scope: "repo-relative", path: spawn.path };
    try {
      const receipt = await terminalClient.spawn(repoId, { idempotencyKey: `terminal-gui-${crypto.randomUUID()}`, name: spawn.name || undefined, cwd, shellProfileId: spawn.shellProfileId || undefined, taskId: spawn.taskId || undefined });
      if (receipt.outcome !== "applied" || !receipt.sessionId) throw new Error(typeof receipt.error?.hint === "string" ? receipt.error.hint : `Terminal spawn rejected · ${receipt.operationId}`);
      await queryClient.invalidateQueries({ queryKey: terminalQueryKeys.sessions(repoId) });
      attach({ sessionId: receipt.sessionId, name: spawn.name || "Terminal", status: "running", outputSeq: 0 });
    } catch (cause) { consumeKnownError(cause); setError(message(cause)); }
  };
  const close = async (tab: TerminalTab) => {
    try { await closeTerminalTab(repoId, tab, { stopStream: stops.current.get(tab.sessionId) ?? (() => undefined), detach: terminalClient.detach }); }
    catch (cause) { consumeKnownError(cause); setError(message(cause)); }
    stops.current.delete(tab.sessionId); setTabs((current) => current.filter((item) => item.sessionId !== tab.sessionId)); setActiveId((current) => current === tab.sessionId ? null : current);
  };
  const send = async (event: FormEvent) => {
    event.preventDefault(); const tab = tabs.find((candidate) => candidate.sessionId === activeId); if (!tab || !input || tab.state !== "running") return;
    const next = (clientSeq.current.get(tab.sessionId) ?? 0) + 1;
    try { clientSeq.current.set(tab.sessionId, await terminalClient.input(repoId, tab.sessionId, next, input)); setInput(""); } catch (cause) { consumeKnownError(cause); setError(message(cause)); }
  };
  const terminate = async (tab: TerminalTab) => {
    if (confirmId !== tab.sessionId) { setConfirmId(tab.sessionId); return; }
    try { await requestTerminalTermination(repoId, tab, true, { terminate: terminalClient.terminate }); setTabs((current) => current.map((item) => item.sessionId === tab.sessionId ? { ...item, state: "exited", notice: "Termination confirmed; process exit requested." } : item)); setConfirmId(null); }
    catch (cause) { consumeKnownError(cause); setError(message(cause)); }
  };
  const active = tabs.find((tab) => tab.sessionId === activeId) ?? null;

  if (!open) return <button onClick={onToggle} className="fixed right-4 bottom-3 z-30 rounded-md border border-border-strong bg-surface-raised px-3 py-1.5 font-mono text-[12px] text-text shadow-xl" title="Ctrl+`">Terminal · Ctrl+`</button>;
  return <section aria-label="Terminal dock" className="fixed right-0 bottom-0 left-0 z-30 flex h-[22rem] flex-col border-t border-border-strong bg-surface shadow-2xl md:left-56">
    <header className="flex items-center gap-2 border-b border-border px-3 py-1.5">
      <strong className="text-[13px]">Local direct PTY</strong><span className="font-mono text-[11px] text-text-faint">repo {repoId} · generation {generation ?? "unknown / 未投影"}</span>
      <button onClick={onToggle} className="ml-auto rounded px-2 py-1 text-[12px] text-text-muted hover:bg-surface-raised">收起 · Ctrl+`</button>
    </header>
    <form onSubmit={create} className="flex flex-wrap items-end gap-2 border-b border-border px-3 py-2">
      <Field label="name"><input value={spawn.name} onChange={(event) => setSpawn({ ...spawn, name: event.target.value })} className="control w-28" /></Field>
      <Field label="cwd"><select value={spawn.cwdScope} onChange={(event) => setSpawn({ ...spawn, cwdScope: event.target.value as typeof spawn.cwdScope })} className="control"><option value="repo-root">repo-root</option><option value="repo-relative">repo-relative</option></select></Field>
      {spawn.cwdScope === "repo-relative" && <Field label="path"><input required value={spawn.path} onChange={(event) => setSpawn({ ...spawn, path: event.target.value })} className="control w-36" /></Field>}
      <Field label="shell"><select value={spawn.shellProfileId} onChange={(event) => setSpawn({ ...spawn, shellProfileId: event.target.value })} className="control"><option value="default">default</option><option value="zsh">zsh</option><option value="bash">bash</option><option value="sh">sh</option><option value="fish">fish</option></select></Field>
      <Field label="task"><select value={spawn.taskId} onChange={(event) => setSpawn({ ...spawn, taskId: event.target.value })} className="control max-w-44"><option value="">unbound</option>{tasks.map((task) => <option key={task.taskId} value={task.taskId}>{task.taskId} · {task.title}</option>)}</select></Field>
      <button className="rounded border border-accent/60 bg-accent/10 px-3 py-1 text-[12px] text-text">New session</button>
      <select aria-label="Attach existing terminal" defaultValue="" onChange={(event) => { const row = sessions.data?.sessions.find((item) => item.sessionId === event.target.value); if (row) attach(row, 0); event.target.value = ""; }} className="control ml-auto"><option value="">Attach session…</option>{sessions.data?.sessions.map((row) => <option key={row.sessionId} value={row.sessionId}>{row.name} · {row.status}</option>)}</select>
    </form>
    <div className="flex min-h-0 flex-1">
      <aside className="w-44 shrink-0 overflow-y-auto border-r border-border p-1.5">{tabs.length === 0 ? <p className="p-2 text-[12px] text-text-faint">No attached tabs.</p> : tabs.map((tab) => <button key={tab.sessionId} onClick={() => setActiveId(tab.sessionId)} className={`mb-1 block w-full rounded px-2 py-1.5 text-left ${activeId === tab.sessionId ? "bg-surface-raised text-text" : "text-text-muted"}`}><span className="block truncate text-[12px] font-medium">{tab.name}</span><span className="font-mono text-[10px]">{tab.state} · seq {tab.lastSeq}</span></button>)}</aside>
      <div className="flex min-w-0 flex-1 flex-col">{active ? <>
        <div className="flex items-center gap-2 border-b border-border px-2 py-1 text-[11px]"><span className="font-mono text-text-faint">{active.sessionId}</span><button onClick={() => { void terminalClient.resize(repoId, active.sessionId, 120, 32).catch((cause) => setError(message(cause))); }} className="ml-auto rounded px-2 py-1 text-text-muted hover:bg-surface-raised">resize 120×32</button><button onClick={() => { void close(active); }} className="rounded px-2 py-1 text-text-muted hover:bg-surface-raised" title="Close detaches; it does not terminate.">Close / detach</button><button onClick={() => { void terminate(active); }} className="rounded px-2 py-1 text-status-blocked hover:bg-surface-raised">{confirmId === active.sessionId ? "Confirm terminate" : "Terminate…"}</button></div>
        {active.notice && <p role="status" className="border-b border-status-blocked/30 bg-status-blocked/10 px-2 py-1 text-[11px] text-status-blocked">{active.notice}</p>}
        <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-[12px] leading-relaxed text-text">{active.output || "Attached. Waiting for output…"}</pre>
        <form onSubmit={send} className="flex gap-2 border-t border-border p-2"><input aria-label="Terminal input" disabled={active.state !== "running"} value={input} onChange={(event) => setInput(event.target.value)} className="control min-w-0 flex-1 font-mono" placeholder={active.state === "running" ? "Send UTF-8 input" : "Session is read-only"} /><button disabled={active.state !== "running" || !input} className="rounded border border-border-strong px-3 py-1 text-[12px] disabled:opacity-50">Send</button></form>
      </> : <div className="grid h-full place-items-center text-[12px] text-text-faint">Start or attach a daemon-hosted local terminal. Sessions are not durable across daemon restart.</div>}</div>
    </div>
    {error && <p role="alert" className="border-t border-status-blocked/30 px-3 py-1 text-[11px] text-status-blocked">{error}</p>}
  </section>;
});

function Field({ label, children }: { readonly label: string; readonly children: React.ReactNode }) { return <label className="grid gap-0.5 font-mono text-[10px] uppercase tracking-wide text-text-faint">{label}{children}</label>; }
function isInitial(value: TerminalAttachInitial | import("../terminal-model.ts").TerminalStreamFrame): value is TerminalAttachInitial { return value.schema === "terminal-attach/v1"; }
function message(value: unknown): string { return value instanceof Error ? value.message : String(value); }
function consumeKnownError(value: unknown): void { void value; }
