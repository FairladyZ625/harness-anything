import {
  classifyCompoundExit,
  type CompoundExitDefinition,
  type CompoundExitInput,
  type CompoundOperationReceipt,
  type CompoundOperationReceiptV2
} from "@harness-anything/application";

type RenderableCompoundReceipt = CompoundOperationReceipt | CompoundOperationReceiptV2;

export interface CompoundCliExit {
  readonly exitCode: number;
  readonly symbol: CompoundExitDefinition["symbol"];
  readonly stderr: string;
  readonly nextAction: string;
  readonly json: {
    readonly symbol: CompoundExitDefinition["symbol"];
    readonly exitCode: number;
    readonly authority: RenderableCompoundReceipt["authority"] | null;
    readonly origin: RenderableCompoundReceipt["origin"] | null;
    readonly phase: RenderableCompoundReceipt["phase"] | null;
    readonly delivery: RenderableCompoundReceipt["delivery"] | null;
    readonly historicalCut: RenderableCompoundReceipt["origin"] | null;
    readonly currentLease: RenderableCompoundReceipt["currentLease"] | null;
    readonly acknowledgement: RenderableCompoundReceipt["acknowledgement"] | null;
    readonly nextAction: string;
  };
}

export function renderCompoundCliExit(input: CompoundExitInput): CompoundCliExit {
  const outcome = classifyCompoundExit(input);
  const receipt = input.kind === "RECEIPT" ? input.receipt : undefined;
  const historicalCut = receipt?.origin?.tag === "APPLIED_EXACT_AT_CUT" ? receipt.origin : null;
  return {
    exitCode: outcome.code,
    symbol: outcome.symbol,
    stderr: `${outcome.symbol}: ${outcome.meaning} Next: ${outcome.nextAction}`,
    nextAction: outcome.nextAction,
    json: {
      symbol: outcome.symbol,
      exitCode: outcome.code,
      authority: receipt?.authority ?? null,
      origin: receipt?.origin ?? null,
      phase: receipt?.phase ?? null,
      delivery: receipt?.delivery ?? null,
      historicalCut,
      currentLease: receipt?.currentLease ?? null,
      acknowledgement: receipt?.acknowledgement ?? null,
      nextAction: outcome.nextAction
    }
  };
}
