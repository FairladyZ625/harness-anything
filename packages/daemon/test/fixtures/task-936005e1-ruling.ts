// harness-test-tier: fast
import { readFileSync } from "node:fs";

/**
 * The ruling fixture derived from task_936005e1's **recorded** dispatch stream
 * (`.harness/runtime/dispatches/archive/dispatch_25716c64031a31cc45f5e1d1.jsonl`, ten records copied
 * byte-for-byte into `runtime-ruling-stream.jsonl`, except that absolute personal paths were replaced
 * with `<repo>` / `<home>` placeholders to pass the private-boundary gate — every field these tests
 * read is untouched).
 *
 * What the stream measures: the provider rejected the question tool (`unknown field question,
 * expected title or options`), so the worker asked in a plain agent message and the run settled
 * `gate_red`/`failed` at exit 2. The question and both options below are the strings the worker
 * actually wrote — nothing here is invented prose. The frontmatter is the artifact shape the mission
 * asks for, filled with that recorded wording.
 */
export interface RecordedRuling {
  readonly dispatchId: string;
  readonly taskId: string;
  readonly executionId: string;
  readonly runtimeSessionId: string;
  readonly instanceId: string;
  readonly kindId: string;
  readonly exitCode: number;
  readonly question: string;
  readonly options: readonly string[];
  /** The artifact body a compliant worker would write for this ask. */
  readonly body: string;
  /** The same ask rendered as the single provider message that recorded it. */
  readonly message: string;
}

const recorded = readFileSync(new URL("./runtime-ruling-stream.jsonl", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line) as Record<string, unknown>);

const dispatch = recorded.find((record) => record.kind === "dispatch")!,
  exit = recorded.find((record) => record.kind === "process_exit")!,
  // The ask itself, not the worker's earlier narration: the recorded message that opens with the
  // question and lists the two options beneath it.
  ask = recorded.find((record) => {
    const item = (record.event as { readonly item?: { readonly type?: string; readonly text?: string } } | undefined)
      ?.item;
    return (
      record.kind === "provider_event" &&
      item?.type === "agent_message" &&
      item.text?.startsWith("low 档含 GUI") === true
    );
  })!,
  message = (ask.event as { readonly item: { readonly text: string } }).item.text,
  [question, ...options] = message
    .split("\n")
    .map((line) => line.replace(/^-\s+/u, "").trim())
    .filter((line) => line !== "");

export const recordedRuling: RecordedRuling = {
  dispatchId: String(dispatch.dispatchId),
  taskId: String(dispatch.taskId),
  executionId: String(dispatch.executionId),
  runtimeSessionId: String(dispatch.runtimeSessionId),
  instanceId: String(dispatch.instanceId),
  kindId: String(dispatch.kindId),
  exitCode: Number(exit.exitCode),
  question: question!,
  options,
  body: `---\nruling: awaiting\nquestion: ${question}\noptions:\n${options.map((option) => `  - ${option}`).join("\n")}\n---\n\n${message}\n`,
  message,
};

/** The raw records, for assertions about the measured before-state (`gate_red`, `failed`, exit 2). */
export const recordedStream = recorded;
