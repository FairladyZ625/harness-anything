---
name: preset-trigger
description: Route Harness Anything task creation through dynamic preset discovery. Use whenever an agent is creating, planning, scoping, or preparing a Harness task package, or deciding which preset should shape one; trigger before task creation so the agent discovers current presets, inspects candidates, and creates the task with an explicit preset.
---

# Preset Trigger

## Core Rule

Choose a preset before creating a Harness Anything task package. Treat this
Skill as the pre-discovery router and each preset's `PRESET.md` as its
post-discovery semantic contract. Never copy the preset inventory into this
Skill.

## Workflow

1. From the target repository's initialized Harness root, discover its current
   preset registry:

   ```bash
   ha preset list
   ```

2. If project discovery is unavailable, report that failure instead of
   guessing a preset ID. Use CLI help only to inspect bundled recommendations:

   ```bash
   ha task create --help
   ```

3. Inspect promising candidates when their summaries are not enough:

   ```bash
   ha preset inspect <id>
   ```

4. Select the narrowest preset whose current description and `whenToUse`
   guidance match the task. Use the active vertical's declared default only
   when no narrower candidate fits.

5. Create the task package through the CLI with the selected preset:

   ```bash
   ha task create --title "<title>" --vertical <vertical-id> --preset <id>
   ```

   Use the target repository's configured vertical, or omit `--vertical` to
   preserve the CLI default. Do not replace it with a hardcoded vertical.

6. Read the generated task package before claiming or implementing it.

## Guardrails

- Do not hand-create task package directories.
- Do not maintain preset IDs or descriptions in this Skill; query the current
  registry instead.
- Do not confuse discovery with explanation: this Skill recalls the preset
  workflow, while `PRESET.md` explains an individual preset after discovery.
- Do not omit explicit preset selection merely because task creation has a
  default.
