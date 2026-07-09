import { cliError, CliErrorCode } from "../error-codes.ts";
import { readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, DecisionChoiceInput, DecisionClaimInput, DecisionRejectedInput } from "../types.ts";

export function parseChoiceInputs(args: ReadonlyArray<string>):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionChoiceInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const values = readRepeatedRawOption(args, "--chosen");
  if (values.length === 0) return { ok: false, error: cliError(CliErrorCode.MissingDecisionChoice, "Use decision propose --chosen <text>.") };
  const choices: DecisionChoiceInput[] = [];
  for (const value of values) {
    const parsed = parseChoiceInput(value);
    if (!parsed.ok) return parsed;
    choices.push(parsed.value);
  }
  return { ok: true, value: choices };
}

function parseChoiceInput(raw: string | undefined):
  | { readonly ok: true; readonly value: DecisionChoiceInput }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  if (!raw || raw.startsWith("--")) {
    return { ok: false, error: cliError(CliErrorCode.MissingDecisionChoice, "Use decision propose --chosen <text> or --chosen <json-object>.") };
  }
  if (!raw.trim().startsWith("{")) return { ok: true, value: { text: raw } };
  try {
    const parsed = parseJsonObject(raw, "chosen JSON must be an object");
    const text = typeof parsed.text === "string" ? parsed.text : "";
    if (!text.trim()) throw new Error("chosen JSON requires text");
    return {
      ok: true,
      value: {
        ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
        text,
        ...(typeof parsed.load_bearing === "boolean" ? { load_bearing: parsed.load_bearing } : {})
      }
    };
  } catch (error) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, `Invalid --chosen JSON: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

export function parseRejectedInputs(args: ReadonlyArray<string>, fallbackWhyNot: string | undefined):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionRejectedInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const values = readRepeatedRawOption(args, "--rejected");
  if (values.length === 0) {
    return { ok: false, error: cliError(CliErrorCode.MissingDecisionRejected, "Use decision propose --rejected <text> --why-not <text>.") };
  }
  const rejected: DecisionRejectedInput[] = [];
  for (const value of values) {
    const parsed = parseRejectedInput(value, fallbackWhyNot);
    if (!parsed.ok) return parsed;
    rejected.push(parsed.value);
  }
  return { ok: true, value: rejected };
}

function parseRejectedInput(raw: string | undefined, fallbackWhyNot: string | undefined):
  | { readonly ok: true; readonly value: DecisionRejectedInput }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  if (!raw || raw.startsWith("--")) {
    return { ok: false, error: cliError(CliErrorCode.MissingDecisionRejected, "Use decision propose --rejected <text> --why-not <text>.") };
  }
  if (!raw.trim().startsWith("{")) {
    if (!fallbackWhyNot) return { ok: false, error: cliError(CliErrorCode.MissingDecisionRejected, "Use decision propose --rejected <text> --why-not <text>.") };
    return { ok: true, value: { text: raw, why_not: fallbackWhyNot } };
  }
  try {
    const parsed = parseJsonObject(raw, "rejected JSON must be an object");
    const text = typeof parsed.text === "string" ? parsed.text : "";
    const whyNot = typeof parsed.why_not === "string"
      ? parsed.why_not
      : typeof parsed.whyNot === "string"
        ? parsed.whyNot
        : fallbackWhyNot ?? "";
    if (!text.trim()) throw new Error("rejected JSON requires text");
    if (!whyNot.trim()) throw new Error("rejected JSON requires why_not");
    return {
      ok: true,
      value: {
        ...(typeof parsed.id === "string" && parsed.id.trim() ? { id: parsed.id } : {}),
        text,
        why_not: whyNot
      }
    };
  } catch (error) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, `Invalid --rejected JSON: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

export function parseClaimInputs(args: ReadonlyArray<string>, defaultLoadBearing: boolean):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionClaimInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const claims: DecisionClaimInput[] = [];
  for (const raw of readRepeatedRawOption(args, "--claim")) {
    const parsed = parseClaimInput(raw, defaultLoadBearing);
    if (!parsed.ok) return parsed;
    claims.push(parsed.value);
  }
  return { ok: true, value: claims };
}

function parseClaimInput(raw: string | undefined, defaultLoadBearing: boolean):
  | { readonly ok: true; readonly value: DecisionClaimInput }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  if (!raw || raw.startsWith("--")) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, "Use --claim <text> or --claim <json-object>.") };
  }
  if (!raw.trim().startsWith("{")) return { ok: true, value: { text: raw, ...(defaultLoadBearing ? {} : { load_bearing: false }) } };
  try {
    const object = parseJsonObject(raw, "claim JSON must be an object");
    if (typeof object.text !== "string" || object.text.trim().length === 0) throw new Error("claim JSON requires text");
    return {
      ok: true,
      value: {
        ...(typeof object.id === "string" && object.id.trim() ? { id: object.id } : {}),
        text: object.text,
        ...(typeof object.load_bearing === "boolean" ? { load_bearing: object.load_bearing } : defaultLoadBearing ? {} : { load_bearing: false })
      }
    };
  } catch (error) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, `Invalid --claim JSON: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

function parseJsonObject(raw: string, objectError: string): Record<string, unknown> {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(objectError);
  return parsed as Record<string, unknown>;
}
