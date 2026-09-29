---
id: durable-locators
version: 1.0.0
scope: generic
title: Prefer durable locators, in a stated order
---
Target controls by what they *are*, not where they happen to sit. Record an ordered list of
candidates, best first, so replay can fall back when a page changes underneath it:

1. Accessible role and name — the thing a screen reader would announce.
2. The label associated with a field.
3. Stable visible text.
4. A stable form name or id.
5. A structural CSS selector, only when nothing above exists.

Never record a coordinate. A coordinate is a screenshot's opinion about where something was; it
survives nothing, and an artifact containing one cannot be promoted past draft.

If a control has no accessible name, say so in the step's rationale rather than reaching for a
brittle selector silently. A reviewer can fix a named weakness; they cannot fix one you hid.
