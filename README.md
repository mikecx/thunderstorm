<p align="center">
  <img src="assets/banner.png" alt="thunderstorm — TypeScript &amp; JavaScript ORM" width="800">
</p>

<h1 align="center">thunderstorm</h1>

<img src="assets/icon.png" alt="thunderstorm icon" width="72" align="right">

A small ActiveRecord/ActiveModel-style ORM for TypeScript, built on top of [Knex](https://knexjs.org). Models are plain classes; schema, validations, and lifecycle hooks are declared with decorators. `Model` (persisted, ActiveRecord-style) is built on `AttributeModel` (validated and dirty-tracked, but not persisted — ActiveModel-style, usable standalone for form objects and DTOs).

```bash
npm install
npm run demo    # runs migrations against an in-memory DB and exercises every feature below
npm test
```

## Contents

- [Connecting](#connecting)
- [Defining a model](#defining-a-model)
- [AttributeModel: attributes without persistence](#attributemodel-attributes-without-persistence)
- [CRUD](#crud)
- [Mass-assignment protection](#mass-assignment-protection)
- [Convenience methods](#convenience-methods)
- [Serialization](#serialization)
- [Querying](#querying)
- [Validations](#validations)
- [Callbacks](#callbacks)
- [Associations](#associations)
- [Avoiding N+1 queries](#avoiding-n1-queries)
- [Dirty tracking](#dirty-tracking)
- [Attribute casting/serialization](#attribute-castingserialization)
- [Virtual attributes and defaults](#virtual-attributes-and-defaults)
- [Custom accessors/setters](#custom-accessorssetters)
- [Delegate](#delegate)
- [Scopes](#scopes)
- [Timestamps](#timestamps)
- [Enums](#enums)
- [SecurePassword](#securepassword)
- [SecureToken](#securetoken)
- [Transactions](#transactions)
- [Migrations](#migrations)
- [TypeScript typing notes](#typescript-typing-notes)
- [Testing](#testing)
- [Development](#development)

## Connecting

`connect()` takes a Knex instance and stores it as the module-level connection every model uses. Call it once, before touching any model.

```ts
import knexFactory from 'knex';
import { connect } from './src/Model';

const knex = knexFactory({
  client: 'sqlite3', // or 'pg', 'mysql2', ...
  connection: { filename: './dev.sqlite3' },
  useNullAsDefault: true,
});

connect(knex);
```

## Defining a model

```ts
import { Model } from './src/Model';
import { Column, PrimaryKey, Validates } from './src/decorators';

class User extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  @Validates({ presence: true, length: { min: 2, max: 50 } })
  name!: string;

  @Column()
  @Validates({ presence: true })
  @Validates({ format: { with: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }, message: 'is not a valid email address' })
  email!: string;
}
```

- `@Column()` maps a class field to a database column; only columns registered this way are read/written by `save()`.
- `@PrimaryKey()` is `@Column({ primary: true })`. Defaults to `id` if no column is marked primary.
- Each subclass owns its own column/validation/callback metadata — subclassing `Model` again for an unrelated table starts from a clean slate.

## AttributeModel: attributes without persistence

`Model` is two layers: **`AttributeModel`** (attributes, validations, dirty tracking, serialization — no notion of a database) and `Model extends AttributeModel`, which adds persistence, querying, associations, and lifecycle callbacks. This mirrors Rails' ActiveModel/ActiveRecord split.

Extend `AttributeModel` directly for something validated and tracked like a record but that never gets saved — a form object, a search/filter object, an API request DTO:

```ts
import { AttributeModel } from './src/AttributeModel';
import { Column, Validates } from './src/decorators';

class SearchFilter extends AttributeModel {
  @Column()
  @Validates({ presence: true, length: { min: 2 } })
  query!: string;

  @Column({ default: 'relevance' })
  sortBy!: string;
}

const filter = new SearchFilter({ query: 'thunderstorm' });
filter.isValid(); // true — @Column, @Validates, isValid(), errors, changes/isChanged, toJSON() all work
```

No `tableName`, no database connection, and none of `Model`'s persistence surface (`save`, `destroy`, `isPersisted`, `dup`, `reload`, `query`, `find`, `where`) exists on it at all — nothing to accidentally call on something that was never going to be saved.

One consequence of having no `save()`: dirty tracking's snapshot never resets, since nothing ever establishes a new "saved" baseline. `isChanged` stays `true` for as long as any attribute differs from how the instance was originally constructed — there's no clean state to return to the way a persisted record has right after `save()`.

Lifecycle callbacks (`@BeforeSave`/`@AfterCreate`/etc.) stay `Model`-only: they're tied to the save/destroy lifecycle by design (there's no `beforeValidation`/`afterValidation` — see [Callbacks](#callbacks)), so a plain `AttributeModel` gets none of them, matching Rails: `ActiveModel::Callbacks` isn't automatic on a plain object either, you'd have to declare your own callback names.

## CRUD

```ts
const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
user.isPersisted; // true

const found = await User.find(user.id); // undefined if no match
const everyone = await User.all();

found!.email = 'alice@newdomain.com';
await found!.save(); // true, or false if invalid — see Validations

await found!.destroy(); // true, or false if a beforeDestroy callback blocked it
```

`save()` inserts when the record has no primary key yet, updates otherwise — and only sends the columns that actually changed (see [Dirty tracking](#dirty-tracking)).

## Mass-assignment protection

`new Model(attrs)`, `create(attrs)`, and `update(attrs)` are **not** guarded against untrusted input — they're used by trusted internal code too (`dup()`, seed scripts, admin tooling) that legitimately needs to set anything. Passing a web request body straight to them is exactly the mass-assignment vulnerability that motivated Rails' strong parameters (and its pre-2012 CVEs): `User.create(req.body)` sets _any_ declared column, including ones you never meant to expose, e.g. `role`.

`permit()` is the fix — filter untrusted input down to a safe payload before it reaches `create()`/`update()`:

```ts
class User extends Model {
  @Column() name!: string;
  @Column() email!: string;
  @Column({ guarded: true }) role!: string; // never comes through permit(), no matter what
}

// An explicit allowlist, like Rails' params.permit(:name, :email) — the primary
// mechanism. Prefer this at every web boundary over relying on `guarded` alone.
await User.create(User.permit(req.body, ['name', 'email']));

// `guarded` columns are excluded even if you name them explicitly:
User.permit({ name: 'Alice', role: 'admin' }, ['name', 'role']); // => { name: 'Alice' }

// Unknown keys (not a declared @Column() at all) are always dropped too.
```

`permit()` only ever returns declared `@Column()` keys that are also present in the raw input, always excludes the primary key, and always excludes any `@Column({ guarded: true })` field regardless of the allowlist — think of `allowedKeys` as the primary allowlist mechanism (safe by construction: you opt fields in per form/endpoint) and `guarded` as defense in depth on top of it (a blocklist alone isn't enough — it only protects fields you remembered to mark). `guarded` also excludes a column from `serializableHash()`/`toJSON()`'s default output (see [Serialization](#serialization)) — a password digest shouldn't come _from_ untrusted input or go _out_ in a response.

## Convenience methods

```ts
// Assign + save in one call. Same boolean/throwing contract as save()/saveOrFail().
await user.update({ email: 'alice@newdomain.com' }); // false if invalid, doesn't write
await user.updateOrFail({ email: 'alice@newdomain.com' }); // throws RecordInvalid/RecordNotSaved

// Find the first row matching conditions, or create one from conditions + defaults.
// defaults win over conditions on overlapping keys.
const user = await User.firstOrCreate({ email: 'alice@example.com' }, { name: 'Alice' });

// An unpersisted copy of a record's columns, excluding the primary key.
const copy = user.dup();
copy.isPersisted; // false
await copy.save(); // inserts as a new row
```

## Serialization

`toJSON()` returns only declared, non-virtual, non-guarded `@Column()` values (see [Virtual attributes and defaults](#virtual-attributes-and-defaults) and [Mass-assignment protection](#mass-assignment-protection) for what "virtual"/"guarded" mean — a password digest, for instance, should never show up in a default API response) — not `errors`, not any ad-hoc property a preload attached (e.g. `_posts`), not internal bookkeeping. This is what `JSON.stringify(user)` calls automatically:

```ts
JSON.stringify(user); // '{"id":1,"name":"Alice","email":"alice@example.com"}'
```

Without this, `JSON.stringify` walks every own enumerable property, including `errors` and anything `preloadHasMany`/`preloadBelongsTo` attached — which, if both sides of a relation were preloaded (`user._posts[0]._author === user`), is a circular structure that throws.

`toJSON()` is a thin wrapper around `serializableHash()`, which takes `only`/`except`/`include` for finer control — `only`/`except` can only narrow the safe default set further, never resurrect a virtual/guarded column; `include` is the escape hatch for that, pulling in extra own properties (a virtual/guarded column you deliberately want, or a `preloadHasMany`/`preloadBelongsTo` result) and recursively serializing any `Model`/`Model[]` found there:

```ts
user.serializableHash({ except: ['id'] }); // { name: 'Alice', email: '...' }
user.serializableHash({ only: ['name'] }); // { name: 'Alice' }

await User.preloadHasMany([user], Post, { foreignKey: 'userId', as: '_posts' });
user.serializableHash({ include: ['_posts'] }); // { id, name, email, _posts: [{ id, title, ... }, ...] }
```

## Querying

`Model.where()` and `Model.all()` both return a lazy, chainable `QueryChain`. Nothing hits the database until you `await` it or call a terminal method (`.first()`, `.pluck()`, `.count()`, `.exists()`). `all()` is equivalent to `where({})` — every row, but still chainable with `.order()`/`.limit()`, unlike a plain "give me everything" method that just returns an array.

```ts
const bobs = await User.where({ name: 'Bob' });
const newestFirst = await User.all().order('createdAt', 'desc').limit(10);
const one = await User.where({ email: 'alice@example.com' }).first();

const names = await User.all().order('name', 'asc').pluck('name'); // string[] — just this column, no model instances
const activeCount = await User.where({ active: true }).count();
const hasAdmin = await User.where({ role: 'admin' }).exists();
```

`.all()`/`.where()` load every matching row into memory at once. For a table that might not fit — a one-off migration script, an export job — use `findEach`/`findInBatches` instead: both page through the table via primary-key cursor (`WHERE id > lastId ORDER BY id LIMIT batchSize`, not `OFFSET`, which gets slower the deeper you page), one query per batch.

```ts
for await (const user of User.findEach({ batchSize: 500 })) {
  await sendNewsletter(user);
}

for await (const batch of User.findInBatches({ batchSize: 500 })) {
  await bulkUpdateSomewhereElse(batch);
}
```

## Validations

`@Validates({...})` stacks — apply it more than once on the same field to accumulate rules.

```ts
@Column()
@Validates({ presence: true })
@Validates({ length: { min: 2, max: 50 } })
@Validates({ inclusion: { in: ['admin', 'member'] }, allowBlank: true })
@Validates({ validator: (value) => (value < 0 ? 'must not be negative' : null) })
role!: string;
```

Supported keys: `presence`, `length: { min, max }`, `format: { with: RegExp }`, `inclusion: { in: [...] }`, `validator: (value, instance) => string | null | undefined`, `allowBlank` (skip length/format/inclusion when the value is `null`/`undefined`/`''`), and `message` to override the default text.

`uniqueness` is different from every other key above: it needs a database query, so it's the one `Model`-only validation (`AttributeModel` has no table to check against) and it doesn't run from the synchronous `isValid()` — only `save()`/`saveOrFail()` check it, right after the in-memory validations pass:

```ts
@Column()
@Validates({ presence: true })
@Validates({ uniqueness: true })
email!: string;

@Column()
@Validates({ uniqueness: { scope: 'organizationId' }, message: 'is already taken in this organization' })
handle!: string;
```

Updating a record to its own current value doesn't flag itself (excluded by primary key). This is a UX nicety, not a hard guarantee — a concurrent request can still slip a duplicate in between the check and the write (classic TOCTOU); pair it with a real unique index/constraint in the migration for actual correctness under concurrency.

For cross-field checks, override the `validate()` hook:

```ts
class SignupForm extends Model {
  @Column() password!: string;
  @Column({ virtual: true }) passwordConfirmation!: string; // no such DB column — see below

  protected validate(): void {
    if (this.password !== this.passwordConfirmation) {
      this.errors.add('passwordConfirmation', "doesn't match password");
    }
  }
}
```

Checking validity:

```ts
user.isValid(); // runs validations, returns boolean, populates user.errors
user.errors.on('email'); // ["is not a valid email address"]
user.errors.full; // ["email is not a valid email address", ...]
```

`save()` always validates first and returns `false` (without writing) when invalid, rather than throwing. Use `saveOrFail()` when you want an exception instead:

```ts
try {
  await user.saveOrFail();
} catch (err) {
  if (err instanceof RecordInvalid) {
    /* user.errors is populated */
  }
  if (err instanceof RecordNotSaved) {
    /* a before* callback aborted a *valid* record */
  }
}
```

## Callbacks

Eight method decorators cover the save/destroy lifecycle: `@BeforeSave`/`@AfterSave`, `@BeforeCreate`/`@AfterCreate`, `@BeforeUpdate`/`@AfterUpdate`, `@BeforeDestroy`/`@AfterDestroy`. Multiple methods can register for the same hook and run in declaration order.

```ts
class Post extends Model {
  @Column() title!: string;
  @Column() slug!: string;
  @Column() pinned!: number;

  @BeforeCreate()
  generateSlug() {
    this.slug = this.title.toLowerCase().replace(/\s+/g, '-');
  }

  @BeforeDestroy()
  blockDestroyIfPinned() {
    if (this.pinned) return false; // returning false halts the operation
  }
}
```

Order on `save()`: `beforeSave` → `beforeCreate`/`beforeUpdate` → INSERT/UPDATE → `afterCreate`/`afterUpdate` → `afterSave`. On `destroy()`: `beforeDestroy` → DELETE → `afterDestroy`. A `before*` callback that returns (or resolves to) `false` halts the chain — `save()`/`destroy()` return `false` without touching the database, mirroring Rails' `throw :abort`.

`beforeValidation`/`afterValidation` aren't implemented — wiring them up would make `isValid()` async, which would break its current synchronous contract for no clear win in a scaffold like this.

## Associations

Define a plain method on the model that calls `hasMany`/`hasOne`/`belongsTo`. Pass the related class directly — no thunk needed, since the reference is only resolved when the method runs (well after both modules have finished loading), even across circular imports between two model files.

```ts
class User extends Model {
  posts() {
    return this.hasMany(Post, { foreignKey: 'userId' });
  }
}

class Post extends Model {
  author() {
    return this.belongsTo(User, { foreignKey: 'userId' });
  }
}
```

- `hasMany` returns a `QueryChain` — `await user.posts()`, or scope it first: `user.posts().order('title', 'asc').first()`.
- `hasOne`/`belongsTo` return a `Promise` directly — `await post.author()`.

## Avoiding N+1 queries

Looping over records and calling a relation method fires one query per record. `preloadHasMany`/`preloadBelongsTo` batch-fetch in a single `WHERE ... IN (...)` query and attach the results onto each record under a name you choose:

```ts
const users = await User.all();

// naive: 1 query per user
for (const u of users) await u.posts();

// batched: 1 query total
await User.preloadHasMany(users, Post, { foreignKey: 'userId', as: '_posts' });
users[0]._posts; // Post[]

await Post.preloadBelongsTo(posts, User, { foreignKey: 'userId', as: '_author' });
posts[0]._author; // User | undefined
```

Pick an `as` name that doesn't collide with a same-named relation method — it's assigned as a plain own property, which would shadow a prototype method of the same name.

## Dirty tracking

Every model tracks its column values against a snapshot taken on load/save, ActiveModel::Dirty-style:

```ts
const user = await User.find(1);
user.isChanged; // false

user.email = 'new@example.com';
user.isChanged; // true
user.isAttributeChanged('email'); // true
user.changes; // { email: ['old@example.com', 'new@example.com'] }

await user.save();
user.isChanged; // false — reset after a successful save
user.previousChanges; // { email: ['old@example.com', 'new@example.com'] }

user.email = 'discard-me@example.com';
await user.reload(); // re-fetches from the DB, discarding the unsaved change
```

Reassigning a column to its current value doesn't mark it changed (compared with `Object.is`). `save()`'s UPDATE path only writes columns present in `changes` (a partial write) — two in-memory copies of the same row editing different columns can both `save()` without clobbering each other's edit.

## Attribute casting/serialization

`@Column({ type: ... })` converts between the raw DB value and the JS attribute value on load/save. Built-in types: `'string'`, `'number'`, `'boolean'`, `'date'`, `'json'`.

```ts
@Column({ type: 'boolean' }) paid!: boolean;      // sqlite 0/1 <-> real JS boolean
@Column({ type: 'date' }) placedAt!: Date;        // ISO string column <-> real Date instance
@Column({ type: 'json' }) metadata!: Record<string, any>; // JSON text column <-> real object
```

`boolean.save` passes the value through unchanged — Knex's sqlite3 dialect already converts `true`/`false` to `1`/`0` for every param, and Postgres/MySQL drivers accept real booleans natively, so converting here too would only break those dialects.

Dirty tracking (`changes`/`isChanged`) compares `Date` values by timestamp, not by reference, so assigning a new `Date` instance representing the same moment doesn't count as a change.

For anything the built-ins don't cover, pass a custom caster instead of a type name:

```ts
@Column({ type: { load: (raw) => new Decimal(raw), save: (value) => value.toString() } })
price!: Decimal;
```

## Virtual attributes and defaults

`@Column({ virtual: true })` declares an attribute that's tracked, validated, and dirty-tracked exactly like any other column, but is never sent to the database — excluded from `INSERT`/`UPDATE` and from the default `toJSON()`/`serializableHash()` output. Use it for fields that only make sense in memory: password confirmation, a search form's filter params, anything with no backing column.

```ts
class SignupForm extends Model {
  @Column() password!: string;
  @Column({ virtual: true }) passwordConfirmation!: string;
}
```

`@Column({ default: value })` fills in the attribute in the constructor when it's still `undefined` — it never overrides an explicitly-provided value, and never applies to a record loaded from the database (a loaded row's real value, even `NULL`, always wins). Use a function for mutable defaults (objects/arrays): a bare literal default would be the _same_ shared object across every instance that doesn't set it explicitly, so mutating one instance's default would corrupt every other one.

```ts
@Column({ default: 'pending' }) status!: string; // primitives are safe as literals
@Column({ type: 'json', default: () => ({}) }) metadata!: Record<string, any>; // objects need a function
```

## Custom accessors/setters

`@Column()` can decorate a getter/setter pair instead of a plain field — normal TypeScript accessors, no separate framework API needed. Decorate only the first of the pair (a TS requirement for accessors in general):

```ts
class Order extends Model {
  // No initializer on the backing field — see the callout below.
  private _code!: string;

  @Column()
  get code(): string {
    return this._code;
  }
  set code(value: string) {
    this._code = value.trim().toUpperCase();
  }
}

new Order({ code: '  ab-123  ' }).code; // 'AB-123'
```

**Gotcha:** the backing field must _not_ have an initializer (`private _code: string = '';`). `Model`'s constructor sets attributes via `Object.assign(this, attrs)` inside `super(...)`, which runs your setter — but a subclass field _with_ an initializer runs its own initializer **after** `super()` returns, silently resetting the backing field back to `''`. Declare it with a definite assignment assertion (`private _code!: string;`) instead, exactly like every plain `@Column()` field already does.

The setter also runs when loading a row from the database (there's no separate "internal write" path), so keep it idempotent — normalizing an already-normalized value should be a no-op.

## Delegate

`@Delegate(['name', 'email'], { to: 'author' })` on a class with an `author()` relation method generates async `authorName()`/`authorEmail()` methods forwarding through it — equivalent to `(await post.author())?.name`.

```ts
@Delegate(['name'], { to: 'author' })
class Post extends Model {
  author() {
    return this.belongsTo(User, { foreignKey: 'userId' });
  }
}

await post.authorName(); // string | undefined
```

The relation is awaited (associations here are lazy/async, unlike Rails' in-memory objects). The generated method isn't visible to the type checker on its own — see [TypeScript typing notes](#typescript-typing-notes) for how to type it.

## Scopes

A scope is just a static method returning (or extending) `this.where(...)` — no decorator, the same pattern as `hasMany`/`belongsTo`:

```ts
class Post extends Model {
  static published<T extends typeof Post>(this: T) {
    return this.where({ published: 1 } as any);
  }
}

await Post.published(); // Post[]
await Post.published().order('title', 'asc'); // still a QueryChain — chain freely
```

To compose scope-shaped functions together (rather than methods on the same class), `QueryChain` has an `.apply()` combinator:

```ts
const byRecency = (chain: QueryChain<typeof Post>) => chain.order('createdAt', 'desc');
await Post.published()
  .apply(byRecency)
  .apply((c) => c.limit(10));
```

## Timestamps

`Timestamped(Base)` is a mixin — not a decorator — that adds `createdAt`/`updatedAt` as real, statically-typed `Date` properties, auto-stamped via `beforeCreate`/`beforeUpdate` callbacks:

```ts
class Post extends Timestamped(Model) {
  static tableName = 'posts';
  @PrimaryKey() id!: number;
  @Column() title!: string;
}

const post = await Post.create({ title: 'Hello' });
post.createdAt; // Date, set once
post.updatedAt; // Date, bumped on every save
```

It's a mixin rather than `@Timestamps()` specifically so `post.createdAt` type-checks with no extra work — see [TypeScript typing notes](#typescript-typing-notes) for why that matters and how `@Delegate`/`@Enum` differ.

## Enums

`@Enum('status', { draft: 0, published: 1, archived: 2 })` maps a raw column to named labels without touching how the raw column itself is read/written — keep a normal `@Column()` on it. Generates:

```ts
@Enum('status', { draft: 0, published: 1, archived: 2 })
class Post extends Model {
  @Column() status!: number; // still a plain int column
}

post.statusLabel; // 'draft' — a getter over the raw value
post.isDraft(); // true — one is<Label>() predicate per label
Post.withStatus('draft'); // QueryChain<Post> — a static scope, throws on an unknown label
```

## SecurePassword

`SecurePassword(Base)` is a mixin (same pattern as `Timestamped`) mirroring Rails' `has_secure_password`: hardcoded columns `password` (virtual), `passwordConfirmation` (virtual), `passwordDigest` (real, `guarded`), and an `authenticate()` method. Hashed with Node's built-in `scrypt` — no bcrypt dependency.

```ts
class User extends SecurePassword(Model) {
  static tableName = 'users';
  @PrimaryKey() id!: number;
  @Column() email!: string;
}

const user = await User.create({ email: 'alice@example.com', password: 'hunter2' });
user.passwordDigest; // a salted scrypt hash — never the plaintext
await user.authenticate('hunter2'); // true
await user.authenticate('wrong'); // false

await user.update({ email: 'alice@newdomain.com' }); // doesn't touch/re-hash the password
await user.update({ password: 'newpassword' }); // re-hashes; the old password stops working
```

- `password` is required on create; leaving it out on a later `update()` leaves the existing digest alone — dirty tracking (`isAttributeChanged('password')`) is what makes "did this save actually touch the password" answerable, since a virtual attribute like `password` never auto-clears after use.
- If `passwordConfirmation` is set, it must match `password`, or the save fails with a `passwordConfirmation` error.
- `passwordDigest` is `guarded`: it can never come from `permit()`-filtered input, and it's excluded from `serializableHash()`/`toJSON()`'s default output.

## SecureToken

`SecureToken(Base)` generates a random URL-safe `token` column on create if one wasn't provided, plus `regenerateToken()` — mirroring `has_secure_token`. Useful for API keys, invite links, "remember me" tokens.

```ts
class ApiKey extends SecureToken(Model) {
  static tableName = 'api_keys';
  @PrimaryKey() id!: number;
  @Column() label!: string;
}

const key = await ApiKey.create({ label: 'CI' });
key.token; // a random 24-byte, base64url-encoded string

await key.regenerateToken(); // replaces and persists a new token
```

`token` is `guarded`, same reasoning as `passwordDigest` — it's server-generated, never something that should arrive via mass-assigned input or leak into a default API response.

## Transactions

`transaction(fn)` runs `fn` inside a real database transaction. Every `Model` call made anywhere inside it — including in nested async calls — implicitly participates, with **no `trx` parameter to thread through anything**: it's backed by Node's `AsyncLocalStorage`, so `getKnex()` resolves to the active transaction automatically for the lifetime of that async context.

```ts
import { transaction } from './src/Model';

await transaction(async () => {
  alice.balance -= 30;
  await alice.save();
  bob.balance += 30;
  await bob.save();
  // throwing anywhere in here rolls back both writes
});
```

Resolves/commits if `fn` resolves, rejects/rolls back if `fn` throws. `Model.transaction(fn)` is an equivalent static alias. Calling `transaction()` again while already inside one just reuses the same transaction (no savepoints/nested transactions).

## Migrations

Schema lives in `migrations/`, run via the standard Knex CLI (`knexfile.ts` at the project root, `development` and `test` sqlite environments already configured):

```bash
npm run migrate:make -- create_widgets   # scaffold a new migration
npm run migrate:latest                   # apply pending migrations
npm run migrate:rollback                 # roll back the last batch
npm run migrate:status                   # list applied / pending
```

```ts
// migrations/20260724120000_create_users.ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name').notNullable();
    t.string('email').notNullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
}
```

`npm run demo` doesn't touch the file database at all — it points a fresh in-memory connection at the same `migrations/` directory and calls `knex.migrate.latest()` programmatically, so the demo always runs against the real schema without leaving files behind.

## TypeScript typing notes

A few deliberate choices shape how usable the types are for consumers:

- **No blanket index signature.** `Model` does _not_ declare `[key: string]: any`. Internals that need to read/write a column by a runtime string key go through two small module-private helpers (`getAttr`/`setAttr` in `Model.ts`) instead. The payoff: `someUser.naem` (a typo) is a compile error, not a silent `any`.
- **`where()` conditions are typed as `Partial<AttributesOf<InstanceType<T>>>`**, not `Record<string, any>` — `AttributesOf<T>` strips function-valued members (methods, relations) from a model's own declared fields, so `User.where({ name: 'x' })` gets real autocomplete and typo-checking. This is an approximation, not a guarantee: decorator metadata isn't visible to the type system, so it can't distinguish an actual `@Column()` field from an ordinary declared property or getter with the same shape. Full column-accurate typing (what an ORM like Prisma gets) would need a schema→types generation step instead of decorators — out of scope here.
- **`QueryChain` is exported** specifically so you can type a standalone scope-composition function as `(chain: QueryChain<typeof Post>) => ...` (see [Scopes](#scopes)) rather than reaching for `ReturnType<typeof Post.where>`, which resolves to the generic `this: T` constraint (`typeof Model`) rather than `typeof Post` when read outside a call expression.
- **`Timestamped` is a mixin, not a decorator**, specifically so its added properties are real, statically-typed members of the returned class with no extra step. `@Delegate`/`@Enum` remain class decorators because their generated method _names_ depend on runtime string values (attribute lists, label keys) — giving those full static types would need const type parameters and template-literal mapped types, a much bigger lift for less-central features. Their generated members aren't visible to the type checker unless you declare them yourself via interface merging:
  ```ts
  interface Post {
    authorName(): Promise<string | undefined>; // matches @Delegate(['name'], { to: 'author' })
  }
  interface Ticket {
    statusLabel: string; // matches @Enum('status', {...})
    isDraft(): boolean;
  }
  ```
- **Polymorphic `this: T` typing throughout the static API** (`find`, `all`, `where`, `create`, `fromRow`, `preloadHasMany`, ...) means `User.find(1)` already resolves to `Promise<User | undefined>`, not `Promise<Model | undefined>` — this was correct from early on and didn't need changing.

## Testing

Tests use [Vitest](https://vitest.dev) and run against real `sqlite3 :memory:` connections (no mocking) — each test file creates its own tables in `beforeEach`.

```bash
npm test          # run once
npm run test:watch
```

| File                                                     | Covers                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| [src/Model.test.ts](src/Model.test.ts)                   | CRUD, querying                                                                                             |
| [src/validations.test.ts](src/validations.test.ts)       | `@Validates`, `errors`, `save`/`saveOrFail`                                                                |
| [src/callbacks.test.ts](src/callbacks.test.ts)           | lifecycle hooks, halting                                                                                   |
| [src/associations.test.ts](src/associations.test.ts)     | `hasMany`/`hasOne`/`belongsTo`, preload query counts                                                       |
| [src/dirty.test.ts](src/dirty.test.ts)                   | `changes`/`isChanged`/`previousChanges`, partial writes, `reload()`                                        |
| [src/casting.test.ts](src/casting.test.ts)               | built-in casters round-tripping through the DB, custom accessors                                           |
| [src/macros.test.ts](src/macros.test.ts)                 | `Timestamped`, `@Delegate`, `@Enum`, and the metadata-inheritance fix they depend on                       |
| [src/scopes.test.ts](src/scopes.test.ts)                 | static-method scopes, `QueryChain.apply()`                                                                 |
| [src/transactions.test.ts](src/transactions.test.ts)     | commit, rollback, nested reuse                                                                             |
| [src/convenience.test.ts](src/convenience.test.ts)       | `update`/`updateOrFail`/`firstOrCreate`/`dup`/`toJSON`                                                     |
| [src/queries.test.ts](src/queries.test.ts)               | `pluck`/`count`/`exists`, `findEach`/`findInBatches` cursor pagination                                     |
| [src/attributes.test.ts](src/attributes.test.ts)         | virtual attributes, defaults, `serializableHash`                                                           |
| [src/attributeModel.test.ts](src/attributeModel.test.ts) | `AttributeModel` used standalone — no `tableName`, no DB connection, none of `Model`'s persistence surface |
| [src/permit.test.ts](src/permit.test.ts)                 | `permit()` — allowlist/guarded/primary-key filtering, the actual mass-assignment vulnerability it closes   |
| [src/uniqueness.test.ts](src/uniqueness.test.ts)         | `@Validates({ uniqueness })` — self-exclusion on update, scoping, `RecordInvalid` vs `RecordNotSaved`      |
| [src/security.test.ts](src/security.test.ts)             | `SecurePassword`/`SecureToken` mixins, and the `security.ts` hashing/token primitives directly             |

They're the most precise documentation of edge cases — e.g. `associations.test.ts` asserts the exact query count `preloadHasMany` issues via `knex.on('query', ...)`, and `transactions.test.ts` asserts a partially-completed multi-step transfer fully rolls back on failure.

## Development

```bash
npx tsc --noEmit    # type check
npm run lint         # ESLint (npm run lint:fix to auto-fix)
npm run format:check # Prettier (npm run format to auto-fix)
npm run build         # emit dist/ — excludes *.test.ts
npm test
```

All of the above run in CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) on push/PR against Node 20 and 22. `eslint.config.mjs` turns off `@typescript-eslint/no-explicit-any` (this codebase uses `any` deliberately as a controlled escape hatch — see [TypeScript typing notes](#typescript-typing-notes)) and `@typescript-eslint/no-unsafe-declaration-merging` (needed for the `@Delegate`/`@Enum` interface-merging typing pattern documented above).

See [AGENTS.md](AGENTS.md) for the internals-focused guide — architecture, load-bearing design decisions worth knowing before changing `Model.ts`/`decorators.ts`, and testing conventions. This README is the user-facing feature reference; AGENTS.md is about how the codebase is put together.
