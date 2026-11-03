import path from "node:path";
import { firstCliCommandIndex } from "../../cli/thin-command-help.ts";

// Flags are declared here rather than accepted loosely: the probe is a long-lived process, so a
// typo must fail at start-up instead of silently probing with a default for hours.
export interface ProbeOptions {
  readonly intervalMs: number;
  readonly timeoutMs: number;
  readonly slowMs: number;
  readonly unresponsiveMs: number;
  readonly cpuPercent: number;
  readonly cpuSustainMs: number;
  readonly rssBytes: number;
  readonly cooldownMs: number;
  readonly captureDir: string;
  readonly keptDays: number;
  readonly iterations: number | null;
  readonly durationMs: number | null;
  readonly sampleSeconds: number;
  readonly jsStackMethod: string;
  readonly json: boolean;
}

export interface SummaryOptions {
  readonly sinceMs: number;
  readonly untilMs: number;
  readonly windowLabel: string;
  readonly dayLabel: string | null;
  readonly minSilenceMs: number;
  readonly json: boolean;
}

export type ParseResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

export const probeDefaults = Object.freeze({
  intervalMs: 5_000,
  timeoutMs: 2_000,
  slowMs: 1_000,
  unresponsiveMs: 30_000,
  cpuPercent: 90,
  cpuSustainMs: 60_000,
  // The center daemon legitimately holds several GiB with many attached repositories (3.2 GiB
  // observed 2026-11-03); 8 GiB is a runaway threshold, not a footprint target.
  rssBytes: 8 * 1024 * 1024 * 1024,
  cooldownMs: 10 * 60_000,
  keptDays: 7,
  sampleSeconds: 5,
  jsStackMethod: "daemon.diagnostics.stack",
});

const probeValueFlags: readonly string[] = [
  "--interval",
  "--timeout",
  "--slow-ms",
  "--unresponsive",
  "--cpu-percent",
  "--cpu-sustain",
  "--rss-bytes",
  "--cooldown",
  "--capture-dir",
  "--kept-days",
  "--iterations",
  "--duration",
  "--sample-seconds",
  "--js-stack-method",
  "--user-root",
  "--daemon-id",
];

const summaryValueFlags: readonly string[] = ["--window", "--day", "--min-silence", "--user-root", "--daemon-id"];

const summaryWindows = Object.freeze({
  "15m": 900_000,
  "1h": 3_600_000,
  "6h": 21_600_000,
  "24h": 86_400_000,
  "7d": 604_800_000,
});

export function parseProbeArgs(argv: readonly string[], userRoot: string): ParseResult<ProbeOptions> {
  const flags = collectFlags(argv, "probe", probeValueFlags);
  if (!flags.ok) return flags;
  const at = (name: string) => flags.value.get(name);
  const interval = durationFlag(at("--interval"), "--interval", probeDefaults.intervalMs);
  if (!interval.ok) return interval;
  const timeout = durationFlag(at("--timeout"), "--timeout", probeDefaults.timeoutMs);
  if (!timeout.ok) return timeout;
  const unresponsive = durationFlag(at("--unresponsive"), "--unresponsive", probeDefaults.unresponsiveMs);
  if (!unresponsive.ok) return unresponsive;
  const sustain = durationFlag(at("--cpu-sustain"), "--cpu-sustain", probeDefaults.cpuSustainMs);
  if (!sustain.ok) return sustain;
  const cooldown = durationFlag(at("--cooldown"), "--cooldown", probeDefaults.cooldownMs);
  if (!cooldown.ok) return cooldown;
  const duration = durationFlag(at("--duration"), "--duration", null);
  if (!duration.ok) return duration;
  const slow = integerFlag(at("--slow-ms"), "--slow-ms", probeDefaults.slowMs, 0);
  if (!slow.ok) return slow;
  const cpuPercent = integerFlag(at("--cpu-percent"), "--cpu-percent", probeDefaults.cpuPercent, 1);
  if (!cpuPercent.ok) return cpuPercent;
  if (cpuPercent.value > 100)
    return { ok: false, message: "Use --cpu-percent from 1 to 100; it is a percentage of one core." };
  const rssBytes = integerFlag(at("--rss-bytes"), "--rss-bytes", probeDefaults.rssBytes, 1);
  if (!rssBytes.ok) return rssBytes;
  const keptDays = integerFlag(at("--kept-days"), "--kept-days", probeDefaults.keptDays, 1);
  if (!keptDays.ok) return keptDays;
  if (keptDays.value > 365) return { ok: false, message: "Use --kept-days from 1 to 365." };
  const iterations = integerFlag(at("--iterations"), "--iterations", null, 1);
  if (!iterations.ok) return iterations;
  const sampleSeconds = integerFlag(at("--sample-seconds"), "--sample-seconds", probeDefaults.sampleSeconds, 1);
  if (!sampleSeconds.ok) return sampleSeconds;
  if (sampleSeconds.value > 60) return { ok: false, message: "Use --sample-seconds from 1 to 60." };
  const captureDir = at("--capture-dir");
  const jsStackMethod = at("--js-stack-method") ?? probeDefaults.jsStackMethod;
  if (!/^[A-Za-z][A-Za-z0-9_.-]*$/u.test(jsStackMethod))
    return { ok: false, message: "Use a dotted RPC method name for --js-stack-method." };
  if (interval.value < 250) return { ok: false, message: "Use --interval of at least 250ms." };
  if (timeout.value > 120_000) return { ok: false, message: "Use --timeout of at most 120s." };
  if (duration.value !== null && duration.value < interval.value)
    return { ok: false, message: "Use --duration of at least one --interval, or omit it to run until signalled." };
  return {
    ok: true,
    value: {
      intervalMs: interval.value,
      timeoutMs: timeout.value,
      slowMs: slow.value,
      unresponsiveMs: unresponsive.value,
      cpuPercent: cpuPercent.value,
      cpuSustainMs: sustain.value,
      rssBytes: rssBytes.value,
      cooldownMs: cooldown.value,
      captureDir: path.resolve(captureDir ?? path.join(userRoot, "logs", "probe-captures")),
      keptDays: keptDays.value,
      iterations: iterations.value,
      durationMs: duration.value,
      sampleSeconds: sampleSeconds.value,
      jsStackMethod,
      json: flags.value.get("--json") === "true",
    },
  };
}

