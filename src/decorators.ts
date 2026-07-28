import type { Knex } from 'knex';
import type { Caster, ColumnType } from './casters';
import type { Model } from './Model';
import { generateToken, hashPassword, verifyPassword } from './security';

// Node has no native `Symbol.metadata` yet, and TypeScript's decorator
// helpers silently no-op `context.metadata` without it (see __esDecorate in
// the compiled output) — this polyfill must run before any decorated class
// is evaluated, so it lives at the top of the one module every decorator is
// imported from.
(Symbol as unknown as { metadata: symbol }).metadata ??= Symbol.for('Symbol.metadata');

export interface ColumnOptions {
  primary?: boolean;
  /** Converts between the raw DB value and the JS attribute value on load/save. See src/casters.ts. */
  type?: ColumnType | Caster;
  /** Tracked, validated, and dirty-tracked like any column, but never sent to the database (excluded from INSERT/UPDATE and default serialization). */
  virtual?: boolean;
  /**
   * Applied in the constructor when the attribute is still undefined. Use a
   * function for mutable values (objects/arrays) — a bare literal default
   * would be the same shared reference across every instance that doesn't
   * set it explicitly, so mutating one instance's default would corrupt all
   * the others. Primitives (strings/numbers/booleans) are safe as literals.
   */
  default?: any | (() => any);
  /**
   * Two-way protection for a column that should never move through an
   * untrusted boundary in either direction — an admin flag, a role, a
   * password digest: excluded from `permit()`'s output regardless of an
   * allowlist passed to it (so it can never come *from* mass-assigned
   * input), and excluded from `serializableHash()`/`toJSON()`'s default
   * output (so it never goes *out* in an API response either). The primary
   * key is always excluded from `permit()` too, whether or not it's marked
   * here.
   */
  guarded?: boolean;
  /**
   * Written on create, then excluded from every subsequent `save()`'s
   * `UPDATE` — mirrors Rails' `attr_readonly`. This is *not* a hard runtime
   * guard: the attribute can still be assigned in JS and still shows up in
   * `changes`/`isChanged` like any other dirty-tracked column, it's just
   * silently left out of the SQL sent to the database once the record is
   * persisted. Same shape as `guarded` — a column-metadata flag excluding
   * the column from one specific operation, not a thrown error.
   */
  readonly?: boolean;
}

export const COLUMNS = Symbol('columns');

type FieldOrAccessorContext = ClassFieldDecoratorContext | ClassGetterDecoratorContext | ClassSetterDecoratorContext;

/**
 * Fields need one extra step accessors don't: TypeScript always emits an
 * unconditional `this.field = <initializer result>` right after `super()`
 * for any decorated field, even when the decorator itself has nothing to
 * contribute — which would silently stomp whatever `Object.assign(this,
 * attrs)` (in AttributeModel's constructor, which runs first) had already
 * set. Returning this from a field-kind decorator re-affirms whatever value
 * is already on the instance by the time it runs (set by `Object.assign` or
 * by AttributeModel's default-application loop, both of which complete
 * before any subclass's own field initializers do) instead of discarding
 * it. Getter/setter-kind decorations never trigger that reassignment, so
 * they don't need this.
 */
function preserveFieldValue(context: FieldOrAccessorContext): ((this: any) => any) | void {
  if (context.kind !== 'field') return undefined;
  const name = context.name as string;
  return function (this: any) {
    return this[name];
  };
}

/**
 * Marks a class field (or a getter/setter pair — decorate only the getter,
 * see README's "Custom accessors/setters") as a mapped database column.
 * Metadata is stored per-constructor (not inherited) so each Model subclass
 * owns its own column set.
 */
export function Column(options: ColumnOptions = {}) {
  return function (_value: any, context: FieldOrAccessorContext) {
    ownColumns(context.metadata).set(context.name as string, options);
    return preserveFieldValue(context);
  };
}

export function PrimaryKey() {
  return Column({ primary: true });
}

