/**
 * Unified first-usable observability for PLT-Performance/P3.
 *
 * Markers represent real interactive content — never an empty shell or a
 * vanished spinner. Consumers (E2E / unit tests) read the global store and
 * DOM data attributes; production code only marks, never gates UX on them.
 */

export type PerfMarkerName =
  | "navigation-start"
  | "data-ready"
  | "first-meaningful-rows"
  | "first-usable"
  | "background-preload-complete"
  | "fully-settled";

export interface PerfMarker {
  readonly name: PerfMarkerName;
  readonly view: string;
  readonly at: number;
  readonly detail?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PerfTrace {
  readonly view: string;
  readonly startedAt: number;
  readonly markers: ReadonlyArray<PerfMarker>;
}

export const FIRST_USABLE_ATTR = "data-first-usable";
export const FIRST_USABLE_VIEW_ATTR = "data-first-usable-view";
export const PERF_TRACE_GLOBAL = "__harnessPerfTrace";

const traces = new Map<string, PerfMarker[]>();
const startedAt = new Map<string, number>();
const listeners = new Set<(marker: PerfMarker) => void>();

export function startPerfNavigation(view: string, now: number = performance.now()): void {
  startedAt.set(view, now);
  traces.set(view, []);
  markPerf(view, "navigation-start", { epochMs: Date.now() }, now);
}

export function markPerf(
  view: string,
  name: PerfMarkerName,
  detail?: PerfMarker["detail"],
  now: number = performance.now(),
): PerfMarker {
  if (!traces.has(view)) {
    startedAt.set(view, now);
    traces.set(view, []);
  }
  const marker: PerfMarker = { name, view, at: now, detail };
  const list = traces.get(view)!;
  // Keep the first occurrence of each marker name (first-usable is sticky).
  if (!list.some((entry) => entry.name === name)) {
    list.push(marker);
    for (const listener of listeners) listener(marker);
    publishGlobal(view);
    if (typeof performance !== "undefined" && typeof performance.mark === "function") {
      try {
        performance.mark(`ha:${view}:${name}`);
      } catch {
        // performance.mark may throw with reserved names in some hosts; ignore.
      }
    }
  }
  return marker;
}

export function getPerfTrace(view: string): PerfTrace | null {
  const markers = traces.get(view);
  if (!markers) return null;
  return {
    view,
    startedAt: startedAt.get(view) ?? markers[0]?.at ?? 0,
    markers: [...markers],
  };
}

export function getPerfMarker(view: string, name: PerfMarkerName): PerfMarker | null {
  const markers = traces.get(view);
  if (!markers) return null;
  return markers.find((marker) => marker.name === name) ?? null;
}

export function elapsedSinceNavigation(view: string, name: PerfMarkerName): number | null {
  const start = startedAt.get(view);
  const marker = getPerfMarker(view, name);
  if (start === undefined || !marker) return null;
  return marker.at - start;
}

export function onPerfMarker(listener: (marker: PerfMarker) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetPerfTraces(): void {
  traces.clear();
  startedAt.clear();
  if (typeof globalThis !== "undefined") {
    const host = globalThis as Record<string, unknown>;
    delete host[PERF_TRACE_GLOBAL];
  }
}

function publishGlobal(view: string): void {
  if (typeof globalThis === "undefined") return;
  const host = globalThis as Record<string, unknown>;
  const snapshot: Record<string, PerfTrace> = {};
  for (const key of traces.keys()) {
    const trace = getPerfTrace(key);
    if (trace) snapshot[key] = trace;
  }
  host[PERF_TRACE_GLOBAL] = snapshot;
  host.__harnessFirstUsableView = getPerfMarker(view, "first-usable") ? view : host.__harnessFirstUsableView;
}

/** DOM ceiling used by bounded first-screen renders and E2E assertions. */
export const FIRST_SCREEN_DOM_CEILING = 10_000;

/** Max default-expanded execution outputs on first paint. */
export const DEFAULT_EXPANDED_OUTPUTS = 0;

/** Max concurrent background prefetches. */
export const BACKGROUND_PREFETCH_CONCURRENCY = 1;
