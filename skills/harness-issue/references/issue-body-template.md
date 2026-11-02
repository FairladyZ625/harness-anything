<!-- Canonical public issue body. The headings in this file are aligned with .github/ISSUE_TEMPLATE/issue.yml by tools/skill-contracts.test.mjs; change the form and this file together. Copy the whole file, replace every italic hint, and keep every heading. -->

### Issue type
*One of: Bug, Documentation gap, Scoped improvement, Failing command or CI lane.*

### Impact
*Who is affected, how often, what breaks, the workaround, and the blast radius.*

### Expected behavior
*What should happen.*

### Actual behavior
*What happened instead.*

### Reproduction steps
*Smallest ordered steps from a clean checkout, with the exact command and exit code.*

### Version / build
*`ha --version`, daemon `commit=`, branch or commit, package version, agent/runtime.*

### Screenshot or recording
*Visible evidence, or `Not applicable — text evidence in Command output or logs`.*

### Command output or logs
*Exact command, exit code, and the smallest relevant stdout/stderr. Redact secrets.*

### Reporter environment
*OS, shell, Node, package manager, branch or commit, agent/runtime.*

### Source-level triage
*Read: ... | Hypothesis: ... | Investigate first: ... | Checks run: ... | Checks not run / why: ...*

### Stop condition or acceptance criteria
*The observable condition that means fixed, or the maintainer decision needed.*

### Public issue checklist
- [x] I removed secrets, credentials, private harness records, absolute local paths, and local-only generated caches.
- [x] I included source-level triage instead of only asking maintainers to recreate my environment.
- [x] I stated the affected users, frequency, and blast radius in Impact.