export function parseSummaryArgs(argv: readonly string[], nowMs = Date.now()): ParseResult<SummaryOptions> {
  const flags = collectFlags(argv, "summary", summaryValueFlags);
  if (!flags.ok) return flags;
  const at = (name: string) => flags.value.get(name);
  const window = at("--window") ?? "24h";
  if (!Object.hasOwn(summaryWindows, window)) return { ok: false, message: "Use --window 15m|1h|6h|24h|7d." };
  const silence = durationFlag(at("--min-silence"), "--min-silence", 300_000);
  if (!silence.ok) return silence;
  if (silence.value < 60_000) return { ok: false, message: "Use --min-silence of at least 60s." };
  const day = at("--day");
  if (day !== undefined) {
    const parsed = parseUtcDay(day);
    if (parsed === null) return { ok: false, message: "Use --day YYYYMMDD or YYYY-MM-DD (UTC)." };
    return {
      ok: true,
      value: {
        sinceMs: parsed,
        untilMs: parsed + 86_400_000,
        windowLabel: `day ${new Date(parsed).toISOString().slice(0, 10)} UTC`,
        dayLabel: new Date(parsed).toISOString().slice(0, 10).replaceAll("-", ""),
        minSilenceMs: silence.value,
        json: flags.value.get("--json") === "true",
      },
    };
  }
  const span = summaryWindows[window as keyof typeof summaryWindows];
  return {
    ok: true,
    value: {
      sinceMs: nowMs - span,
      untilMs: nowMs,
      windowLabel: window,
      dayLabel: null,
      minSilenceMs: silence.value,
      json: flags.value.get("--json") === "true",
    },
  };
}

function collectFlags(
  argv: readonly string[],
  word: "probe" | "summary",
  valueFlags: readonly string[],
): ParseResult<Map<string, string>> {
  const at = firstCliCommandIndex(argv),
    skip = word === "summary" ? [at, at + 1, at + 2] : [at, at + 1];
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    if (skip.includes(index)) continue;
    const token = argv[index]!;
    if (token === "--json") {
      values.set("--json", "true");
      continue;
    }
    if (!valueFlags.includes(token))
      return {
        ok: false,
        message: token.startsWith("-")
          ? `Unknown option ${token}; use ha daemon probe --help.`
          : `Unexpected argument ${token}; use ha daemon probe --help.`,
      };
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, message: `Add a value after ${token}.` };
    values.set(token, value);
    index += 1;
  }
  return { ok: true, value: values };
}

function durationFlag(raw: string | undefined, flag: string, fallback: number): ParseResult<number>;
function durationFlag(raw: string | undefined, flag: string, fallback: null): ParseResult<number | null>;
function durationFlag(raw: string | undefined, flag: string, fallback: number | null): ParseResult<number | null> {
  if (raw === undefined) return { ok: true, value: fallback };
  const parsed = parseDurationMs(raw);
  if (parsed === null) return { ok: false, message: `Use ${flag} like 5s, 30s, 10m, or 500ms.` };
  return { ok: true, value: parsed };
}

function integerFlag(raw: string | undefined, flag: string, fallback: number, minimum: number): ParseResult<number>;
function integerFlag(
  raw: string | undefined,
  flag: string,
  fallback: null,
  minimum: number,
): ParseResult<number | null>;
function integerFlag(
  raw: string | undefined,
  flag: string,
  fallback: number | null,
  minimum: number,
): ParseResult<number | null> {
  if (raw === undefined) return { ok: true, value: fallback };
  if (!/^[0-9]+$/u.test(raw)) return { ok: false, message: `Use ${flag} as a whole number.` };
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum)
    return { ok: false, message: `Use ${flag} of at least ${minimum}.` };
  return { ok: true, value };
}

export function parseDurationMs(raw: string): number | null {
  const match = /^([1-9][0-9]*)(ms|s|m|h)?$/u.exec(raw);
  if (match === null) return null;
  const amount = Number(match[1]),
    unit = match[2] ?? "ms",
    factor = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const value = amount * factor;
  return Number.isSafeInteger(value) ? value : null;
}

function parseUtcDay(raw: string): number | null {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})$/u.exec(raw);
  if (match === null) return null;
  const value = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00.000Z`);
  if (!Number.isFinite(value)) return null;
  return new Date(value).toISOString().startsWith(`${match[1]}-${match[2]}-${match[3]}`) ? value : null;
}
