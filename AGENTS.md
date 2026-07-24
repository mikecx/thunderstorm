# AGENTS.md

Guidance for agentic/AI-assisted work on this repo. `thunderstorm` is a small ActiveRecord/ActiveModel-style ORM for TypeScript, built on [Knex](https://knexjs.org). Read [README.md](README.md) first for the feature-by-feature reference with runnable snippets — this file is about _how the codebase is put together_ and _what not to accidentally undo_.

## Layout

```
src/
  Model.ts          — the base Model class, QueryChain, connect()/transaction()
  decorators.ts      — @Column, @Validates, callback decorators, @Delegate, @Enum, Timestamped mixin
  casters.ts          — built-in attribute casters (string/number/boolean/date/json)
  errors.ts            — Errors, RecordInvalid, RecordNotSaved
  index.ts               — public API surface (the only file consumers should import from)
  example/demo.ts          — exercises every feature end-to-end against a real in-memory DB
  *.test.ts                 — one file per feature area (see README's Testing section)
migrations/                 — schema source of truth, run via the Knex CLI (knexfile.ts)
```

## Before making changes

Run the full check before and after any nontrivial change — this is exactly what CI (`.github/workflows/ci.yml`) runs:

```bash
npx tsc --noEmit && npm run lint && npm run format:check && npm test
```

`npm run demo` is also worth running for anything touching `Model.ts` or `decorators.ts` — it's the closest thing to an integration smoke test and has caught real bugs (see below) that the unit tests alone hadn't.

## Load-bearing design decisions — don't undo these by accident

- **No `[key: string]: any` on `Model`.** It was removed deliberately so typos on undeclared properties are compile errors. Internal code that needs to read/write a column by a runtime string key uses the `getAttr`/`setAttr` helpers at the top of `Model.ts`, not direct index access. If you add a new method that needs dynamic attribute access, use those helpers rather than re-adding a blanket index signature.
- **Metadata maps (`COLUMNS`/`VALIDATIONS`/`CALLBACKS`) must deep-clone on inherit.** `ownMetadataMap` in `decorators.ts` seeds a subclass's own map with cloned copies of whatever its ancestor already registered, rather than starting empty. This was a real bug: `Timestamped(Model)` registers `createdAt`/`updatedAt` + callbacks on an intermediate class, and a further subclass adding its own `@Column()` used to silently lose them. If you add a new metadata symbol following this pattern, route it through `ownMetadataMap` too — don't hand-roll the `hasOwnProperty` check again without the clone step.
- **`assignRow` only assigns declared `@Column()` fields**, not every key in a raw DB row. It used to blindly assign everything `SELECT *` returned, which crashed a custom setter when an undeclared column came back as `null`. Keep it that way — declared columns are the contract, not the table's actual shape.
- **Relations (`hasMany`/`hasOne`/`belongsTo`) are plain instance methods, not decorators.** They take the related class directly (no thunk) because the reference is only resolved when the method _runs_, well after both modules have finished loading — safe even across circular imports between two model files. A decorator-based approach would evaluate the class reference too early and break on circular imports.
- **`@Delegate`/`@Enum` stay class decorators; `Timestamped` is a mixin, not a decorator.** The difference is deliberate: `Timestamped`'s added properties (`createdAt`/`updatedAt`) are fixed names, so a mixin gives them real static types for free. `@Delegate`/`@Enum` generate member _names_ from runtime string values, which a decorator can't feed back into the type system — consumers type those via companion `interface` declarations (see README's "TypeScript typing notes"). If you add a similar macro, prefer a mixin whenever the generated member names are fixed at the call site; only reach for a decorator + documented interface-merging when they're genuinely dynamic.
- **`beforeValidation`/`afterValidation` are intentionally not implemented.** Wiring them up would force `isValid()` to become async, breaking its current synchronous contract and a large chunk of the validation test suite. Don't add them without discussing the breaking change first.
- **`transaction()` has no savepoint/nested-transaction support by design** — a nested call just reuses the outer transaction via `AsyncLocalStorage`. Don't add real savepoints without also handling partial rollback semantics carefully.

## Testing conventions

- Vitest, and tests run against **real `sqlite3 :memory:` connections** — no mocking of Knex or the DB layer. Each test file creates its own tables in `beforeEach`.
- One file per feature area (`validations.test.ts`, `callbacks.test.ts`, `associations.test.ts`, `dirty.test.ts`, `casting.test.ts`, `macros.test.ts`, `scopes.test.ts`, `transactions.test.ts`, `convenience.test.ts`, `queries.test.ts`, `attributes.test.ts`, plus `decorators.test.ts`/`errors.test.ts` for pure-metadata/unit-level checks). Add new tests to the matching file rather than creating a new one per test case.
- When testing N+1-avoidance or query counts, assert the actual count via `knex.on('query', () => queryCount++)` — don't just assert on the resulting data, which wouldn't catch a regression back to one-query-per-record.
- `tsconfig.json` excludes `*.test.ts` from the build (`npm run build`) — test files should never end up in `dist/`.

## Migrations

`migrations/` is the schema source of truth, applied via the standard Knex CLI (`npm run migrate:latest`, etc. — see README). `src/example/demo.ts` runs the _same_ migrations directory programmatically against a fresh in-memory DB, so if you add a table for a demo/test, add a real migration for it rather than an ad-hoc `knex.schema.createTable` inline in the demo.

## Commands reference

| Command                                       | Does                                 |
| --------------------------------------------- | ------------------------------------ |
| `npm test` / `npm run test:watch`             | Vitest                               |
| `npx tsc --noEmit`                            | Type check only                      |
| `npm run build`                               | Emit `dist/` (excludes tests)        |
| `npm run lint` / `npm run lint:fix`           | ESLint                               |
| `npm run format` / `npm run format:check`     | Prettier                             |
| `npm run demo`                                | Run `src/example/demo.ts` end-to-end |
| `npm run migrate:make/latest/rollback/status` | Knex migration CLI                   |
