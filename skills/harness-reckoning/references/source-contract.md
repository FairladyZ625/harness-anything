# Pluggable source contract

A source is an ECMAScript module exporting `async function collectSignals(context)`. The context contains `root`, `databasePath`, and `since`. Sources must be read-only and return an array.

Each item requires a stable `key`, an `evidence` object, and an `occurrences` count. It may set `kind`. A source may request consideration of a new rule only with:

```json
{
  "proposedRule": {
    "trigger": "an objectively observable condition",
    "expiresAt": "2026-12-31T00:00:00Z"
  }
}
```

The engine still emits a candidate for human adjudication; it never writes the rule. Sources must not read credential directories or send ledger contents to an external service. `tools/nightly-reckoning/example-source.mjs` is the minimal adapter.