export interface ValidationRule {
  presence?: boolean;
  length?: { min?: number; max?: number };
  format?: { with: RegExp };
  inclusion?: { in: readonly any[] };
  /** Custom check; return an error message string to fail, or null/undefined to pass. */
  validator?: (value: any, instance: any) => string | null | undefined | void;
  /** Skip length/format/inclusion checks when the value is null/undefined/''. */
  allowBlank?: boolean;
  /** Overrides the default message for this rule. */
  message?: string;
  /**
   * Checked against the database, not in memory — unlike every other rule
   * here, this only runs as part of `Model.save()` (see Model.ts), never
   * from the synchronous `isValid()`, since it needs a query. A `Model`-only
   * feature: `AttributeModel` has no table to check against, so this key is
   * silently ignored there. `scope` restricts the uniqueness check to rows
   * that also match the named column(s) — e.g. unique per account, not
   * globally. This is a UX nicety, not a hard guarantee: a concurrent
   * request can still slip a duplicate in between the check and the write
   * (classic TOCTOU) — pair it with a real unique index/constraint in the
   * migration for actual correctness under concurrency.
   */
  uniqueness?: boolean | { scope?: string | string[] };
}

export const VALIDATIONS = Symbol('validations');

/**
 * Declares a validation rule for an attribute — a plain field, or one not
 * backed by a `@Column()` at all (an `AttributeModel` field that's checked
 * but never persisted). Stacks: applying @Validates more than once on the
 * same field (or to different fields) accumulates rules, mirroring Rails'
 * repeated `validates :attr, ...` calls.
 */
export function Validates(rule: ValidationRule) {
  return function (_value: any, context: FieldOrAccessorContext) {
    ownValidationList(context.metadata, context.name as string).push(rule);
    return preserveFieldValue(context);
  };
}

export type CallbackType =
  | 'beforeSave'
  | 'afterSave'
  | 'beforeCreate'
  | 'afterCreate'
  | 'beforeUpdate'
  | 'afterUpdate'
  | 'beforeDestroy'
  | 'afterDestroy';

export const CALLBACKS = Symbol('callbacks');

/**
 * Registers an instance method to run at a point in the save/destroy
 * lifecycle. A before* callback that returns (or resolves to) `false` halts
 * the operation, mirroring Rails' `throw :abort` convention.
 */
function registerCallback(type: CallbackType) {
  return function (_value: (...args: any[]) => any, context: ClassMethodDecoratorContext): void {
    ownCallbackList(context.metadata, type).push(context.name as string);
  };
}

export const BeforeSave = () => registerCallback('beforeSave');
export const AfterSave = () => registerCallback('afterSave');
export const BeforeCreate = () => registerCallback('beforeCreate');
export const AfterCreate = () => registerCallback('afterCreate');
export const BeforeUpdate = () => registerCallback('beforeUpdate');
export const AfterUpdate = () => registerCallback('afterUpdate');
export const BeforeDestroy = () => registerCallback('beforeDestroy');
export const AfterDestroy = () => registerCallback('afterDestroy');

export type ScopeFn = (qb: Knex.QueryBuilder) => Knex.QueryBuilder;

export const DEFAULT_SCOPES = Symbol('defaultScopes');

/**
 * Registers a query modifier that's automatically applied to every read —
 * `find`/`all`/`where`/`findInBatches`/associations/preloads — unless the
 * caller opts out via `Model.unscoped()`. Stacks (ANDed together) like
 * `@Validates`, and inherits-then-accumulates down subclasses the same way
 * `@Column`/`@Validates` do (see `ownMetadataMap`), so a subclass can add its
 * own `@DefaultScope` on top of an inherited one without losing it.
 *
 * Deliberately only reaches the read paths, not `save()`/`destroy()`'s own
 * queries — those already target a specific loaded record by primary key, so
 * scoping them the same way `all()`/`where()` are risks silently blocking a
 * write on a record the caller explicitly holds a reference to (see
 * `SoftDelete`'s `restore()`, which needs to reach an already-excluded row).
 */
