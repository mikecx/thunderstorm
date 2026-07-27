# AGENTS.md

Guidance for agentic/AI-assisted work on this repo. `thunderstorm` is a small ActiveRecord/ActiveModel-style ORM for TypeScript, built on [Knex](https://knexjs.org). Read [README.md](README.md) first for the feature-by-feature reference with runnable snippets — this file is about _how the codebase is put together_ and _what not to accidentally undo_.

## Layout

```
src/
  AttributeModel.ts — attributes/casting/virtual/defaults, validations, dirty tracking, serialization — no DB
  Model.ts           — extends AttributeModel: persistence, querying, associations, callbacks, QueryChain, connect()/transaction()
  decorators.ts      — @Column, @Validates, callback decorators, @Delegate, @Enum, Timestamped/SecurePassword/SecureToken mixins
  casters.ts         — built-in attribute casters (string/number/boolean/date/json)
  security.ts        — password hashing (scrypt) and token generation primitives, used by the SecurePassword/SecureToken mixins
  errors.ts          — Errors, RecordInvalid, RecordNotSaved
  index.ts           — public API surface (the only file consumers should import from)
  example/demo.ts    — exercises every feature end-to-end against a real in-memory DB
  *.test.ts          — one file per feature area (see README's Testing section)
migrations/          — schema source of truth, run via the Knex CLI (knexfile.ts)
```

## Before making changes

Run the full check before and after any nontrivial change — this is exactly what CI (`.github/workflows/ci.yml`) runs:

```bash
npx tsc --noEmit && npm run lint && npm run format:check && npm test
```

`npm run demo` is also worth running for anything touching `Model.ts` or `decorators.ts` — it's the closest thing to an integration smoke test and has caught real bugs (see below) that the unit tests alone hadn't.

## Load-bearing design decisions — don't undo these by accident

- **No `[key: string]: any` on `AttributeModel`/`Model`.** It was removed deliberately so typos on undeclared properties are compile errors. Internal code that needs to read/write a column by a runtime string key uses the `getAttr`/`setAttr` helpers exported from `AttributeModel.ts` (imported into `Model.ts` too), not direct index access. If you add a new method that needs dynamic attribute access, use those helpers rather than re-adding a blanket index signature.
- **Metadata maps (`COLUMNS`/`VALIDATIONS`/`CALLBACKS`) must deep-clone on inherit.** `ownMetadataMap` in `decorators.ts` seeds a subclass's own map with cloned copies of whatever its ancestor already registered, rather than starting empty. This was a real bug: `Timestamped(Model)` registers `createdAt`/`updatedAt` + callbacks on an intermediate class, and a further subclass adding its own `@Column()` used to silently lose them. If you add a new metadata symbol following this pattern, route it through `ownMetadataMap` too — don't hand-roll the `hasOwnProperty` check again without the clone step.
- **Decorators are TC39 Stage 3, not legacy `experimentalDecorators`.** Metadata lives on each class's `[Symbol.metadata]` object (which the engine automatically parents to the superclass's, giving the deep-clone-on-inherit behavior above almost for free via `ownMetadataMap` operating on that object instead of the constructor directly) rather than directly on the constructor via a bespoke symbol key. Two consequences worth knowing if you touch `decorators.ts`:
  - `Symbol.metadata` isn't natively supported by Node yet, and TypeScript's decorator helpers silently no-op `context.metadata` without it — hence the one-line polyfill at the top of `decorators.ts` (`(Symbol as any).metadata ??= Symbol.for('Symbol.metadata')`), which must keep running before any decorated class loads.
  - Any class with at least one decorated field gets standards-compliant "always define" field semantics for **every** field it declares, even undecorated ones with no initializer — this isn't a `useDefineForClassFields` toggle, it's inherent to how TC39 decorators are specified, and both esbuild (Vitest) and `tsc`/ts-node apply it. `@Column()`/`@PrimaryKey()`/`@Validates()` compensate for their own fields via `preserveFieldValue` (an initializer that re-affirms whatever `Object.assign`/the default-application loop already put on `this`, both of which run before any subclass field initializer does). An _undecorated_ bare field sharing a class with a decorated one — the "custom accessor" backing-field pattern in README — has no decorator to do that for it, so it must be declared with `declare` (`declare private _code: string;`), not a real field, or it'll silently reset to `undefined` after `super()`. Mixins (`Timestamped`/`SecurePassword`/`SecureToken`) inject metadata without going through an actual decorator application, so they synthesize their own `[Symbol.metadata]` object via `ownClassMetadata` — route any new mixin the same way rather than assigning `ctor[SYMBOL]` directly.
