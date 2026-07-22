# Project policy settings

Project policy belongs in `harness/harness.yaml` so it is reviewable with the
repository. Environment variables are emergency machine/deployment overrides;
when a command has an explicit flag, that flag remains highest priority.
Invalid YAML or environment values fail before the command creates a write
coordinator or changes repository state.

## Execution consent

```yaml
settings:
  execution:
    consentTtlMs: 86400000
```

`settings.execution.consentTtlMs` controls the independent freshness ceiling
for a matching human execution consent. The default is `86400000` ms (24
hours). `HARNESS_EXECUTION_CONSENT_TTL_MS` overrides YAML. Values must be
positive safe integers in milliseconds. Content-pin, principal, action-scope,
and expiry checks remain mandatory.

## Multica snapshot cache

```yaml
settings:
  adapters:
    multica:
      staleTtlMs: 300000
```

`settings.adapters.multica.staleTtlMs` controls how long a cached Multica
snapshot can remain stale-but-usable when the provider is unavailable. The
default is `300000` ms (5 minutes).
`HARNESS_MULTICA_STALE_TTL_MS` overrides YAML. Values must be positive safe
integers in milliseconds.

The effective precedence for both keys is: environment override, project YAML,
then the documented compiled default. These commands do not currently expose
single-use TTL flags.