export function DefaultScope(scope: ScopeFn) {
  return function (_target: any, context: ClassDecoratorContext): void {
    ownDefaultScopes(context.metadata).push(scope);
  };
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

/**
 * Returns `metadata`'s own map for `symbolKey`, creating one on first use.
 * `metadata` is a class's `[Symbol.metadata]` object — the engine parents a
 * subclass's own metadata object to its ancestor's automatically (mirroring
 * the prototype chain), so an ordinary property lookup already sees
 * inherited entries. But when `metadata` doesn't own a map for `symbolKey`
 * yet and an ancestor does (e.g. a `Timestamped(Model)` mixin registering
 * columns/callbacks, then a further subclass adding its own `@Column()`),
 * the new map is seeded with cloned copies of the inherited entries — a
 * shallow `Map` copy alone would share the same array *values*, so a
 * subclass's `.push()` would silently mutate its ancestor's list too.
 */
function ownMetadataMap<K, V>(metadata: DecoratorMetadata, symbolKey: symbol, cloneValue: (v: V) => V): Map<K, V> {
  if (!Object.hasOwn(metadata, symbolKey)) {
    const inherited: Map<K, V> | undefined = (metadata as any)[symbolKey];
    const fresh = new Map<K, V>();
    if (inherited) {
      for (const [key, value] of inherited) fresh.set(key, cloneValue(value));
    }
    (metadata as any)[symbolKey] = fresh;
  }
  return (metadata as any)[symbolKey];
}

/**
 * Exported (unlike the rest of this metadata plumbing) so other in-package
 * macros — currently `attachments.ts`'s `@HasOneAttached`/`@HasManyAttached`
 * — can register real columns/callbacks the same way `@Column()`/callback
 * decorators do, instead of hand-rolling their own metadata storage. Not part
 * of the public API surface (not re-exported from index.ts).
 */
export function ownCallbackList(metadata: DecoratorMetadata, type: CallbackType): string[] {
  const map = ownMetadataMap<CallbackType, string[]>(metadata, CALLBACKS, (methods) => [...methods]);
  const list = map.get(type) ?? [];
  map.set(type, list);
  return list;
}

export function ownColumns(metadata: DecoratorMetadata): Map<string, ColumnOptions> {
  return ownMetadataMap<string, ColumnOptions>(metadata, COLUMNS, (options) => ({ ...options }));
}

/**
 * Exported for the same reason as `ownCallbackList` — other in-package macros
 * that need an automatically-applied query filter (e.g. single-table
 * inheritance's per-subclass type filter) can register one the same way,
 * instead of hand-rolling their own metadata storage.
 */
export function ownDefaultScopes(metadata: DecoratorMetadata): ScopeFn[] {
  const map = ownMetadataMap<'scopes', ScopeFn[]>(metadata, DEFAULT_SCOPES, (fns) => [...fns]);
  const list = map.get('scopes') ?? [];
  map.set('scopes', list);
  return list;
}

function ownValidationList(metadata: DecoratorMetadata, attribute: string): ValidationRule[] {
  const map = ownMetadataMap<string, ValidationRule[]>(metadata, VALIDATIONS, (rules) => [...rules]);
  const list = map.get(attribute) ?? [];
  map.set(attribute, list);
  return list;
}

/**
 * Mixins (`Timestamped`/`SecurePassword`/`SecureToken` below) register
 * columns/callbacks imperatively rather than through an actual `@`-applied
 * decorator, so there's no `context.metadata` handed to them — the engine
 * only creates `[Symbol.metadata]` for classes that have at least one real
 * decorator application. This synthesizes the same thing by hand: a fresh
 * metadata object parented to whatever the superclass already has (falling
 * back to `null`, exactly like the engine does for a class with no
 * decorated superclass), stored the same way TypeScript's own decorator
 * helper stores it.
 */
function ownClassMetadata(ctor: new (...args: any[]) => any): DecoratorMetadata {
  if (!Object.hasOwn(ctor, Symbol.metadata)) {
    const parent = ((Object.getPrototypeOf(ctor) as any)?.[Symbol.metadata] ?? null) as DecoratorMetadata | null;
    Object.defineProperty(ctor, Symbol.metadata, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: Object.create(parent),
    });
  }
  return (ctor as any)[Symbol.metadata];
}

/**
 * Forwards attributes to a relation method, generating async
 * `<to><Capitalized attribute>()` prototype methods, e.g.
 * `@Delegate(['name'], { to: 'author' })` on Post adds `post.authorName()`,
 * equivalent to `(await post.author())?.name`.
 *
 * The relation is awaited (our associations are lazy/async, unlike Rails'
 * in-memory objects), and the generated method isn't visible to the type
 * checker on its own — declare it via interface merging if you want it typed:
 * `interface Post { authorName(): Promise<string | undefined>; }`
 */
export function Delegate(attributes: string[], options: { to: string }) {
  return function (target: any, _context: ClassDecoratorContext): void {
    for (const attribute of attributes) {
      const methodName = `${options.to}${capitalize(attribute)}`;
      target.prototype[methodName] = async function (this: any) {
        const related = await this[options.to]();
        return related == null ? undefined : related[attribute];
      };
    }
  };
}

