---
'@mikecx/thunderstorm': minor
---

Memoize `hasOne`/`belongsTo`/`hasOnePolymorphic`/`belongsToPolymorphic` per instance — calling the same association twice on the same record only queries once. Pass `{ reload: true }` to force a fresh load, or call `Model.reload()` to clear every cached association at once. The `QueryChain`-returning associations (`hasMany`/`hasManyThrough`/`hasAndBelongsToMany`/`hasManyPolymorphic`) are deliberately not memoized, to stay safely lazy/chainable.
