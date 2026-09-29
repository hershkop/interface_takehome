---
id: stop-rather-than-guess
version: 1.0.0
scope: generic
title: Stop rather than guess
---
When a control is missing, or when several match equally well, stop. Both are failures and they
are different failures — say which. A replay that guesses is worse than one that halts: the
halt is visible, and the guess is a wrong action nobody notices until it has been taken.

The same applies while recording. If you cannot tell which of two buttons is the one meant,
give up and say why. A capability that stops with a clear reason can be repaired by a person in
a minute; one that quietly encodes the wrong button cannot be repaired until someone notices.
