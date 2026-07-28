---
'@mikecx/thunderstorm': minor
---

Add `SoftDelete(Base)`, a mixin adding a `deletedAt` column and a default scope excluding deleted rows. `destroy()` on a soft-deletable model does an UPDATE instead of a DELETE, still running the usual `beforeDestroy`/`afterDestroy` callbacks; `restore()`/`isDeleted` are available on every `Model`, conditionally active on the presence of a `deletedAt` column.
