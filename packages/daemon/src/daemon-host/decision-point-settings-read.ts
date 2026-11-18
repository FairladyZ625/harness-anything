import { decisionEventDescriptor, decisionPointBindingDigest, type VerticalDefinition } from "@harness-anything/kernel";
import { projectDecisionInput } from "./decision-point-executor.ts";
import type { DecisionPointSettingsRow } from "./protocol/daemon-settings-read-types.ts";

// Synthetic input goes through the exact production field projection and redaction path.
// No repository report or credential is read to construct the preview.
export function readDecisionPointSettings(vertical: VerticalDefinition | null): readonly DecisionPointSettingsRow[] {
  const decisions = vertical?.decisions;
  if (!decisions) return [];
  return Object.entries(decisions.points).map(([pointId, point]) => {
    const question = decisions.questions[point.question]!,
      bindingDigest = decisionPointBindingDigest(pointId, point, question),
      descriptor = decisionEventDescriptor(point.on)!,
      projected = projectDecisionInput({
        point,
        event: {
          payload: {
            attempt: { reason: "Stopped after the environment rejected access", classification: "worker_stop" },
          },
        },
        report: "Attempted verification in /Users/example/project. Access was rejected. No delivery was submitted.",
      });
    return {
      pointId,
      bindingDigest,
      bindingKey: `${pointId}@${bindingDigest.slice(0, 12)}`,
      on: point.on,
      revision: point.revision,
      question,
      when: point.when,
      input: point.input.map((field) => ({ field, ...descriptor.inputFields[field] })),
      projectionSample: projected?.state ?? "",
    };
  });
}
