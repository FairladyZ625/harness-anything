import { useState } from "react";
import type { DecisionRow } from "../model/types.ts";
import { MockBadge } from "./MockBadge.tsx";

/**
 * 原型内嵌终端的 mock 实现:模拟 `harness decision accept/reject/propose`、`harness check`
 * 等命令对本地 decision 状态的影响。真实版由主进程 PTY + coordinator 提供(超出渲染器边界),
 * 因此这里是纯前端演示,面板顶部显式挂 MOCK 徽章。
 */
export function useMockTerminal(
  decisions: DecisionRow[],
  setDecisions: React.Dispatch<React.SetStateAction<DecisionRow[]>>,
) {
  const [input, setInput] = useState("");
  const [logs, setLogs] = useState<string[]>([
    "Harness Controller daemon connection established.",
    "Session ID: human-cli-1719515000",
    "Current active project: harness-anything",
    "Run 'harness --help' to see available commands.",
    "Agent (claude-code) is listening. You can discuss decisions here.",
  ]);

  const execute = (cmd: string) => {
    if (!cmd.trim()) return;
    setLogs((prev) => [...prev, `> ${cmd}`]);
    setInput("");

    setTimeout(() => {
      const lower = cmd.toLowerCase().trim();
      if (lower.startsWith("harness decision accept")) {
        const id = cmd.split(" ")[3];
        if (id) {
          const dec = decisions.find((d) => d.decisionId.toLowerCase() === id.toLowerCase());
          if (dec) {
            setDecisions((prev) =>
              prev.map((d) =>
                d.decisionId.toLowerCase() === id.toLowerCase()
                  ? { ...d, state: "active", decidedAt: new Date().toISOString() }
                  : d,
              ),
            );
            setLogs((prev) => [
              ...prev,
              `Agent: Found decision ${dec.decisionId}.`,
              `Agent: Validating INV-4 content hash... OK.`,
              `Agent: Validating proposer ≠ arbiter... OK (proposed by agent:codex, accepted by human:ZeyuLi).`,
              `Agent: Rebuilding relation projection... Rebuild complete.`,
              `Agent: SUCCESS! Decision ${dec.decisionId} state is now ACTIVE.`,
            ]);
          } else {
            setLogs((prev) => [...prev, `Agent: Error: Decision ${id} not found.`]);
          }
        } else {
          setLogs((prev) => [...prev, `Agent: Usage: harness decision accept <decision-id>`]);
        }
      } else if (lower.startsWith("harness decision reject")) {
        const id = cmd.split(" ")[3];
        if (id) {
          const dec = decisions.find((d) => d.decisionId.toLowerCase() === id.toLowerCase());
          if (dec) {
            setDecisions((prev) =>
              prev.map((d) =>
                d.decisionId.toLowerCase() === id.toLowerCase()
                  ? { ...d, state: "rejected", decidedAt: new Date().toISOString() }
                  : d,
              ),
            );
            setLogs((prev) => [
              ...prev,
              `Agent: Decision ${dec.decisionId} has been REJECTED.`,
              `Agent: Removed from active projection. Graph rebuilt.`,
            ]);
          } else {
            setLogs((prev) => [...prev, `Agent: Error: Decision ${id} not found.`]);
          }
        }
      } else if (lower.includes("propose")) {
        setLogs((prev) => [
          ...prev,
          "Agent: I will propose a new decision for you.",
          "Agent: harness decision propose --title 'Refine layout' --riskTier low",
          "Agent: Created proposed decision DEC-105.",
        ]);
        const newDec: DecisionRow = {
          decisionId: "DEC-105",
          title: "优化列表批量操作工作区",
          state: "proposed",
          riskTier: "low",
          urgency: "low",
          vertical: "software/coding",
          preset: "architecture-decision",
          proposedBy: { kind: "agent", id: "claude" },
          proposedAt: new Date().toISOString(),
          question: "如何为大规模列表审计提效？",
          chosen: [{ id: "CH1", text: "引入复选框与顶部批量操作工具条", evidence: [] }],
          rejected: [],
          claims: [{ id: "C1", text: "提效是核心诉求" }],
          provenance: [{ runtime: "claude-code", sessionId: "88833871-9d1c-4aaa-bbbb-cccccccccc05", boundAt: new Date().toISOString() }],
          lastChangedAt: new Date().toISOString(),
        };
        setDecisions((prev) => [...prev, newDec]);
      } else if (lower === "harness --help") {
        setLogs((prev) => [
          ...prev,
          "Agent: Available CLI commands in mock terminal:",
          "  harness decision accept <id>  - Accept a proposed decision",
          "  harness decision reject <id>  - Reject a proposed decision",
          "  harness check                 - Run all validations (INV-6/INV-8)",
          "  harness status                - Print current projection status",
        ]);
      } else if (lower === "harness check") {
        setLogs((prev) => [
          ...prev,
          "Agent: Running harness check...",
          "Agent: [Check 1/3] Parsing YAML frontmatter schemas... OK",
          "Agent: [Check 2/3] Performing Dangling Pointer Scan (INV-6)... OK (0 dangling relations)",
          "Agent: [Check 3/3] Validating Fact Content Hashes (INV-8)... OK (4 facts verified)",
          "Agent: SUCCESS: All checks passed! Clean state.",
        ]);
      } else if (lower.startsWith("harness")) {
        setLogs((prev) => [
          ...prev,
          `Agent: Command '${cmd}' is recognized but not simulated. Try 'harness --help'.`,
        ]);
      } else {
        setLogs((prev) => [
          ...prev,
          `Agent: I understand you are discussing decisions. If you want to accept or reject, you can type:`,
          `  'harness decision accept <id>' or click '呼叫 Agent' on the left.`,
        ]);
      }
    }, 600);
  };

  return { input, setInput, logs, execute };
}

export function TerminalPanel({
  logs,
  input,
  setInput,
  onSubmit,
}: {
  logs: string[];
  input: string;
  setInput: (s: string) => void;
  onSubmit: () => void;
}) {
  return (
    <div className="hidden w-[380px] shrink-0 flex-col border-l border-border bg-surface-raised font-mono text-[12px] text-text-muted md:flex">
      <div className="flex items-center justify-between border-b border-border bg-surface px-3 py-2 text-[11px] font-bold text-text-faint">
        <span className="inline-flex items-center gap-1.5">
          内嵌终端 (PTY SESSION #1)
          <MockBadge label="MOCK" />
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-full bg-success animate-pulse" />
          ACTIVE · claude-code
        </span>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5 leading-relaxed selection:bg-accent/35 select-text">
        {logs.map((log, index) => {
          if (log.startsWith(">")) {
            return (
              <div key={index} className="text-accent font-semibold">
                {log}
              </div>
            );
          }
          if (log.startsWith("Agent:")) {
            return (
              <div key={index} className="text-text">
                <span className="text-success font-semibold">claude:</span> {log.slice(6)}
              </div>
            );
          }
          return <div key={index} className="text-text-faint">{log}</div>;
        })}
      </div>
      <div className="border-t border-border bg-surface p-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSubmit();
          }}
          className="flex items-center gap-1.5"
        >
          <span className="text-accent font-bold">&gt;</span>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="与 Agent 对话，或执行 harness 命令..."
            className="flex-1 bg-transparent py-0.5 outline-none font-mono text-text placeholder:text-text-faint"
          />
        </form>
      </div>
    </div>
  );
}