- **`assignRow` only assigns declared `@Column()` fields**, not every key in a raw DB row. It used to blindly assign everything `SELECT *` returned, which crashed a custom setter when an undeclared column came back as `null`. Keep it that way — declared columns are the contract, not the table's actual shape.
- **Relations (`hasMany`/`hasOne`/`belongsTo`) are plain instance methods, not decorators.** They take the related class directly (no thunk) because the reference is only resolved when the method _runs_, well after both modules have finished loading — safe even across circular imports between two model files. A decorator-based approach would evaluate the class reference too early and break on circular imports.
- **`@Delegate`/`@Enum` stay class decorators; `Timestamped` is a mixin, not a decorator.** The difference is deliberate: `Timestamped`'s added properties (`createdAt`/`updatedAt`) are fixed names, so a mixin gives them real static types for free. `@Delegate`/`@Enum` generate member _names_ from runtime string values, which a decorator can't feed back into the type system — consumers type those via companion `interface` declarations (see README's "TypeScript typing notes"). If you add a similar macro, prefer a mixin whenever the generated member names are fixed at the call site; only reach for a decorator + documented interface-merging when they're genuinely dynamic.
- **`beforeValidation`/`afterValidation` are intentionally not implemented.** Wiring them up would force `isValid()` to become async, breaking its current synchronous contract and a large chunk of the validation test suite. Don't add them without discussing the breaking change first.
- **`transaction()` has no savepoint/nested-transaction support by design** — a nested call just reuses the outer transaction via `AsyncLocalStorage`. Don't add real savepoints without also handling partial rollback semantics carefully.
- **`AttributeModel`/`Model` split follows Rails' ActiveModel/ActiveRecord line exactly.** `AttributeModel` (attributes, casting/virtual/defaults, validations, dirty tracking, serialization) has zero knowledge of persistence — no `tableName`, no `getKnex()`, no DB connection required even to import it. `Model extends AttributeModel` adds everything table-shaped: `query`/`find`/`all`/`where`, associations, `save`/`destroy`/`reload`/`dup`, and lifecycle callbacks. When adding a new feature, decide which layer it belongs on _before_ implementing: if it needs a table or a query, it's `Model`-only; if it's purely about an attribute's value (a new caster, a new validation rule, a new serialization option), it belongs on `AttributeModel` so `AttributeModel`-only subclasses get it too. Fields/methods that `Model` needs from `AttributeModel` but shouldn't be public (`snapshotAttributes`, the previous-changes setter) are `protected`, not `private` — `private` on `AttributeModel` is invisible to `Model`'s own methods, unlike within the old fused class.
- **`@Validates({ uniqueness })` is a `Model`-only rule despite living in the shared `ValidationRule` type.** `AttributeModel.applyRule()` silently ignores the `uniqueness` key (it has no table to check); `Model.save()` runs a separate `checkUniqueness()` after `isValid()` passes. Don't try to make `isValid()` async to unify these — that's the same tradeoff already made for `beforeValidation`/`afterValidation` above, and it's deliberate.
- **`@Column({ guarded: true })` affects two unrelated code paths on purpose: `permit()` (incoming) and `serializableHash()`/`toJSON()` (outgoing).** This was originally two separate ideas (mass-assignment protection, then password-digest leaking into JSON) that turned out to be the same underlying signal — "this must never cross an untrusted boundary in either direction." If you touch one of those code paths, check whether the change should apply to the other too.
- **`SecurePassword`'s password-hashing callback checks `isAttributeChanged('password')`, not `password === undefined`.** `password` is virtual, so it never auto-clears after being set — without checking dirty tracking, every subsequent `save()` of the same in-memory instance would re-hash the same unchanged password with a fresh salt (caught by a real test failure, not a review comment — see `security.test.ts`). This is a concrete example of `AttributeModel`'s dirty tracking being useful outside of `changes`/`isChanged` themselves.

## Testing conventions

- Vitest, and tests run against **real `sqlite3 :memory:` connections** — no mocking of Knex or the DB layer. Each test file creates its own tables in `beforeEach`.
- One file per feature area (`validations.test.ts`, `callbacks.test.ts`, `associations.test.ts`, `dirty.test.ts`, `casting.test.ts`, `macros.test.ts`, `scopes.test.ts`, `transactions.test.ts`, `convenience.test.ts`, `queries.test.ts`, `attributes.test.ts`, `attributeModel.test.ts`, `permit.test.ts`, `uniqueness.test.ts`, `security.test.ts`, plus `decorators.test.ts`/`errors.test.ts` for pure-metadata/unit-level checks). Add new tests to the matching file rather than creating a new one per test case.
- When testing N+1-avoidance or query counts, assert the actual count via `knex.on('query', () => queryCount++)` — don't just assert on the resulting data, which wouldn't catch a regression back to one-query-per-record.
- `tsconfig.json` excludes `*.test.ts` from the build (`npm run build`) — test files should never end up in `dist/`.

## Releasing

Published to npm as `@mikecx/thunderstorm` (the unscoped name `thunderstorm` was already taken by an unrelated package). Versioning, `CHANGELOG.md`, and publishing are handled by [Changesets](https://github.com/changesets/changesets):

1. Alongside any user-facing change, run `npx changeset` (or `npm run changeset`) and describe it — pick patch/minor/major and write the summary as it should read in the changelog. Commit the generated `.changeset/*.md` file with the change.
2. On push to `main`, [.github/workflows/release.yml](.github/workflows/release.yml) either opens/updates a "Version Packages" PR (bumping `package.json` + writing `CHANGELOG.md` from the pending changesets) or, if that PR was just merged, builds and publishes to npm via `npm run release`.
3. Nothing publishes without a changeset — a plain commit with no `.changeset/*.md` file just runs CI, no release PR is touched.

One-time setup this repo needs before the workflow can actually publish (not something an agent can do): an npm account owning the `@mikecx` scope, an npm automation token, and that token saved as the `NPM_TOKEN` secret in the GitHub repo settings.

## Migrations

`migrations/` is the schema source of truth, applied via the standard Knex CLI (`npm run migrate:latest`, etc. — see README). `src/example/demo.ts` runs the _same_ migrations directory programmatically against a fresh in-memory DB, so if you add a table for a demo/test, add a real migration for it rather than an ad-hoc `knex.schema.createTable` inline in the demo.

## Commands reference

| Command                                       | Does                                                                                               |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `npm test` / `npm run test:watch`             | Vitest                                                                                             |
| `npx tsc --noEmit`                            | Type check only                                                                                    |
| `npm run build`                               | Emit `dist/` (excludes tests)                                                                      |
| `npm run lint` / `npm run lint:fix`           | ESLint                                                                                             |
| `npm run format` / `npm run format:check`     | Prettier                                                                                           |
| `npm run demo`                                | Run `src/example/demo.ts` end-to-end                                                               |
| `npm run migrate:make/latest/rollback/status` | Knex migration CLI                                                                                 |
| `npm run changeset`                           | Describe a change for the next release (see Releasing)                                             |
| `npm run version-packages`                    | Apply pending changesets locally (bump + changelog) — normally done by the release PR, not by hand |
