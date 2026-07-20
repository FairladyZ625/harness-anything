import { cliError, CliErrorCode } from "../error-codes.ts";
import { readRepeatedRawOption } from "../parse-options.ts";
import type { CliResult, DecisionChoiceInput, DecisionClaimInput, DecisionRejectedInput } from "../types.ts";
import { decisionClaimFulfillments } from "@harness-anything/kernel";

export function parseChoiceInputs(args: ReadonlyArray<string>, input?: unknown):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionChoiceInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const flagValues = readRepeatedRawOption(args, "--chosen");
  const values: ReadonlyArray<unknown> = flagValues.length > 0 ? flagValues : inputValues(input);
  if (values.length === 0) return { ok: false, error: cliError(CliErrorCode.MissingDecisionChoice, "Use decision propose --chosen <text>.") };
  const choices: DecisionChoiceInput[] = [];
  for (const value of values) {
    const parsed = parseChoiceInput(value);
    if (!parsed.ok) return parsed;
    choices.push(parsed.value);
  }
  return { ok: true, value: choices };
}

function parseChoiceInput(raw: unknown):
  | { readonly ok: true; readonly value: DecisionChoiceInput }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  if (raw === undefined || raw === null || (typeof raw === "string" && (!raw || raw.startsWith("--")))) {
    return { ok: false, error: cliError(CliErrorCode.MissingDecisionChoice, "Use decision propose --chosen <text> or --chosen <json-object>.") };
  }
  if (typeof raw !== "object" && !(typeof raw === "string" && raw.trim().startsWith("{"))) {
    return { ok: true, value: { text: String(raw) } };
  }
  try {
    const parsed = parseObjectInput(raw, "chosen JSON must be an object");
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

export function parseRejectedInputs(args: ReadonlyArray<string>, fallbackWhyNot: string | undefined, input?: unknown):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionRejectedInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const flagValues = readRepeatedRawOption(args, "--rejected");
  const values: ReadonlyArray<unknown> = flagValues.length > 0 ? flagValues : inputValues(input);
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

function parseRejectedInput(raw: unknown, fallbackWhyNot: string | undefined):
  | { readonly ok: true; readonly value: DecisionRejectedInput }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  if (raw === undefined || raw === null || (typeof raw === "string" && (!raw || raw.startsWith("--")))) {
    return { ok: false, error: cliError(CliErrorCode.MissingDecisionRejected, "Use decision propose --rejected <text> --why-not <text>.") };
  }
  if (typeof raw !== "object" && !(typeof raw === "string" && raw.trim().startsWith("{"))) {
    if (!fallbackWhyNot) return { ok: false, error: cliError(CliErrorCode.MissingDecisionRejected, "Use decision propose --rejected <text> --why-not <text>.") };
    return { ok: true, value: { text: String(raw), why_not: fallbackWhyNot } };
  }
  try {
    const parsed = parseObjectInput(raw, "rejected JSON must be an object");
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

export function parseClaimInputs(args: ReadonlyArray<string>, defaultLoadBearing: boolean, input: ReadonlyArray<unknown> = []):
  | { readonly ok: true; readonly value: ReadonlyArray<DecisionClaimInput> }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  const claims: DecisionClaimInput[] = [];
  for (const raw of [...input, ...readRepeatedRawOption(args, "--claim")]) {
    const parsed = parseClaimInput(raw, defaultLoadBearing);
    if (!parsed.ok) return parsed;
    claims.push(parsed.value);
  }
  return { ok: true, value: claims };
}

function parseClaimInput(raw: unknown, defaultLoadBearing: boolean):
  | { readonly ok: true; readonly value: DecisionClaimInput }
  | { readonly ok: false; readonly error: CliResult["error"] } {
  if (raw === undefined || raw === null || (typeof raw === "string" && (!raw || raw.startsWith("--")))) {
    return { ok: false, error: cliError(CliErrorCode.InvalidDecisionAmendPatch, "Use --claim <text> or --claim <json-object>.") };
  }
  if (typeof raw !== "object" && !(typeof raw === "string" && raw.trim().startsWith("{"))) {
    return { ok: true, value: { text: String(raw), ...(defaultLoadBearing ? {} : { load_bearing: false }) } };
  }
  try {
    const object = parseObjectInput(raw, "claim JSON must be an object");
    if (typeof object.text !== "string" || object.text.trim().length === 0) throw new Error("claim JSON requires text");
    if (object.fulfillment !== undefined && (
      typeof object.fulfillment !== "string" ||
      !decisionClaimFulfillments.some((value) => value === object.fulfillment)
    )) throw new Error("claim JSON fulfillment must be evidenced, delivered, or standing-policy");
    return {
      ok: true,
      value: {
        ...(typeof object.id === "string" && object.id.trim() ? { id: object.id } : {}),
        text: object.text,
        ...(typeof object.load_bearing === "boolean" ? { load_bearing: object.load_bearing } : defaultLoadBearing ? {} : { load_bearing: false }),
        ...(typeof object.fulfillment === "string" ? { fulfillment: object.fulfillment as DecisionClaimInput["fulfillment"] } : {})
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

function parseObjectInput(raw: unknown, objectError: string): Record<string, unknown> {
  if (typeof raw === "string") return parseJsonObject(raw, objectError);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(objectError);
  return raw as Record<string, unknown>;
}

function inputValues(input: unknown): ReadonlyArray<unknown> {
  if (input === undefined || input === null) return [];
  return Array.isArray(input) ? input : [input];
}