type ModelConstructor = new (...args: any[]) => Model;

/**
 * Mixin that auto-manages `createdAt`/`updatedAt` as date-cast columns:
 * `createdAt` is stamped once on insert, `updatedAt` on every save.
 *
 * Implemented as a mixin (`class Post extends Timestamped(Model) {...}`)
 * rather than a class decorator so `createdAt`/`updatedAt` are real,
 * statically-typed properties on the result — no declaration-merging
 * needed, unlike @Delegate/@Enum below.
 */
export function Timestamped<TBase extends ModelConstructor>(
  Base: TBase
): TBase & (new (...args: any[]) => { createdAt: Date; updatedAt: Date }) {
  class WithTimestamps extends Base {
    createdAt!: Date;
    updatedAt!: Date;
  }

  const metadata = ownClassMetadata(WithTimestamps);
  const columns = ownColumns(metadata);
  columns.set('createdAt', { type: 'date' });
  columns.set('updatedAt', { type: 'date' });

  (WithTimestamps.prototype as any).__stampCreatedAt = function (this: any) {
    const now = new Date();
    this.createdAt = now;
    this.updatedAt = now;
  };
  (WithTimestamps.prototype as any).__stampUpdatedAt = function (this: any) {
    this.updatedAt = new Date();
  };

  ownCallbackList(metadata, 'beforeCreate').push('__stampCreatedAt');
  ownCallbackList(metadata, 'beforeUpdate').push('__stampUpdatedAt');

  return WithTimestamps;
}

/**
 * Mixin adding optimistic locking, mirroring `ActiveRecord::Locking::Optimistic`:
 * a `lockVersion` column (default `0`), checked and incremented by
 * `Model.save()`/`destroy()` themselves rather than by a callback here — a
 * callback can bump the in-memory value, but only the UPDATE/DELETE's own
 * `WHERE lockVersion = ...` clause and affected-row count can actually
 * detect that someone else changed the record first, so that logic has to
 * live in the query itself, not in this mixin. See `Model.save()`'s doc
 * comment and `StaleObjectError`.
 */
export function Lockable<TBase extends ModelConstructor>(
  Base: TBase
): TBase & (new (...args: any[]) => { lockVersion: number }) {
  class WithLocking extends Base {
    lockVersion!: number;
  }

  const metadata = ownClassMetadata(WithLocking);
  ownColumns(metadata).set('lockVersion', { type: 'number', default: 0 });

  return WithLocking;
}

/**
 * Mixin adding soft delete, mirroring gems like `paranoia`/`discard`: a
 * `deletedAt` column plus a `@DefaultScope` excluding non-null rows, so a
 * soft-deleted record disappears from `find`/`all`/`where`/associations
 * without actually being removed from the table. `Model.destroy()` itself
 * checks for this column and does an UPDATE instead of a DELETE when
 * present — see the `SOFT_DELETE_COLUMN` doc comment in Model.ts, the same
 * hardcoded-column-name convention `Lockable` above uses rather than a
 * generic "any column can be the soft-delete column" option. `restore()`
 * and `isDeleted` are always present on every `Model` (like `reload()`),
 * conditionally active the same way `Lockable`'s checks are, rather than
 * only being added by this mixin.
 */
export function SoftDelete<TBase extends ModelConstructor>(
  Base: TBase
): TBase & (new (...args: any[]) => { deletedAt?: Date }) {
  class WithSoftDelete extends Base {
    deletedAt?: Date;
  }

  const metadata = ownClassMetadata(WithSoftDelete);
  ownColumns(metadata).set('deletedAt', { type: 'date' });
  ownDefaultScopes(metadata).push((qb) => qb.whereNull('deletedAt'));

  return WithSoftDelete;
}

/**
 * Mixin adding password authentication, mirroring `has_secure_password`:
 * hardcoded columns `password` (virtual), `passwordConfirmation` (virtual),
 * `passwordDigest` (real, `guarded` so it can never come from mass-assigned
 * input), and an `authenticate(candidate)` method. Hashed with Node's
 * built-in `scrypt` (see security.ts) — no bcrypt dependency.
 *
 * Password handling runs as a single `beforeSave` callback rather than a
 * `@Validates` rule: it needs to *do* something (hash it), not just check
 * it, and it needs `this.isPersisted` to tell create from update, which
 * plain validation rules don't have access to.
 *
 * - On create: `password` is required, hashed into `passwordDigest`.
 * - On update: touching `password` re-hashes it; leaving it `undefined`
 *   leaves the existing digest alone (you can update other fields without
 *   supplying a password).
 * - If `passwordConfirmation` is set, it must match `password`.
 */
