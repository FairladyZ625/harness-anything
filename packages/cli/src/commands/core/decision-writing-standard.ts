import type { DecisionChoiceInput } from "../../cli/types.ts";

export const decisionChosenTextMaxLength = 120;
export const decisionWritingStandardPath = "harness/standards/decision-writing.md";

export interface OverlongDecisionChoice {
  readonly anchor: string;
  readonly length: number;
}

export function findOverlongDecisionChoices(
  chosen: ReadonlyArray<DecisionChoiceInput>
): ReadonlyArray<OverlongDecisionChoice> {
  return chosen.flatMap((choice, index) => {
    const length = [...choice.text].length;
    if (length <= decisionChosenTextMaxLength) return [];
    return [{
      anchor: choice.id?.trim() || `CH${index + 1}`,
      length
    }];
  });
}

export function overlongDecisionChoiceHint(choice: OverlongDecisionChoice): string {
  return [
    `chosen ${choice.anchor} is ${choice.length} characters; each chosen[].text must be at most ${decisionChosenTextMaxLength}.`,
    "Do not compress the paragraph into denser wording.",
    "Keep only one judgment the arbiter can answer yes/no; split parallel judgments into separate --chosen entries.",
    "Move reasoning and tradeoffs to --body or --body-file, and move implementation requirements to a task.",
    `Read ${decisionWritingStandardPath}; if it is missing, run ha init to materialize it.`
  ].join(" ");
}
