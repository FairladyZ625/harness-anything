export const NOW = new Date("2026-06-12T10:05:00").getTime();

export type Verdict = "passed" | "failed";
export type QueueTab = "ready" | "failed" | "session";

export interface SessionRecord {
  seq: number;
  taskId: string;
  verdict: Verdict;
  note: string;
  at: string;
}

export const fmtHours = (h: number) => (h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`);
export const nowClock = () => new Date().toTimeString().slice(0, 8);
export const waitLabel = (since?: string): string => {
  if (!since) return "-";
  const h = (NOW - new Date(since).getTime()) / 3.6e6;
  return fmtHours(Math.max(0, h));
};
