# Capability-based identity selection

Roles and models are separate. A role states responsibility and acceptance; a model and runtime provide execution capability. Do not encode a personal vendor lineup, permanent ranking, or user-specific capacity rule in a public skill.

Discover the user's actual roster with `ha agent list` and `ha squad list`, then inspect candidates with the relevant `inspect` command. Check that the candidate's declaration, tools, task-bound worktree support, expected output, and current runtime are suitable. A declared identity is a useful contract, not evidence that its provider is currently available.

## Select by work shape

Use capability bands as questions, not fixed assignments:

| Work shape | Evidence to seek in an identity |
| --- | --- |
| Bounded extraction, inventory, or short scan | Can it read the full specified source set, preserve provenance, and return a checkable structured result? |
| Routine implementation or test repair | Can it follow repository instructions, trace callers, make a minimal change, and run the named focused checks? |
| Cross-layer root cause, architectural design, or productization | Can it integrate broad context, test competing explanations, and report tradeoffs and migration impact? |
| Independent functional or adversarial review | Is the review path independent of the implementation, tied to the exact cut, and required to cite source and concrete evidence? |
| Visual or specialized domain work | Does the identity have the required modality, actual tools, and domain workflow? |

Choose the least costly available identity that meets the task's required capability and authority. Do not use cheapness to lower acceptance, independent review, or required modality. Unknown performance is unknown, not proof of incapacity; try a bounded representative task when authorized and record the evidence.

## Change resources without changing the contract

If a resource is unavailable, inspect the actual runtime and error. Distinguish authentication, capacity, permission, tool, and task-quality failures. A replacement must preserve the task role, permissions, tools, modality, output, and acceptance. Recheck evidence when a material runtime or model change could alter it. Never store credentials in the matrix or task packet.

Record only observations that could guide a later choice: task type, declaration and runtime, requested and observed configuration, artifact, direct result, limitations, and when the recommendation should be revisited. When the host exposes actual invocation metadata, compare it with the requested identity and settings; otherwise leave the actual configuration unverified. One run supports a narrow observation, not a universal ranking. Keep user-owned observations in the user's existing knowledge location; see [initialization](initialization.md).
