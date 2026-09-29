---
id: outcomes-and-handlers
version: 1.0.0
scope: generic
title: Separate a business outcome from a failure
---
"The account does not exist" is an answer, not an error. A caller should receive it as a
business outcome with the details attached, and should not have to parse an error message to
learn something the application stated plainly.

Three dispositions, and they are not interchangeable:

- **business_outcome** — the application answered, and the answer is not the happy path.
- **recover** — a transient condition with a named remedy and an attempt cap.
- **fail** — the run cannot continue and a person needs to know.

Only write a handler for a path you actually observed or deliberately provoked. A handler for
an error you imagined is a guess wearing the costume of evidence, and it will fire on something
you did not intend. Recording zero handlers is an honest result for a single happy-path run.

End with a checkpoint that asserts you arrived somewhere specific. Without one, "it replayed"
means only "nothing threw".
