/**
 * The single production reader for the harness.yaml `settings:` block.
 * Preset (defaultVertical, defaultPreset, locale, scaffolds.*) and daemon
 * (tasks.wipLimit) both read authored settings through these helpers; a new
 * parser for this block must not appear beside them.
 */

// Two things this expression is deliberate about, both learned from reading it wrong once:
// a trailing `# comment` is dropped rather than voiding the whole line, because annotating a
// knob like tasks.wipLimit is the natural thing to do and a reader that fell back to the
// default on `wipLimit: 50  # bigger team` would report the default with no way to tell the
// authored value was discarded; and the run after the colon is horizontal whitespace only,
// because `\s` crosses newlines — `locale:` with no value would otherwise capture the *next*
// line and report `defaultPreset: standard-task` as the locale.
const horizontal = "[^\\S\\r\\n]*";
// The value must open with a non-blank, non-`#` character, so `wipLimit: # unset` reads as
// absent rather than as a one-space string that every caller would then have to re-trim.
const scalar = (indent: string, key: string) => new RegExp(`^${indent}${key}:${horizontal}([^#\\s][^#\\r\\n]*?)${horizontal}(?:#[^\\r\\n]*)?$`, "mu");

/** Reads a scalar directly under `settings:`, for example `defaultVertical`. */
export function setting(body: string, key: string): string | undefined {
  return scalar("  ", key).exec(body)?.[1];
}

/** Reads a scalar nested under a named settings block, for example `settings.scaffolds.task` or `settings.tasks.wipLimit`. */
export function settingBlockValue(body: string, block: string, key: string): string | undefined {
  const section = new RegExp(`^  ${block}:[^\\S\\r\\n]*(?:\\r?\\n)((?:    [^\\r\\n]*(?:\\r?\\n|$))*)`, "mu").exec(body)?.[1] ?? "";
  return scalar("    ", key).exec(section)?.[1];
}
