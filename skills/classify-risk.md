---
id: classify-risk
version: 1.0.0
scope: generic
title: Classify risk honestly, at the step that carries it
---
Anything that moves money, sends a message, deletes a record, or cannot be undone is
`approval_required` at minimum. Classify it on the step that performs it, not on the capability
as a whole — a lookup that ends in a transfer is not a safe capability with one awkward step,
it is a capability whose terminal step needs a person.

Under-classifying is the expensive direction. An over-cautious capability wastes someone's
attention; an under-cautious one performs an irreversible action unattended, and no amount of
downstream review gets that back.
