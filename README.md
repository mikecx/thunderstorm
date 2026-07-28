<p align="center">
  <img src="assets/banner.png" alt="thunderstorm — TypeScript &amp; JavaScript ORM" width="800">
</p>

<h1 align="center">thunderstorm</h1>

<img src="assets/icon.png" alt="thunderstorm icon" width="72" align="right">

A small ActiveRecord/ActiveModel-style ORM for TypeScript, built on top of [Knex](https://knexjs.org). Models are plain classes; schema, validations, and lifecycle hooks are declared with decorators. `Model` (persisted, ActiveRecord-style) is built on `AttributeModel` (validated and dirty-tracked, but not persisted — ActiveModel-style, usable standalone for form objects and DTOs).

## Installation

```bash
npm install @mikecx/thunderstorm knex
```

`knex` is a peer dependency — bring your own version (3.x) plus whichever DB driver you need (`pg`, `sqlite3`, `mysql2`, ...). See [Connecting](#connecting) below.

Requires **Node 22+**.

`@Column()`/`@Validates()`/etc. are standard TC39 (Stage 3) decorators — the TypeScript 5+ default. Do **not** set `"experimentalDecorators": true` in your own `tsconfig.json`; that opts into the older, incompatible decorator model and these decorators won't work correctly under it. No other special `tsconfig.json` settings are required — plain defaults are fine.

## Contents

### Core

- [Installation](#installation)
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

### Advanced / opt-in features

Collapsed below by default — click a heading to expand it.

- [Many-to-many associations](#many-to-many-associations)
- [Polymorphic associations](#polymorphic-associations)
- [Column encryption](#column-encryption)
- [Custom accessors/setters](#custom-accessorssetters)
- [Delegate](#delegate)
- [Scopes](#scopes)
- [Timestamps](#timestamps)
- [Enums](#enums)
- [SecurePassword](#securepassword)
- [SecureToken](#securetoken)
- [File attachments](#file-attachments)
- [Dependent records on destroy](#dependent-records-on-destroy)
- [Transactions](#transactions)
- [Migrations](#migrations)
- [Escape hatch: raw SQL](#escape-hatch-raw-sql)
- [TypeScript typing notes](#typescript-typing-notes)

### Project

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

When `.where({...})`'s object shape can't express the condition you need — an OR, a raw SQL function — `.whereRaw(sql, bindings)` composes into the same chain instead of making you abandon it:

```ts
const admins = await User.where({ active: true }).whereRaw('role = ? OR role = ?', ['admin', 'owner']);
```

See [Escape hatch: raw SQL](#escape-hatch-raw-sql) for what to reach for when even that isn't enough.

### Bulk operations

`QueryChain` has bulk update/delete methods, matching Rails' `update_all`/`delete_all`/`destroy_all` split:

```ts
await Session.where({ userId: user.id }).updateAll({ revoked: true }); // one UPDATE statement
await Session.where({ userId: user.id }).deleteAll(); // one DELETE statement, no callbacks
await Post.where({ authorId: user.id }).destroyAll(); // destroy() on each record, callbacks run
```

`.updateAll()` issues a single bulk `UPDATE` with the given attributes (cast the same way `where()` casts condition values), no instantiation and no `beforeSave`/`afterSave`/`beforeUpdate`/`afterUpdate` callbacks.

`.deleteAll()` issues a single bulk `DELETE` and skips instantiating records entirely — `beforeDestroy`/`afterDestroy` callbacks never run, so anything they'd do (`@HasManyAttached`'s auto-purge, a `destroy()` override) is skipped too. Use it when the target has no such side effects to preserve and you want one query instead of N — e.g. invalidating a user's sessions on password change.

`.destroyAll()` loads every matching row and calls `destroy()` on each in turn, so callbacks run exactly as if you'd called `destroy()` on each individually — this just saves writing the loop. All three return the count affected, not the count matched — for `.destroyAll()` those can differ if a `beforeDestroy` callback blocks some of them.

On the create side, `Model.insertAll()` is the bulk counterpart to `create()`:

```ts
await Session.insertAll([
  { userId: 1, token: 'a', expiresAt },
  { userId: 2, token: 'b', expiresAt },
]); // one INSERT statement
```

Like `deleteAll()`, this skips instantiation entirely — no defaults, no validations, and no `beforeSave`/`beforeCreate`/`afterCreate` callbacks run, so anything a model relies on one of those for (`Timestamped`'s `createdAt`/`updatedAt`, `SecureToken`'s token generation, `SecurePassword`'s hashing) must be supplied directly in each row. This makes it a good fit for callback-light models — bulk-seeding, imports — not a drop-in replacement for looping `create()`. Each row's values still pass through the same column casting as `create()`/`where()`, so a caster-backed column (`json`, `encryptedCaster`) is written correctly. Returns the number of rows given, not a driver-reported count — unlike update/delete, a bulk insert either fully succeeds or throws.

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

See [Many-to-many associations](#many-to-many-associations) and [Polymorphic associations](#polymorphic-associations) below for the less-common shapes.

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

Pick an `as` name that doesn't collide with a same-named relation method — it's assigned as a plain own property, which would shadow a prototype method of the same name. The many-to-many and polymorphic association sections below have their own `preload*` equivalents.

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

See [Column encryption](#column-encryption) below for a real-world custom caster.

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

<details>
<summary>

## Many-to-many associations

</summary>

Two ways to model many-to-many, matching Rails' own distinction. Both stay lazy/chainable like `hasMany` — one query with a `WHERE targetPk IN (subquery)`, not two sequential round-trips.

**`hasManyThrough`** — the join table is a real `Model`, so it can carry its own columns, and adding/removing a row is just ordinary `create()`/`destroy()`:

```ts
class PostTag extends Model {
  static tableName = 'postTags';
  @PrimaryKey() id!: number;
  @Column() postId!: number;
  @Column() tagId!: number;
}

class Post extends Model {
  tags() {
    return this.hasManyThrough(Tag, PostTag, { sourceKey: 'postId', targetKey: 'tagId' });
  }
}

await PostTag.create({ postId: post.id, tagId: tag.id }); // associate
await post.tags(); // Tag[]
await join.destroy(); // dissociate
```

**`hasAndBelongsToMany`** — a bare join table, no `Model` needed, at the cost of nowhere to put extra columns later. Since there's no `create()`/`destroy()` to call on a nonexistent model, pair it with `associate`/`dissociate`:

```ts
class Post extends Model {
  favoriteTags() {
    return this.hasAndBelongsToMany(Tag, { joinTable: 'postsFavoriteTags', sourceKey: 'postId', targetKey: 'tagId' });
  }
  addFavoriteTag(tag: Tag) {
    return this.associate(Tag, { joinTable: 'postsFavoriteTags', sourceKey: 'postId', targetKey: 'tagId' }, tag);
  }
  removeFavoriteTag(tag: Tag) {
    return this.dissociate(Tag, { joinTable: 'postsFavoriteTags', sourceKey: 'postId', targetKey: 'tagId' }, tag);
  }
}

await post.addFavoriteTag(tag);
await post.favoriteTags(); // Tag[]
await post.removeFavoriteTag(tag);
```

Neither guards against inserting the same pair twice — pair with a unique index on `(sourceKey, targetKey)` in the migration for that, same as `@Validates({ uniqueness })` elsewhere in this library is a UX nicety, not a concurrency guarantee.

`preloadHasManyThrough`/`preloadHasAndBelongsToMany` batch like `preloadHasMany` — see [Avoiding N+1 queries](#avoiding-n1-queries):

```ts
await Post.preloadHasManyThrough(posts, Tag, PostTag, { sourceKey: 'postId', targetKey: 'tagId', as: '_tags' });
await Post.preloadHasAndBelongsToMany(posts, Tag, {
  joinTable: 'postsFavoriteTags',
  sourceKey: 'postId',
  targetKey: 'tagId',
  as: '_favoriteTags',
});
```

</details>

<details>
<summary>

## Polymorphic associations

</summary>

A record can `belongsTo` one of several possible target types (Rails' `belongs_to :commentable, polymorphic: true`) by pairing an id column with a type column:

```ts
const COMMENTABLE_TYPES = { post: Post, photo: Photo }; // stable strings you choose, mapped to the classes they mean

class Comment extends Model {
  static tableName = 'comments';
  @PrimaryKey() id!: number;
  @Column() commentableId!: number;
  @Column() commentableType!: string;

  commentable() {
    return this.belongsToPolymorphic({ idField: 'commentableId', typeField: 'commentableType' }, COMMENTABLE_TYPES);
  }
}

class Post extends Model {
  comments() {
    return this.hasManyPolymorphic(Comment, {
      idField: 'commentableId',
      typeField: 'commentableType',
      typeValue: 'post',
    });
  }
}
```

Unlike Rails' default of using the class name as the type string (`commentable_type = 'Post'`), thunderstorm requires an explicit map (`COMMENTABLE_TYPES` above) — consistent with `tableName`/`foreignKey` always being explicit elsewhere in this library, and it means renaming a model class can never silently orphan every row that already references it under the old name.

- `belongsToPolymorphic` resolves to the right target class based on the type column's value, or `undefined` if the type string isn't in the map (an unrecognized/legacy type) or the id is `null`.
- `hasManyPolymorphic`/`hasOnePolymorphic` are the reverse side — same shape as `hasMany`/`hasOne`, plus a `typeValue` that must also match, so a comment on a `Photo` with the same numeric id as a `Post` never leaks in.
- `preloadHasManyPolymorphic` batches like `preloadHasMany` (one query). `preloadBelongsToPolymorphic` can't stay to one query the way `preloadBelongsTo` does — since different records may reference different target tables, it groups by the type column first and runs one batched query per distinct type actually present, still bounded rather than one query per record:

```ts
await Post.preloadHasManyPolymorphic(posts, Comment, {
  idField: 'commentableId',
  typeField: 'commentableType',
  typeValue: 'post',
  as: '_comments',
});
await Comment.preloadBelongsToPolymorphic(comments, {
  idField: 'commentableId',
  typeField: 'commentableType',
  types: COMMENTABLE_TYPES,
  as: '_commentable',
});
```

</details>

<details>
<summary>

## Column encryption

</summary>

`encryptedCaster()` is exactly that kind of custom caster — there's no separate decorator for encryption, just `@Column({ type: encryptedCaster({ keys: [key] }) })`. AES-256-GCM via Node's built-in `crypto`, no external dependency:

```ts
import { encryptedCaster } from '@mikecx/thunderstorm';

const key = Buffer.from(process.env.ENCRYPTION_KEY!, 'base64'); // exactly 32 bytes

class Patient extends Model {
  static tableName = 'patients';
  @PrimaryKey() id!: number;

  @Column({ type: encryptedCaster({ keys: [key] }) })
  diagnosis!: string; // non-deterministic (default): safest, but not queryable at all

  @Column({ type: encryptedCaster({ keys: [key], deterministic: true }) })
  @Validates({ uniqueness: true })
  ssn!: string; // deterministic: same plaintext -> same ciphertext, so where()/uniqueness still work
}

await Patient.where({ ssn: '111-11-1111' }); // matches — deterministic columns are queryable
await Patient.where({ diagnosis: 'flu' }); // never matches — non-deterministic ciphertext differs every write
```

**Deterministic vs. non-deterministic** is the one real choice: deterministic encryption keeps a column queryable (`where()`, `@Validates({ uniqueness })`) because the same plaintext always produces the same ciphertext under a given key — at the cost of leaking equality: anyone who can read ciphertexts can tell which rows share a value, and on low-cardinality data (a small enumerable set of possible plaintexts) can guess values by comparing against ciphertexts they've computed themselves. Non-deterministic encryption (the default) uses a random IV per write, so identical plaintexts produce different ciphertext every time — safer, but genuinely unqueryable; there's no way to `where()` against it.

**Key rotation**: `keys` is a list, tried in order on decrypt — put the new key first (used for all new writes) and keep old keys after it so existing rows still decrypt:

```ts
encryptedCaster({ keys: [newKey, oldKey] });
```

Rotation isn't automatic re-encryption, though — reading and re-saving the _same_ value won't rewrite it, since dirty tracking only sends columns whose JS-level value actually changed. Migrating existing rows off an old key needs to force the write (e.g. a script that reads, then writes back a value dirty tracking will actually notice as changed, or a raw `UPDATE`).

</details>

<details>
<summary>

## Custom accessors/setters

</summary>

`@Column()` can decorate a getter/setter pair instead of a plain field — normal TypeScript accessors, no separate framework API needed. Decorate only the first of the pair (a TS requirement for accessors in general):

```ts
class Order extends Model {
  // `declare`d, not a real field — see the callout below.
  declare private _code: string;

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

**Gotcha:** the backing field must be declared with `declare` (`declare private _code: string;`), not as a real field — including with a definite assignment assertion (`private _code!: string;`). `Model`'s constructor sets attributes via `Object.assign(this, attrs)` inside `super(...)`, which runs your setter — but TC39 decorators require standards-compliant class-fields semantics, so once _any_ field in the class is decorated, every ordinary field declaration (even one with no initializer) gets an implicit `this._code = undefined` inserted right after `super()` returns, silently clobbering whatever the setter just wrote. `declare` tells TypeScript the property exists without emitting any field-initialization code for it, sidestepping the issue entirely.

The setter also runs when loading a row from the database (there's no separate "internal write" path), so keep it idempotent — normalizing an already-normalized value should be a no-op.

</details>

<details>
<summary>

## Delegate

</summary>

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

</details>

<details>
<summary>

## Scopes

</summary>

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

</details>

<details>
<summary>

## Timestamps

</summary>

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

</details>

<details>
<summary>

## Enums

</summary>

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

</details>

<details>
<summary>

## SecurePassword

</summary>

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

</details>

<details>
<summary>

## SecureToken

</summary>

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

</details>

<details>
<summary>

## File attachments

</summary>

Attach files to a record without thunderstorm ever touching the actual bytes: it persists blob metadata (key, filename, content type, byte size) and orchestrates two functions you provide — `put`/`delete` — so key generation and storage cleanup are guaranteed, not opt-in caller discipline.

```ts
export interface BlobStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}
```

`BlobStorage` is deliberately not a full "storage service" — no `get`, no `url`, no variants. Serving a file back out (signed URLs, a CDN path, a static file route) is a deployment-specific, controller-shaped concern that stays entirely yours; thunderstorm only guarantees the bytes get written when you attach and deleted when you purge/destroy.

### `@HasOneAttached` — one file per record

```ts
import { Model, HasOneAttached, PrimaryKey, Column } from '@mikecx/thunderstorm';

const avatarStorage: BlobStorage = {
  put: (key, data, contentType) =>
    s3
      .send(new PutObjectCommand({ Bucket: 'my-bucket', Key: key, Body: data, ContentType: contentType }))
      .then(() => {}),
  delete: (key) => s3.send(new DeleteObjectCommand({ Bucket: 'my-bucket', Key: key })).then(() => {}),
};

@HasOneAttached('avatar', avatarStorage)
class User extends Model {
  static tableName = 'users';
  @PrimaryKey() id!: number;
  @Column() email!: string;
}

interface User {
  avatarKey: string | null;
  avatarFilename: string | null;
  avatarContentType: string | null;
  avatarByteSize: number | null;
  readonly avatarAttached: boolean;
  attachAvatar(data: Buffer, meta: { filename: string; contentType: string }): Promise<void>;
  purgeAvatar(): Promise<void>;
}

await user.attachAvatar(req.file.buffer, { filename: req.file.originalname, contentType: req.file.mimetype });
user.avatarAttached; // true
await user.destroy(); // avatar's blob is deleted automatically — no manual purge() needed
```

`storage` is required, not optional — a model can't be decorated without a way to clean up after itself. Add the migration with `attachmentColumns()`, which keeps the column names in lockstep with what `@HasOneAttached` reads at runtime instead of hand-typed boilerplate that could drift:

```ts
import type { Knex } from 'knex';
import { attachmentColumns } from '@mikecx/thunderstorm';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => attachmentColumns(t, 'avatar'));
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (t) => {
    t.dropColumn('avatarKey');
    t.dropColumn('avatarFilename');
    t.dropColumn('avatarContentType');
    t.dropColumn('avatarByteSize');
  });
}
```

Like `@Delegate`/`@Enum`, the generated members (`avatarKey`, `attachAvatar`, ...) come from the runtime `'avatar'` string, so they're not visible to the type checker on their own — declare them via interface merging as shown above.

### `@HasManyAttached` — multiple files per record

Unlike Rails' polymorphic `active_storage_attachments`, this is a real, ordinary `@Column()`-backed table with a real foreign key — thunderstorm has no polymorphic associations, so each attachment point gets its own table, defined the same way any other model is:

```ts
class PostImage extends Model {
  static tableName = 'postImages';
  @PrimaryKey() id!: number;
  @Column() postId!: number;
  @Column() key!: string;
  @Column() filename!: string;
  @Column() contentType!: string;
  @Column() byteSize!: number;
}

@HasManyAttached('images', PostImage, { foreignKey: 'postId' }, imageStorage)
class Post extends Model {
  static tableName = 'posts';
  @PrimaryKey() id!: number;
  @Column() title!: string;
}

interface Post {
  images(): Promise<PostImage[]>;
  attachImages(data: Buffer, meta: { filename: string; contentType: string }): Promise<PostImage>;
  purgeImages(): Promise<void>;
}

const image = await post.attachImages(buffer, { filename: 'cover.png', contentType: 'image/png' });
for (const image of await post.images()) {
  /* ... */
}
await post.destroy(); // every attached image's blob is deleted automatically
```

`images()` is just `this.hasMany(PostImage, { foreignKey: 'postId' })` under the hood — only the storage orchestration is new, not the association. Member names are used exactly as given (no pluralization/singularization guessing) — `HasManyAttached('images', ...)` gives you `attachImages`/`purgeImages`, matching `@Enum`'s existing convention of deriving names directly from the literal string rather than guessing grammar.

The table itself is created with `createAttachmentTable()`, same lockstep-with-the-decorator reasoning as `attachmentColumns()` above:

```ts
import { createAttachmentTable } from '@mikecx/thunderstorm';

export async function up(knex: Knex): Promise<void> {
  await createAttachmentTable(knex, 'postImages', { foreignKey: 'postId' });
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('postImages');
}
```

### What this doesn't do

- No image variants/thumbnails, no direct-upload tokens, no signed-URL helpers — bring your own (`sharp`, your storage SDK's presigner).
- **Gotcha:** if `storage.put` succeeds but the following database write then fails (a validation error, a dropped connection), `attachAvatar`/`attachImages` best-effort calls `storage.delete` on the now-orphaned key — but a delete failure there won't mask the original save error, so a narrow leak window remains under storage flakiness at exactly the wrong moment.
- Destroy-time cleanup is synchronous and best-effort, not transactional: there's no job queue backing it, so a `storage.delete` failure during `destroy()` makes the whole call reject even though the database row is already gone — you'll see the error and know to retry cleanup, it won't silently leak.
- Buffers only, no streaming — the whole file needs to be in memory to compute `byteSize`, unlike Rails' IO-stream-based blobs. Fine for avatars/typical uploads, not huge files.

</details>

<details>
<summary>

## Dependent records on destroy

</summary>

By default, destroying a record does nothing to whatever references it — `post.destroy()` leaves any `Comment` rows with a now-dangling `postId`. `@Dependent(associationMethod, action)` wires that up, Rails' `dependent:` option:

```ts
class Post extends Model {
  static tableName = 'posts';

  comments() {
    return this.hasMany(Comment, { foreignKey: 'postId' });
  }
}

@Dependent('comments', 'destroy')
class PostWithComments extends Post {}
```

It's a class decorator naming an already-defined association _method_, not a parameter on `hasMany`/`hasOne` themselves — those are plain per-call methods in this library, not a persistent association registry a decorator param could hook into (see [Associations](#associations)). The association is declared exactly as it always is; `@Dependent` just registers `beforeDestroy`/`afterDestroy` callbacks that call it.

Four actions, applying to both `hasMany`-shaped associations (`hasMany`/`hasManyThrough`/`hasAndBelongsToMany`, detected at runtime by the association method's return value having `.destroyAll`) and single-record ones (`hasOne`/`belongsTo`):

```ts
@Dependent('comments', 'destroy') // destroy() on each — its own callbacks run too
@Dependent('sessions', 'delete') // bulk DELETE, no callbacks
@Dependent('comments', { update: { postId: null } }) // bulk UPDATE — nullify the foreign key
@Dependent('orders', 'restrict') // block the destroy if any order still exists
class Post extends Model {
  /* ... */
}
```

- `'destroy'` — full `destroy()` lifecycle per related record, including e.g. `@HasManyAttached`'s own purge if the target has one.
- `'delete'` — bulk `DELETE` (`deleteAll()` for a chain; a single scoped `DELETE` for one record) — no callbacks either way, which is the point, not just fewer queries.
- `{ update: {...} }` — bulk `UPDATE` (`updateAll()` for a chain, `update()` for one record) — the common case is nullifying a foreign key rather than deleting the related rows at all.
- `'restrict'` — a `beforeDestroy` check: if the association still has anything, the destroy is blocked (returns `false`) and nothing is touched.

Stack multiple `@Dependent`s on the same class for different associations. There's no DB-level foreign-key cascade here — if you also add a real `ON DELETE CASCADE`/`SET NULL` constraint in a migration, Postgres will additionally enforce it at the schema level, but won't run any thunderstorm callbacks when it fires.

</details>

<details>
<summary>

## Transactions

</summary>

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

</details>

<details>
<summary>

## Migrations

</summary>

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

</details>

<details>
<summary>

## Escape hatch: raw SQL

</summary>

Every layer here is designed so you're never actually stuck: `.whereRaw()` (above) handles the common case — an arbitrary condition mid-chain — but when a `Model` or `QueryChain` abstraction genuinely can't express what you need at all, drop to Knex directly. `getKnex()` returns the active connection (or the active transaction, if you're inside one — see [Transactions](#transactions)); `Model.query()` returns the same builder already scoped to that model's table:

```ts
import { getKnex } from './src/Model';

// Anything Knex can do: joins, subqueries, CTEs, window functions, unions, aggregates...
const rows = await getKnex()('users').join('posts', 'posts.userId', 'users.id').groupBy('users.id');

// Scoped to a specific model's table:
const rows2 = await User.query().whereRaw('lower(email) = ?', [email.toLowerCase()]);

// Fully raw SQL — hydrate the rows back into real Model instances with fromRow():
const raw = await getKnex().raw('SELECT * FROM users WHERE id = ANY(?)', [[1, 2, 3]]);
const users = (raw.rows ?? raw).map((row: any) => User.fromRow(row));
```

That last one is the case actually worth calling out: `knex.raw()`'s result shape is **driver-dependent** — sqlite3 resolves directly to an array of rows, Postgres resolves to a full result object with the rows under `.rows` (plus `.rowCount` etc.), MySQL differs again. `raw.rows ?? raw` above is a cheap way to handle both the array and `{ rows }` shapes, but check what your actual driver returns rather than trusting that blindly. Query builder methods (`.select()`, `.where()`, `.whereRaw()`, `Model.query()`, `QueryChain`) don't have this problem — Knex normalizes those across dialects; it's specifically `.raw()`'s return value that isn't normalized.

This is deliberately not hidden or discouraged — Knex is a mature, fully public, actively maintained SQL builder (unlike Arel, which the Rails core team has said isn't a stable public API in modern Rails). There's no ceiling here: if `Model`/`QueryChain` can't do it, Knex almost certainly can, and it's one function call away.

</details>

<details>
<summary>

## TypeScript typing notes

</summary>

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

</details>

## Testing

Tests use [Vitest](https://vitest.dev) and run against real `sqlite3 :memory:` connections (no mocking) — each test file creates its own tables in `beforeEach`.

```bash
npm test          # run once
npm run test:watch
```

| File                                                     | Covers                                                                                                                                                        |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [src/Model.test.ts](src/Model.test.ts)                   | CRUD, querying                                                                                                                                                |
| [src/validations.test.ts](src/validations.test.ts)       | `@Validates`, `errors`, `save`/`saveOrFail`                                                                                                                   |
| [src/callbacks.test.ts](src/callbacks.test.ts)           | lifecycle hooks, halting                                                                                                                                      |
| [src/associations.test.ts](src/associations.test.ts)     | `hasMany`/`hasOne`/`belongsTo`, `hasManyThrough`/`hasAndBelongsToMany`, `belongsToPolymorphic`/`hasManyPolymorphic`/`hasOnePolymorphic`, preload query counts |
| [src/dirty.test.ts](src/dirty.test.ts)                   | `changes`/`isChanged`/`previousChanges`, partial writes, `reload()`                                                                                           |
| [src/casting.test.ts](src/casting.test.ts)               | built-in casters round-tripping through the DB, custom accessors, `where()` casting condition values                                                          |
| [src/encryption.test.ts](src/encryption.test.ts)         | `encryptedCaster()` — deterministic vs. non-deterministic, queryability, uniqueness, key rotation, wrong-key errors                                           |
| [src/macros.test.ts](src/macros.test.ts)                 | `Timestamped`, `@Delegate`, `@Enum`, and the metadata-inheritance fix they depend on                                                                          |
| [src/scopes.test.ts](src/scopes.test.ts)                 | static-method scopes, `QueryChain.apply()`                                                                                                                    |
| [src/transactions.test.ts](src/transactions.test.ts)     | commit, rollback, nested reuse                                                                                                                                |
| [src/convenience.test.ts](src/convenience.test.ts)       | `update`/`updateOrFail`/`firstOrCreate`/`dup`/`toJSON`                                                                                                        |
| [src/queries.test.ts](src/queries.test.ts)               | `pluck`/`count`/`exists`, `findEach`/`findInBatches` cursor pagination, `whereRaw` composability                                                              |
| [src/attributes.test.ts](src/attributes.test.ts)         | virtual attributes, defaults, `serializableHash`                                                                                                              |
| [src/attributeModel.test.ts](src/attributeModel.test.ts) | `AttributeModel` used standalone — no `tableName`, no DB connection, none of `Model`'s persistence surface                                                    |
| [src/permit.test.ts](src/permit.test.ts)                 | `permit()` — allowlist/guarded/primary-key filtering, the actual mass-assignment vulnerability it closes                                                      |
| [src/uniqueness.test.ts](src/uniqueness.test.ts)         | `@Validates({ uniqueness })` — self-exclusion on update, scoping, `RecordInvalid` vs `RecordNotSaved`                                                         |
| [src/security.test.ts](src/security.test.ts)             | `SecurePassword`/`SecureToken` mixins, and the `security.ts` hashing/token primitives directly                                                                |
| [src/attachments.test.ts](src/attachments.test.ts)       | `@HasOneAttached`/`@HasManyAttached` — key generation, reattach/purge/destroy cleanup, orphaned-blob cleanup on save failure                                  |

They're the most precise documentation of edge cases — e.g. `associations.test.ts` asserts the exact query count `preloadHasMany` issues via `knex.on('query', ...)`, and `transactions.test.ts` asserts a partially-completed multi-step transfer fully rolls back on failure.

## Development

```bash
git clone git@github.com:mikecx/thunderstorm.git
cd thunderstorm
npm install
npm run demo    # runs migrations against an in-memory DB and exercises every feature above
```

```bash
npx tsc --noEmit    # type check
npm run lint         # ESLint (npm run lint:fix to auto-fix)
npm run format:check # Prettier (npm run format to auto-fix)
npm run build         # emit dist/ — excludes *.test.ts
npm test
```

All of the above run in CI ([.github/workflows/ci.yml](.github/workflows/ci.yml)) on push/PR against Node 22 and 24 (the two currently-supported LTS lines — see `engines.node` in `package.json`). `eslint.config.mjs` turns off `@typescript-eslint/no-explicit-any` (this codebase uses `any` deliberately as a controlled escape hatch — see [TypeScript typing notes](#typescript-typing-notes)) and `@typescript-eslint/no-unsafe-declaration-merging` (needed for the `@Delegate`/`@Enum` interface-merging typing pattern documented above).

See [AGENTS.md](AGENTS.md) for the internals-focused guide — architecture, load-bearing design decisions worth knowing before changing `Model.ts`/`decorators.ts`, and testing conventions. This README is the user-facing feature reference; AGENTS.md is about how the codebase is put together.
