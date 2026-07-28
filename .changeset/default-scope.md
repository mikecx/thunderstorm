---
'@mikecx/thunderstorm': minor
---

Add `@DefaultScope`, a class decorator registering a query modifier that's automatically applied to every read (`find`/`all`/`where`/`findInBatches`/associations/preloads). Multiple applications stack (ANDed), subclasses inherit their parent's default scopes on top of their own, and `Model.unscoped()` bypasses every registered scope.
