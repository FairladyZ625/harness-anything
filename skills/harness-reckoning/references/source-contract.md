# External source contract

A source is a read-only command or service named in the Schedule mission. It returns a JSON array for the occurrence agent to merge with built-in signals.

Each item requires a stable `key`, an `evidence` object, and an `occurrences` count. It may set `kind`. A source may request consideration of a new rule only with:

```json
{
  "proposedRule": {
    "trigger": "an objectively observable condition",
    "expiresAt": "2026-12-31T00:00:00Z"
  }
}
```

The source still emits only a candidate for human adjudication; it never writes the rule. Sources must declare their read scope, must not read credential directories, and must not send ledger contents to an undeclared external service.
