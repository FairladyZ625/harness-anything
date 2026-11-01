# Improving this CEO skill

Use this guide when recurring work shows that the skill's instructions cause avoidable guessing, repeated review, or unreliable delivery. One unusual failure is an observation; repetition or a clear mechanism is evidence for a reusable rule.

## Update the smallest useful boundary

1. Describe the concrete situation and the result the current skill produced.
2. Verify the relevant request, task, command behavior, and output. Separate facts from interpretation.
3. State the mechanism in reusable terms and identify which users or hosts it applies to.
4. Ask whether removing the unnecessary responsibility fixes the problem. If not, add only the instruction or template field needed to prevent the named failure.
5. Check all references and consumers for old contradictory guidance. Delete superseded advice in the same change.
6. Test the rewritten skill against a fresh, context-free scenario and verify links, commands, and private-boundary scans.

Do not turn a provider incident, local configuration, personal preference, or one project's route into a universal rule. Host-dependent capabilities must be conditional and have a way to discover whether the host supplies them. A skill edit is not a substitute for fixing a repeatedly failing CLI or runtime boundary.

## Evaluate the result

Use a task that exposes the original failure and at least one nearby valid case. A useful change prevents the failure without blocking the valid case, does not add an unnecessary confirmation or hidden process, and leaves a clear evidence path. If the test scenario cannot distinguish the old behavior from the proposed behavior, refine the scenario before claiming the skill improved.
