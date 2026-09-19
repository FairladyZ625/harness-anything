# Closeout

Replace this file's placeholder content before closeout; `ha task complete` rejects placeholder text. A lightweight closeout answers two things only: what was delivered, and the command that verified it. Fact and decision bookkeeping is not a completion precondition under this profile; record it as usual when it happens.

## Summary

Summarize the completed behavior change. Name exactly one delivery commit by its full 40-character lowercase SHA (the merge commit when the delivery landed through a PR), or at least one `artifact:<path>@<revision>` anchor; without it `ha task submit` / `ha task settle` reject the closeout with `document_invalid`.

## Verification

One test command and its receipt: the command you ran and its result (exit code or pass count). Attach any further applicable checks and accepted residual risks inside this section; this profile carries no separate Residual Risk or Same Mechanism Elsewhere sections.