export function SecurePassword<TBase extends ModelConstructor>(
  Base: TBase
): TBase &
  (new (...args: any[]) => {
    password?: string;
    passwordConfirmation?: string;
    passwordDigest: string;
    authenticate(candidate: string): Promise<boolean>;
  }) {
  class WithSecurePassword extends Base {
    password?: string;
    passwordConfirmation?: string;
    passwordDigest!: string;

    async authenticate(candidate: string): Promise<boolean> {
      return this.passwordDigest ? verifyPassword(candidate, this.passwordDigest) : false;
    }
  }

  const metadata = ownClassMetadata(WithSecurePassword);
  const columns = ownColumns(metadata);
  columns.set('passwordDigest', { guarded: true });
  columns.set('password', { virtual: true });
  columns.set('passwordConfirmation', { virtual: true });

  (WithSecurePassword.prototype as any).__handlePassword = async function (this: any) {
    // `password` is virtual, so it never auto-clears after use — without
    // checking dirty tracking, every subsequent save() of the same instance
    // would re-hash the same unchanged password with a fresh salt.
    if (!this.isAttributeChanged('password')) {
      if (!this.isPersisted) {
        this.errors.add('password', "can't be blank");
        return false;
      }
      return;
    }

    if (!this.password) {
      this.errors.add('password', "can't be blank");
      return false;
    }
    if (this.passwordConfirmation !== undefined && this.password !== this.passwordConfirmation) {
      this.errors.add('passwordConfirmation', "doesn't match password");
      return false;
    }
    this.passwordDigest = await hashPassword(this.password);
  };

  ownCallbackList(metadata, 'beforeSave').push('__handlePassword');

  return WithSecurePassword;
}

/**
 * Mixin adding a `token` column auto-generated on create if unset, plus
 * `regenerateToken()`, mirroring `has_secure_token`. Handy for API keys,
 * invite links, "remember me" tokens. `token` is `guarded` so it can never
 * come from mass-assigned input — it's server-generated, never user-supplied.
 */
export function SecureToken<TBase extends ModelConstructor>(
  Base: TBase
): TBase & (new (...args: any[]) => { token: string; regenerateToken(): Promise<boolean> }) {
  class WithSecureToken extends Base {
    token!: string;

    regenerateToken(): Promise<boolean> {
      return this.update({ token: generateToken() } as any);
    }
  }

  const metadata = ownClassMetadata(WithSecureToken);
  ownColumns(metadata).set('token', { guarded: true });

  (WithSecureToken.prototype as any).__generateToken = function (this: any) {
    if (!this.token) this.token = generateToken();
  };
  ownCallbackList(metadata, 'beforeCreate').push('__generateToken');

  return WithSecureToken;
}

/**
 * Maps a raw column (typically an integer) to named labels, generating:
 * - a `<attribute>Label` getter, e.g. `post.statusLabel === 'draft'`
 * - `is<Label>()` predicates, e.g. `post.isDraft()`
 * - a static `with<Capitalized attribute>(label)` scope, e.g. `Post.withStatus('draft')`
 *
 * The raw attribute itself is untouched — keep a normal `@Column()` on it —
 * so reading/writing the underlying value never goes through an accessor.
 * As with @Delegate, the generated members aren't visible to the type
 * checker without a companion interface declaration.
 */
export function Enum(attribute: string, values: Record<string, number | string>) {
  return function (target: any, _context: ClassDecoratorContext): void {
    const rawToLabel = new Map(Object.entries(values).map(([label, raw]) => [raw, label]));

    Object.defineProperty(target.prototype, `${attribute}Label`, {
      get(this: any) {
        return rawToLabel.get(this[attribute]);
      },
      enumerable: true,
      configurable: true,
    });

    for (const [label, raw] of Object.entries(values)) {
      target.prototype[`is${capitalize(label)}`] = function (this: any) {
        return this[attribute] === raw;
      };
    }

    target[`with${capitalize(attribute)}`] = function (this: any, label: string) {
      if (!(label in values)) {
        throw new Error(`Unknown ${attribute}: ${label}`);
      }
      return this.where({ [attribute]: values[label] });
    };
  };
}
