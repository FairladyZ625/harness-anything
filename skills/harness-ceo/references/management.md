# Management judgment

## Compare total cost

Delegation is useful when independent execution, focused context, or a second view returns more than the cost of briefing, waiting, reviewing, rework, and integration. Ask four questions before choosing the route:

1. Can the CEO make a safe, well-grounded change with the current context? Direct work is reasonable for a small bounded task; preserve CEO attention when cross-line coordination or semantic judgment is the scarce resource.
2. What is the complete dispatch cost? If brief, review, and integration will dominate, make the task coherent and give the worker the context to find the root cause. Do not reduce the packet to a thin recipe to save a few lines.
3. Has the same method failed twice without new evidence? Stop repeating it. Change the method, identity, or contract; reuse prior evidence and explain why the next attempt can succeed.
4. Will this require long-running exploration, measurement, or many trials? Delegate it when one owner can carry the work to evidence and report the result.

There is no universal rule to always delegate or always do a small task yourself. Optimize the whole delivery path and keep authority where it belongs: the CEO owns scope, semantic acceptance, and authorized external decisions.

## Choose coherent slices

Start with the largest coherent result that one owner can understand and verify. A slice is a semantic outcome, not a file, function, or calendar interval. Split when results have distinct acceptance, different risk, incompatible write ownership, or a true dependency that can be stated and verified. Each split repeats context acquisition and CEO acceptance, so extra boundaries need a benefit.

Give the first checkpoint an observable result from the real entry point to a user or caller. A plan, isolated helper, generated file, or unit test may be useful but does not prove the feature is wired into its consumer.

If one dispatch has not progressed, inspect the contract and evidence before retrying. After two failures of the same method without new information, revise it or return the task premise for decision. Reassigning the same thin packet to a new identity is not a method change.

## Give context, constrain ownership

Workers need broad information and a narrow responsibility. Include relevant sources, adjacent consumers, failed attempts, acceptance, and uncertainty. State authorization and true write conflicts; do not define a fixed list of files they are allowed to inspect. An unexpected affected surface is a useful finding: have the worker report it and decide whether to include it.

Keep a file deny list limited to paths an active owner is changing and protected boundaries. Prove an active owner from the current task/dispatch or pull request state. Do not reserve paths for abandoned work based only on stale files. See [dispatch](dispatch.md).

## Ask what complexity buys

When a change seems overbuilt, ask its author:

- What is the simplest solution that meets the acceptance criteria?
- What additional complexity did this design introduce?
- Which concrete failure or capability does that complexity address?

Require evidence that a new layer catches a failure the existing write boundary does not. For each removed check, name the failure class that will no longer be detected and show equivalent coverage if the validation is redundant. Prefer deleting an obsolete responsibility or narrowing its assumptions when that solves the cause.

## Keep reporting useful

Report conclusions, direct evidence, risks, and the next action. Separate observed fact from inference and unverified status. Record progress at meaningful checkpoints rather than copying full reasoning. A durable artifact and an accountable next owner matter more than a long status transcript.
