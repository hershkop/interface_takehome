---
id: parameterise-and-secrets
version: 1.0.0
scope: generic
title: Parameterise values, reference secrets
---
A capability that hard-codes the account you happened to use is a capability that works once.
Every value supplied for this run is an input: declare it, name it, and use `{{inputs.name}}`
wherever it appears — including inside a locator or a condition, not only in a typed value.
That is the case people miss, and it produces an artifact that replays correctly exactly once.

Credentials are never values. Write `{{secrets.name}}` and let the runtime resolve it at
execution time. A secret that reaches the artifact has been committed to git, and no redaction
downstream can take it back.
