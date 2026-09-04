# User-owned model matrix and onboarding

## What is maintained where

The public skill maintains role requirements, evaluation methods, and a template.
The user maintains the actual models, instance bindings, preferences, costs, and
observed performance in their Harness workspace. Reuse an existing matrix. For a
new one, use the workspace's authored context location, for example
`<authored-root>/context/model-matrix.md`, through its supported document write
path. Never write user observations into the installed public skill by default.
Do not overwrite an existing matrix during setup or upgrade.

The [template](../assets/model-matrix.md) is prose, not CLI configuration. A row
cannot make an unavailable model callable or confer permissions. Runtime/provider
setup uses the current supported configuration surface and required authorization.
Store credential references only; never tokens or private prompts in the matrix.

Role, model, provider/runtime instance, and permission profile are separate:

- Role states responsibility and acceptance expectations.
- Model/settings identify the requested execution resource.
- Runtime instance supplies the actual callable integration and tool support.
- Permissions come from the host and owner, not observed intelligence or rank.

## Select from evidence

Choose using the task's needs, current availability, observed quality, latency,
cost/budget, context capacity, and required tool or modality support. Record unknown
values as unknown. Do not invent scores, exact context limits, prices, or fixed
rankings. Same model through another runtime may have different tools and behavior.
A row is a recommendation with evidence, not a whitelist of permitted roles.

For CEO work, prioritize goal interpretation, delegation quality, supervision,
source-based semantic acceptance, and the ability to revise a mistaken premise.
For Commander work, evaluate decomposition and integration. For Worker work,
evaluate the actual task family and tool path. Review requires independently
checking claims; changing model names alone does not create actor independence.

Optional CEO starting candidates are **Claude Fable 5** and **GPT 6 Astra** where
available to the user. These are starting suggestions, not required products,
verified provider IDs, or a claim that they outperform the user's alternatives.
Resolve actual identifiers through the installed runtime. A user with only one
model can begin with it; role boundaries still apply.

## Add a model

1. Discover the actual runtime, model identifier, settings, and tool permissions.
   Separate advertised capabilities from observed ones. Do not auto-install a
   provider or purchase credits to fill a matrix row.
2. Create an unmeasured entry with its intended task families and known constraints.
   Missing benchmarks do not prohibit use. Choose a bounded first task within
   existing permission and cost limits; state the uncertainty.
3. Exercise a representative task through the same tool path intended for real
   dispatch. Check its artifacts directly. Include a case requiring the model to
   reject an incorrect premise or report missing evidence. Add modality, long
   context, or interruption/recovery checks only when the intended work needs them.
4. Record model/runtime/settings, task and environment, observable outcome,
   corrections needed, cost/latency when available, and evidence references.
   Separate provider/permission failures from model quality failures. A hypothetical
   transcript or self-rating is not a successful execution.
5. Update the entry's recommendation and limits from that evidence. A single run
   supports a narrow observation, not a universal competence claim. Include what
   would invalidate the recommendation and when to revisit it.
6. For recurring assignments, bind an existing suitable agent declaration or
   create one through the current Harness declaration path. Role instructions
   remain reusable across models; do not clone a handbook per vendor.

## Learn without turning observations into dogma

After meaningful successes or failures, append an observation to that run's
artifact first. The matrix owner incorporates verified changes, removing outdated
recommendations instead of accumulating conflicting rules. Model/version, runtime,
tool, or task-family changes can justify reevaluation; a new session alone does not.
Do not retest everything after every successful dispatch.

If a preferred resource is unavailable, choose an authorized available alternative
whose tool support fits the work. Reassess evidence strength when changing runtime;
never silently route images to a text-only path or expand cost/permission limits.
When no suitable path is available, narrow the work or report the specific gap.

For multi-node updates use [central ownership and per-run evidence](dispatch.md).
For a lesson that changes general coordination rather than model selection, use
[skill maintenance](maintenance.md).
