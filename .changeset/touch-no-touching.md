---
'@mikecx/thunderstorm': minor
---

Add `touch()` (bumps `updatedAt` plus any other named columns via a direct UPDATE, skipping validations/callbacks), `@Touch(associationMethod)` (cascades `touch()` up to a `belongsTo`/`hasOne` parent on create/save/destroy — mirrors `belongs_to ..., touch: true`), and `noTouching(fn)` (suppresses every `touch()` call, direct or cascaded, for the duration of `fn` — Rails' `no_touching`, backed by `AsyncLocalStorage` like `transaction()` rather than a global flag).
