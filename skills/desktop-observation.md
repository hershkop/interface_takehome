---
id: desktop-observation
version: 1.0.0
scope: surface:desktop
title: Reading a desktop application
---
The observation is the platform's accessibility tree, rendered in the same shape a web page
produces. Role and name are all you have and all you need — CSS selectors and test ids mean
nothing here, and a candidate using one will be refused by name rather than silently skipped.

A window title is not a location. Navigation between screens changes the title; it does not
change which application you are in, and the policy that contains this run is written against
the application.
