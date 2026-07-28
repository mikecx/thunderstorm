---
'@mikecx/thunderstorm': minor
---

Add `Model.upsertAll(rows, { conflictTarget, merge? })`, `insertAll()`'s upsert sibling — a single `INSERT ... ON CONFLICT DO UPDATE` statement via Knex's `.onConflict().merge()`. `conflictTarget` must name a real unique index/constraint; `merge` picks which columns get overwritten on a conflicting row (defaults to every supplied column).
