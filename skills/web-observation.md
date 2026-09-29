---
id: web-observation
version: 1.0.0
scope: surface:web
title: Reading a web page
---
The observation you receive is an accessibility tree — roles and names, already filtered to
what is visible. Propose targets in those terms and they will resolve; propose CSS selectors
you inferred from a screenshot and they usually will not.

Text that is present in the DOM is not necessarily on screen. Applications routinely ship
hidden error containers on every page, so a condition matching raw text will fire on a
perfectly healthy run. Match visible content unless you have a specific reason not to.
