# Harness-Anything

Harness-Anything is the clean-room rewrite workspace for the Harness kernel,
CLI, GUI, and adapter packages.

This repository is a single Git monorepo. Packages under `packages/` are npm
workspace packages, not nested Git repositories.

Private planning, architecture, and task state live in `.harness-private/`,
which is intentionally ignored by the public repo.

## Local CLI Quick Start

Use Node.js 24 or newer.

```bash
npm ci
npm run typecheck
node packages/cli/src/index.ts --json doctor
```

For a minimal project:

```bash
node packages/cli/src/index.ts --root /path/to/project --json init
node packages/cli/src/index.ts --root /path/to/project --json new-task --title "First task"
node packages/cli/src/index.ts --root /path/to/project --json status
node packages/cli/src/index.ts --root /path/to/project --json check --post-merge
```

Public operating docs:

- `docs-release/m1-minimal-loop.md`
- `docs-release/m2-coding-vertical.md`
- `docs-release/harness-agent-skill.md`
- `examples/minimal-project/`

M2 is still before final cutover. Packages remain private and this repository
does not claim a published package release from the P6 docs.

## License

Harness-Anything is licensed under AGPL-3.0-or-later. See `LICENSE`.
