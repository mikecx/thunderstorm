import { AsyncLocalStorage } from 'async_hooks';
import { Knex } from 'knex';
import { AttributeModel, AttributesOf, getAttr, setAttr } from './AttributeModel';
import { CALLBACKS, CallbackType, DEFAULT_SCOPES, ScopeFn } from './decorators';
import { resolveCaster } from './casters';
import { RecordInvalid, RecordNotSaved, StaleObjectError } from './errors';

let knexInstance: Knex | null = null;
const transactionContext = new AsyncLocalStorage<Knex.Transaction>();

export function connect(instance: Knex): Knex {
  knexInstance = instance;
  return knexInstance;
}

/** Returns the transaction bound to the current async context, if any, otherwise the global connection. */
export function getKnex(): Knex {
  const trx = transactionContext.getStore();
  if (trx) return trx;
  if (!knexInstance) {
    throw new Error('No database connection. Call connect(knex(...)) before using models.');
  }
  return knexInstance;
}

/**
 * Runs `fn` inside a database transaction: every Model call made from within
 * it (including in nested async calls) implicitly uses the same transaction,
 * with no need to thread a `trx` parameter through every method. Commits if
 * `fn` resolves, rolls back if it throws/rejects. Calling transaction()
 * again while already inside one just reuses the existing transaction —
 * there's no savepoint/nested-transaction support.
 */
export async function transaction<T>(fn: () => Promise<T>): Promise<T> {
  if (transactionContext.getStore()) {
    return fn();
  }
  if (!knexInstance) {
    throw new Error('No database connection. Call connect(knex(...)) before using models.');
  }
  return knexInstance.transaction((trx) => transactionContext.run(trx, fn));
}

const PERSISTED = Symbol('persisted');

/**
 * Optimistic locking is enabled by convention — a declared `lockVersion`
 * column (see the `Lockable` mixin in decorators.ts) — rather than a
 * decorator or opt-in flag, the same convention-over-configuration choice
 * Rails makes for `lock_version`. save()/destroy() check for this column
 * directly instead of going through a callback, since only the UPDATE/
 * DELETE's own WHERE clause and affected-row count can actually detect a
 * lost race.
 */
const LOCK_COLUMN = 'lockVersion';

/**
 * Soft delete is enabled by the same convention `Lockable` uses — a declared
 * `deletedAt` column (see the `SoftDelete` mixin in decorators.ts) — rather
 * than a decorator or opt-in flag. `destroy()` checks for this column
 * directly and, when present, does an UPDATE setting it instead of a DELETE,
 * while still running the usual beforeDestroy/afterDestroy callbacks around
 * it. `SoftDelete` also registers a `@DefaultScope` excluding non-null rows,
 * so a soft-deleted record is invisible to normal reads until `restore()`d.
 */
const SOFT_DELETE_COLUMN = 'deletedAt';

/**
 * The ActiveRecord-equivalent layer: extends AttributeModel (attributes,
 * validations, dirty tracking, serialization — see AttributeModel.ts) with
 * persistence, querying, associations, and lifecycle callbacks.
 */
export class Model extends AttributeModel {
  static tableName: string;

  private [PERSISTED] = false;

  static callbacksFor(type: CallbackType): string[] {
    return (this as any)[Symbol.metadata]?.[CALLBACKS]?.get(type) ?? [];
  }

  private static defaultScopes(): ScopeFn[] {
    return (this as any)[Symbol.metadata]?.[DEFAULT_SCOPES]?.get('scopes') ?? [];
  }

  static get primaryKey(): string {
    for (const [name, opts] of this.columns) {
      if (opts.primary) return name;
    }
    return 'id';
  }

  private static assertTableName(): string {
    if (!this.tableName) {
      throw new Error(`${this.name} must define a static tableName.`);
    }
    return this.tableName;
  }

  // --- querying ----------------------------------------------------------

  static query<T extends typeof Model>(this: T): Knex.QueryBuilder {
    return getKnex()(this.assertTableName());
  }

  /**
   * `query()` with every registered `@DefaultScope` applied, in registration
   * order. This is what every read path (`find`/`all`/`where`/
   * `findInBatches`/associations/preloads) actually builds off — `query()`
   * itself stays unscoped since it's also the write path (`insertAll`,
   * `save()`, `destroy()`) and the documented raw-SQL escape hatch.
   */
  private static scopedQuery<T extends typeof Model>(this: T): Knex.QueryBuilder {
    let qb = this.query();
    for (const scope of this.defaultScopes()) qb = scope(qb);
    return qb;
  }

  /** A QueryChain over `query()` (unscoped), bypassing every registered `@DefaultScope` — e.g. to find a soft-deleted row so it can be restored. */
  static unscoped<T extends typeof Model>(this: T): QueryChain<T> {
    return new QueryChain(this, this.query());
  }

  static fromRow<T extends typeof Model>(this: T, row: Record<string, any>): InstanceType<T> {
    const instance = new (this as any)() as InstanceType<T>;
    instance.assignRow(row);
    (instance as any)[PERSISTED] = true;
    instance.snapshotAttributes();
    return instance;
  }

  /**
   * Assigns a raw DB row onto this instance, applying each column's
   * load-cast. Only assigns declared `@Column()` fields — a `SELECT *` may
   * return extra columns the model doesn't know about (e.g. one added to the
   * table but not yet mapped), and blindly writing those through arbitrary
   * getters/setters would be unsafe.
   */
  private assignRow(row: Record<string, any>): void {
    const ctor = this.constructor as typeof Model;
    for (const [name, options] of ctor.columns) {
      if (!(name in row)) continue;
      const value = row[name];
      setAttr(this, name, options.type ? resolveCaster(options.type).load(value) : value);
    }
  }

  static async find<T extends typeof Model>(this: T, id: any): Promise<InstanceType<T> | undefined> {
    const row = await this.scopedQuery().where(this.primaryKey, id).first();
    return row ? this.fromRow(row) : undefined;
  }

  /** Every row, chainable like where({}) — `await Model.all()`, or `Model.all().order('name', 'asc')`. */
  static all<T extends typeof Model>(this: T): QueryChain<T> {
    return new QueryChain(this, this.scopedQuery());
  }

  static where<T extends typeof Model>(this: T, conditions: Partial<AttributesOf<InstanceType<T>>>): QueryChain<T> {
    return new QueryChain(this, this.scopedQuery().where(castConditions(this, conditions as Record<string, any>)));
  }

  /**
   * Iterates every row in batches (default 1000), one query per batch, using
   * primary-key cursor pagination — `WHERE pk > lastId ORDER BY pk LIMIT n` —
   * rather than OFFSET, which gets slower the deeper you page into a large
   * table. Use this instead of `all()`/`where()` for anything that might not
   * fit in memory at once.
   */
  static async *findInBatches<T extends typeof Model>(
    this: T,
    options: { batchSize?: number } = {}
  ): AsyncGenerator<InstanceType<T>[]> {
    const batchSize = options.batchSize ?? 1000;
    const pk = this.primaryKey;
    let lastId: any = null;

    while (true) {
      let qb = this.scopedQuery().orderBy(pk, 'asc').limit(batchSize);
      if (lastId !== null) qb = qb.where(pk, '>', lastId);
      const rows = await qb;
      if (rows.length === 0) return;

      const batch = rows.map((row: any) => this.fromRow(row));
      yield batch;

      lastId = getAttr(batch[batch.length - 1], pk);
      if (rows.length < batchSize) return;
    }
  }

  /** Same batching as findInBatches(), yielded one record at a time. */
  static async *findEach<T extends typeof Model>(
    this: T,
    options: { batchSize?: number } = {}
  ): AsyncGenerator<InstanceType<T>> {
    for await (const batch of this.findInBatches(options)) {
      yield* batch;
    }
  }

  static async create<T extends typeof Model>(this: T, attrs: Record<string, any>): Promise<InstanceType<T>> {
    const instance = new (this as any)(attrs) as InstanceType<T>;
    await instance.save();
    return instance;
  }

  /**
   * Returns the first row matching `conditions`, or creates one from
   * `conditions` merged with `defaults` (defaults win on overlapping keys)
   * if none exists.
   */
  static async firstOrCreate<T extends typeof Model>(
    this: T,
    conditions: Partial<AttributesOf<InstanceType<T>>>,
    defaults: Partial<AttributesOf<InstanceType<T>>> = {}
  ): Promise<InstanceType<T>> {
    const existing = await this.where(conditions).first();
    if (existing) return existing;
    return this.create({ ...conditions, ...defaults } as Record<string, any>);
  }

  /**
   * Bulk-inserts `rows` in a single INSERT statement — the create-side
   * counterpart to `QueryChain.deleteAll()`. Like `deleteAll()`, this skips
   * instantiation entirely: no defaults, no validations, and no
   * `beforeSave`/`beforeCreate`/`afterCreate` callbacks run, so anything a
   * model relies on one of those for (Timestamped's `createdAt`/`updatedAt`,
   * SecureToken's token generation, SecurePassword's hashing) must be
   * supplied directly in each row — this is for callback-light models
   * (bulk-seeding, imports), not a drop-in replacement for looping `create()`.
   * Each row's values are still passed through `castForWrite`, so a
   * caster-backed column (`json`, `encryptedCaster`) is written correctly.
   * Returns the number of rows given, not a driver-reported count — unlike
   * update/delete, a bulk insert either fully succeeds or throws.
   */
  static async insertAll<T extends typeof Model>(
    this: T,
    rows: Array<Partial<AttributesOf<InstanceType<T>>>>
  ): Promise<number> {
    if (rows.length === 0) return 0;
    await this.query().insert(rows.map((row) => castConditions(this, row as Record<string, any>)));
    return rows.length;
  }

  /** Convenience alias for the standalone transaction() function — see its docs. */
  static transaction<T>(fn: () => Promise<T>): Promise<T> {
    return transaction(fn);
  }

  // --- associations --------------------------------------------------------
  //
  // Relations take the related class directly rather than a thunk: the
  // reference is only resolved when the method body actually runs (i.e. on
  // first call, long after both modules have finished loading), so a plain
  // import — even a circular one between two model files — is safe. Only a
  // *class-body* reference (a static field initializer, a decorator argument)
  // would need a thunk to dodge module load order.

  /** One-to-many: rows in `target` whose `foreignKey` equals this record's primary key (or `localKey`). */
  protected hasMany<T extends typeof Model>(
    target: T,
    options: { foreignKey: string; localKey?: string }
  ): QueryChain<T> {
    const localKey = options.localKey ?? (this.constructor as typeof Model).primaryKey;
    return target.where({ [options.foreignKey]: getAttr(this, localKey) } as Partial<AttributesOf<InstanceType<T>>>);
  }

  /** One-to-one, owning side: the single row in `target` whose `foreignKey` equals this record's primary key. */
  protected hasOne<T extends typeof Model>(
    target: T,
    options: { foreignKey: string; localKey?: string }
  ): Promise<InstanceType<T> | undefined> {
    const localKey = options.localKey ?? (this.constructor as typeof Model).primaryKey;
    return target
      .where({ [options.foreignKey]: getAttr(this, localKey) } as Partial<AttributesOf<InstanceType<T>>>)
      .first();
  }

  /** Inverse of hasMany/hasOne: the single row in `target` referenced by this record's `foreignKey` column. */
  protected belongsTo<T extends typeof Model>(
    target: T,
    options: { foreignKey: string }
  ): Promise<InstanceType<T> | undefined> {
    return target.find(getAttr(this, options.foreignKey));
  }

  /**
   * Many-to-many via a real join `Model` (Rails' `has_many :through`) —
   * `through` owns `sourceKey` (pointing back to this record) and
   * `targetKey` (pointing to `target`). Stays lazy/chainable like `hasMany`:
   * builds one query with a `WHERE targetPk IN (subquery)` rather than two
   * sequential round-trips. Because `through` is an ordinary `Model`, adding
   * or removing a join row is just `through.create({...})` /
   * `through.query().where({...}).delete()` — no separate write API needed,
   * unlike `hasAndBelongsToMany` below.
   */
  protected hasManyThrough<T extends typeof Model>(
    target: T,
    through: typeof Model,
    options: { sourceKey: string; targetKey: string; localKey?: string }
  ): QueryChain<T> {
    const localKey = options.localKey ?? (this.constructor as typeof Model).primaryKey;
    const subquery = through.scopedQuery().select(options.targetKey).where(options.sourceKey, getAttr(this, localKey));
    return new QueryChain(target, target.scopedQuery().whereIn(target.primaryKey, subquery));
  }

  /**
   * Many-to-many via a bare join table with no `Model` of its own (Rails'
   * `has_and_belongs_to_many`) — simpler to set up than `hasManyThrough`
   * when the join table is genuinely just two foreign keys, at the cost of
   * losing anywhere to put extra columns/validations on the join row later.
   * Pair with `associate`/`dissociate` below to add/remove rows, since
   * there's no join `Model` to call `create()`/`destroy()` on.
   */
  protected hasAndBelongsToMany<T extends typeof Model>(
    target: T,
    options: { joinTable: string; sourceKey: string; targetKey: string; localKey?: string }
  ): QueryChain<T> {
    const localKey = options.localKey ?? (this.constructor as typeof Model).primaryKey;
    const subquery = getKnex()(options.joinTable)
      .select(options.targetKey)
      .where(options.sourceKey, getAttr(this, localKey));
    return new QueryChain(target, target.scopedQuery().whereIn(target.primaryKey, subquery));
  }

  /**
   * Inserts a join-table row connecting this record to `record` — the write
   * side of `hasAndBelongsToMany`, since there's no join `Model` to
   * `create()` on. Doesn't guard against inserting the same pair twice; pair
   * with a unique index on `(sourceKey, targetKey)` in the migration for
   * that, same as `@Validates({ uniqueness })` elsewhere in this library is
   * a UX nicety, not a concurrency guarantee.
   */
  protected async associate<T extends typeof Model>(
    target: T,
    options: { joinTable: string; sourceKey: string; targetKey: string; localKey?: string },
    record: InstanceType<T>
  ): Promise<void> {
    const localKey = options.localKey ?? (this.constructor as typeof Model).primaryKey;
    await getKnex()(options.joinTable).insert({
      [options.sourceKey]: getAttr(this, localKey),
      [options.targetKey]: getAttr(record, target.primaryKey),
    });
  }

  /** Deletes the join-table row connecting this record to `record`, if one exists. */
  protected async dissociate<T extends typeof Model>(
    target: T,
    options: { joinTable: string; sourceKey: string; targetKey: string; localKey?: string },
    record: InstanceType<T>
  ): Promise<void> {
    const localKey = options.localKey ?? (this.constructor as typeof Model).primaryKey;
    await getKnex()(options.joinTable)
      .where(options.sourceKey, getAttr(this, localKey))
      .where(options.targetKey, getAttr(record, target.primaryKey))
      .delete();
  }

  /**
   * The "commentable" side of a polymorphic association: `idField`/`typeField`
   * on this record identify a row in one of several possible tables.
   * `types` maps each `typeField` value to the `Model` it corresponds to —
   * deliberately explicit rather than inferring a class name (`ctor.name`)
   * the way Rails defaults to, so renaming a model class can never silently
   * orphan every row that already references it under the old name.
   */
  protected belongsToPolymorphic<TTypes extends Record<string, typeof Model>>(
    options: { idField: string; typeField: string },
    types: TTypes
  ): Promise<InstanceType<TTypes[keyof TTypes]> | undefined> {
    const type = getAttr(this, options.typeField);
    const id = getAttr(this, options.idField);
    const target = types[type];
    if (!target || id == null) return Promise.resolve(undefined);
    return target.find(id) as Promise<InstanceType<TTypes[keyof TTypes]> | undefined>;
  }

  /**
   * The reverse, "has many as" side of a polymorphic association — e.g. a
   * `Post`'s comments, where `Comment.commentableType` must also match
   * `typeValue` (the same stable string passed to `belongsToPolymorphic`'s
   * `types` map on the `Comment` side) so a comment on a `Photo` with the
   * same id never leaks in.
   */
  protected hasManyPolymorphic<T extends typeof Model>(
    target: T,
    options: { idField: string; typeField: string; typeValue: string; localKey?: string }
  ): QueryChain<T> {
    const localKey = options.localKey ?? (this.constructor as typeof Model).primaryKey;
    return target.where({
      [options.idField]: getAttr(this, localKey),
      [options.typeField]: options.typeValue,
    } as Partial<AttributesOf<InstanceType<T>>>);
  }

  /** One-to-one flavor of `hasManyPolymorphic` — same filter, first match only. */
  protected hasOnePolymorphic<T extends typeof Model>(
    target: T,
    options: { idField: string; typeField: string; typeValue: string; localKey?: string }
  ): Promise<InstanceType<T> | undefined> {
    return this.hasManyPolymorphic(target, options).first();
  }

  /**
   * Batch-loads a hasMany association for a whole result set in one query
   * (`WHERE foreignKey IN (...)`) instead of one query per record, and
   * attaches the grouped results onto each record under `options.as`.
   * Pick an `as` name that doesn't collide with a same-named relation method.
   */
  static async preloadHasMany<T extends typeof Model, R extends typeof Model>(
    this: T,
    records: InstanceType<T>[],
    target: R,
    options: { foreignKey: string; localKey?: string; as: string }
  ): Promise<void> {
    if (records.length === 0) return;
    const localKey = options.localKey ?? this.primaryKey;
    const ids = [...new Set(records.map((r) => getAttr(r, localKey)))];
    const rows = await target.scopedQuery().whereIn(options.foreignKey, ids);

    const grouped = new Map<any, InstanceType<R>[]>();
    for (const row of rows) {
      const instance = target.fromRow(row);
      const bucket = grouped.get(row[options.foreignKey]) ?? [];
      bucket.push(instance);
      grouped.set(row[options.foreignKey], bucket);
    }
    for (const record of records) {
      setAttr(record, options.as, grouped.get(getAttr(record, localKey)) ?? []);
    }
  }

  /**
   * Batch-loads a belongsTo association for a whole result set in one query,
   * attaching the matched parent onto each record under `options.as`.
   */
  static async preloadBelongsTo<T extends typeof Model, R extends typeof Model>(
    this: T,
    records: InstanceType<T>[],
    target: R,
    options: { foreignKey: string; targetKey?: string; as: string }
  ): Promise<void> {
    if (records.length === 0) return;
    const targetKey = options.targetKey ?? target.primaryKey;
    const ids = [...new Set(records.map((r) => getAttr(r, options.foreignKey)).filter((v) => v != null))];
    const rows = ids.length > 0 ? await target.scopedQuery().whereIn(targetKey, ids) : [];

    const byKey = new Map<any, InstanceType<R>>();
    for (const row of rows) {
      byKey.set(row[targetKey], target.fromRow(row));
    }
    for (const record of records) {
      setAttr(record, options.as, byKey.get(getAttr(record, options.foreignKey)));
    }
  }

  /**
   * Batch-loads a `hasManyThrough` association for a whole result set in two
   * queries total (one against `through`, one against `target`) regardless
   * of how many `records` there are — same N+1-avoidance as `preloadHasMany`.
   */
  static async preloadHasManyThrough<T extends typeof Model, R extends typeof Model>(
    this: T,
    records: InstanceType<T>[],
    target: R,
    through: typeof Model,
    options: { sourceKey: string; targetKey: string; localKey?: string; as: string }
  ): Promise<void> {
    if (records.length === 0) return;
    const localKey = options.localKey ?? this.primaryKey;
    const localIds = [...new Set(records.map((r) => getAttr(r, localKey)))];
    const joinRows = await through.scopedQuery().whereIn(options.sourceKey, localIds);
    await groupAndAttachThrough(
      records,
      target,
      joinRows,
      options.sourceKey,
      options.targetKey,
      localKey,
      options.as,
      (ids) => target.scopedQuery().whereIn(target.primaryKey, ids)
    );
  }

  /** Batch-loads a `hasAndBelongsToMany` association — same shape as `preloadHasManyThrough`, minus the join `Model`. */
  static async preloadHasAndBelongsToMany<T extends typeof Model, R extends typeof Model>(
    this: T,
    records: InstanceType<T>[],
    target: R,
    options: { joinTable: string; sourceKey: string; targetKey: string; localKey?: string; as: string }
  ): Promise<void> {
    if (records.length === 0) return;
    const localKey = options.localKey ?? this.primaryKey;
    const localIds = [...new Set(records.map((r) => getAttr(r, localKey)))];
    const joinRows = await getKnex()(options.joinTable).whereIn(options.sourceKey, localIds);
    await groupAndAttachThrough(
      records,
      target,
      joinRows,
      options.sourceKey,
      options.targetKey,
      localKey,
      options.as,
      (ids) => target.scopedQuery().whereIn(target.primaryKey, ids)
    );
  }

  /** Batch-loads a `hasManyPolymorphic` association — same shape as `preloadHasMany`, plus the type filter. */
  static async preloadHasManyPolymorphic<T extends typeof Model, R extends typeof Model>(
    this: T,
    records: InstanceType<T>[],
    target: R,
    options: { idField: string; typeField: string; typeValue: string; localKey?: string; as: string }
  ): Promise<void> {
    if (records.length === 0) return;
    const localKey = options.localKey ?? this.primaryKey;
    const ids = [...new Set(records.map((r) => getAttr(r, localKey)))];
    const rows = await target.scopedQuery().whereIn(options.idField, ids).where(options.typeField, options.typeValue);

    const grouped = new Map<any, InstanceType<R>[]>();
    for (const row of rows) {
      const instance = target.fromRow(row);
      const bucket = grouped.get(row[options.idField]) ?? [];
      bucket.push(instance);
      grouped.set(row[options.idField], bucket);
    }
    for (const record of records) {
      setAttr(record, options.as, grouped.get(getAttr(record, localKey)) ?? []);
    }
  }

  /**
   * Batch-loads a `belongsToPolymorphic` association. Can't do this in one
   * query the way `preloadBelongsTo` does, since different records may
   * reference different target tables — instead groups `records` by their
   * `typeField` value first, then runs one batched query per distinct type
   * actually present. Still bounded (at most `types.size` queries, never one
   * per record), just not always exactly one query the way the
   * single-target preloads are.
   */
  static async preloadBelongsToPolymorphic<T extends typeof Model>(
    this: T,
    records: InstanceType<T>[],
    options: { idField: string; typeField: string; types: Record<string, typeof Model>; as: string }
  ): Promise<void> {
    if (records.length === 0) return;

    const recordsByType = new Map<string, InstanceType<T>[]>();
    for (const record of records) {
      const type = getAttr(record, options.typeField);
      if (type == null) continue;
      const bucket = recordsByType.get(type) ?? [];
      bucket.push(record);
      recordsByType.set(type, bucket);
    }

    for (const [type, recordsOfType] of recordsByType) {
      const target = options.types[type];
      if (!target) continue; // unrecognized type string — leave `as` unset for these records

      const ids = [...new Set(recordsOfType.map((r) => getAttr(r, options.idField)).filter((v) => v != null))];
      const rows = ids.length > 0 ? await target.scopedQuery().whereIn(target.primaryKey, ids) : [];

      const byId = new Map<any, InstanceType<typeof target>>();
      for (const row of rows) {
        byId.set(row[target.primaryKey], target.fromRow(row));
      }
      for (const record of recordsOfType) {
        setAttr(record, options.as, byId.get(getAttr(record, options.idField)));
      }
    }
  }

  // --- lifecycle callbacks -------------------------------------------------

  /** Runs the registered callbacks for `type` in declaration order. Returns false if a before* callback aborted. */
  private async runCallbacks(type: CallbackType): Promise<boolean> {
    const ctor = this.constructor as typeof Model;
    for (const methodName of ctor.callbacksFor(type)) {
      const result = await (this as any)[methodName]();
      if (result === false) return false;
    }
    return true;
  }

  // --- instance persistence ----------------------------------------------

  get isPersisted(): boolean {
    return this[PERSISTED];
  }

  /** Applies the column's save-cast (if any), converting a JS attribute value to its raw DB representation. */
  static castForWrite(name: string, value: any): any {
    const type = this.columns.get(name)?.type;
    return type && value != null ? resolveCaster(type).save(value) : value;
  }

  private columnAttributes(): Record<string, any> {
    const ctor = this.constructor as typeof Model;
    const attrs: Record<string, any> = {};
    for (const [name, options] of ctor.columns) {
      if (options.virtual) continue;
      const value = getAttr(this, name);
      if (value !== undefined) attrs[name] = ctor.castForWrite(name, value);
    }
    return attrs;
  }

  /**
   * Runs any `@Validates({ uniqueness: ... })` rules against the database,
   * adding errors for conflicts found. Only Model has a table to check
   * against, so this can't live in AttributeModel's synchronous
   * runValidations() — see save(), which calls this separately.
   */
  private async checkUniqueness(): Promise<void> {
    const ctor = this.constructor as typeof Model;
    const pk = ctor.primaryKey;

    for (const [attribute, rules] of ctor.validations) {
      for (const rule of rules) {
        if (!rule.uniqueness) continue;

        const value = getAttr(this, attribute);
        if (value === undefined || value === null || value === '') continue;

        let qb = ctor.scopedQuery().where(attribute, ctor.castForWrite(attribute, value));
        if (typeof rule.uniqueness === 'object' && rule.uniqueness.scope) {
          const scopes = Array.isArray(rule.uniqueness.scope) ? rule.uniqueness.scope : [rule.uniqueness.scope];
          for (const scopeAttr of scopes) {
            qb = qb.where(scopeAttr, ctor.castForWrite(scopeAttr, getAttr(this, scopeAttr)));
          }
        }
        if (this[PERSISTED]) {
          qb = qb.whereNot(pk, getAttr(this, pk));
        }

        if (await qb.first()) {
          this.errors.add(attribute, rule.message ?? 'has already been taken');
        }
      }
    }
  }

  /**
   * Discards unsaved in-memory changes by re-fetching the row from the
   * database. Deliberately unscoped — it's re-fetching a record the caller
   * already holds a handle to by primary key, not running a general listing
   * query, so a `@DefaultScope` that would otherwise exclude it (e.g. after
   * soft-deleting this same instance) shouldn't make `reload()` throw.
   */
  async reload(): Promise<this> {
    const ctor = this.constructor as typeof Model;
    const pk = ctor.primaryKey;
    const row = await ctor.query().where(pk, getAttr(this, pk)).first();
    if (!row) {
      throw new Error(`Can't reload: no ${ctor.name} found with ${pk} = ${getAttr(this, pk)}`);
    }
    this.assignRow(row);
    this.snapshotAttributes();
    return this;
  }

  /**
   * Validates, then persists. Returns false — without writing — when
   * validation fails or a before* callback aborts the chain.
   *
   * Order: beforeSave -> beforeCreate/beforeUpdate -> INSERT/UPDATE ->
   * afterCreate/afterUpdate -> afterSave. Updates are partial writes: only
   * columns present in `changes` are sent to the database.
   */
  async save(): Promise<boolean> {
    if (!this.isValid()) return false;
    await this.checkUniqueness();
    if (!this.errors.isEmpty) return false;

    const ctor = this.constructor as typeof Model;
    const isCreate = !this[PERSISTED];

    if (!(await this.runCallbacks('beforeSave'))) return false;
    if (!(await this.runCallbacks(isCreate ? 'beforeCreate' : 'beforeUpdate'))) return false;

    const pk = ctor.primaryKey;
    const pendingChanges = this.changes;

    if (isCreate) {
      const attrs = this.columnAttributes();
      const [inserted] = await ctor.query().insert(attrs).returning(pk);
      setAttr(this, pk, typeof inserted === 'object' ? inserted[pk] : inserted);
      this[PERSISTED] = true;
    } else {
      const updateAttrs: Record<string, any> = {};
      for (const [key, [, newValue]] of Object.entries(pendingChanges)) {
        const columnOptions = ctor.columns.get(key);
        if (key === pk || key === LOCK_COLUMN || columnOptions?.virtual || columnOptions?.readonly) continue;
        updateAttrs[key] = ctor.castForWrite(key, newValue);
      }
      if (Object.keys(updateAttrs).length > 0) {
        let qb = ctor.query().where(pk, getAttr(this, pk));
        const isLockable = ctor.columns.has(LOCK_COLUMN);
        let nextLockVersion: number | undefined;

        if (isLockable) {
          const currentLockVersion = getAttr(this, LOCK_COLUMN) as number;
          nextLockVersion = currentLockVersion + 1;
          updateAttrs[LOCK_COLUMN] = ctor.castForWrite(LOCK_COLUMN, nextLockVersion);
          qb = qb.where(LOCK_COLUMN, ctor.castForWrite(LOCK_COLUMN, currentLockVersion));
        }

        const affected = await qb.update(updateAttrs);
        if (isLockable) {
          if (affected === 0) throw new StaleObjectError(this);
          setAttr(this, LOCK_COLUMN, nextLockVersion);
        }
      }
    }

    this.setPreviousChanges(pendingChanges);
    this.snapshotAttributes();

    await this.runCallbacks(isCreate ? 'afterCreate' : 'afterUpdate');
    await this.runCallbacks('afterSave');

    return true;
  }

  /**
   * Like save(), but throws instead of returning false: RecordInvalid when
   * validation failed, RecordNotSaved when a before* callback aborted.
   */
  async saveOrFail(): Promise<this> {
    if (!(await this.save())) {
      throw this.errors.isEmpty ? new RecordNotSaved(this) : new RecordInvalid(this);
    }
    return this;
  }

  /**
   * Returns false — without deleting — if a beforeDestroy callback aborts
   * the chain. Throws StaleObjectError (not a normal false return) if the
   * record is optimistically locked and someone else already changed or
   * deleted it — see `Lockable`/`save()`. On a `SoftDelete`-mixed-in model,
   * this sets `deletedAt` via an UPDATE instead of issuing a DELETE — the
   * row still physically exists, so `isPersisted` stays `true` and a
   * subsequent `save()` still does an UPDATE, not a re-INSERT.
   */
  async destroy(): Promise<boolean> {
    if (!(await this.runCallbacks('beforeDestroy'))) return false;

    const ctor = this.constructor as typeof Model;
    const pk = ctor.primaryKey;
    let qb = ctor.query().where(pk, getAttr(this, pk));
    const isLockable = ctor.columns.has(LOCK_COLUMN);
    if (isLockable) qb = qb.where(LOCK_COLUMN, ctor.castForWrite(LOCK_COLUMN, getAttr(this, LOCK_COLUMN)));

    const isSoftDeletable = ctor.columns.has(SOFT_DELETE_COLUMN);
    let affected: number;
    if (isSoftDeletable) {
      const deletedAt = new Date();
      affected = await qb.update({ [SOFT_DELETE_COLUMN]: ctor.castForWrite(SOFT_DELETE_COLUMN, deletedAt) });
      if (isLockable && affected === 0) throw new StaleObjectError(this);
      if (affected > 0) {
        setAttr(this, SOFT_DELETE_COLUMN, deletedAt);
        this.snapshotAttributes();
      }
    } else {
      affected = await qb.delete();
      if (isLockable && affected === 0) throw new StaleObjectError(this);
      this[PERSISTED] = false;
    }

    await this.runCallbacks('afterDestroy');
    return true;
  }

  /**
   * Un-soft-deletes this record by clearing `deletedAt`, the inverse of a
   * `SoftDelete`-aware `destroy()`. Throws if the model has no `deletedAt`
   * column — there's nothing to restore. Targets this record directly by
   * primary key like `destroy()` does, so it works on an instance loaded via
   * `Model.unscoped()` (a plain `find()`/`all()`/`where()` won't surface a
   * soft-deleted row in the first place, since `SoftDelete` registers a
   * `@DefaultScope` excluding it). Doesn't run callbacks or go through the
   * `Lockable` check — same documented simplification `insertAll()`/
   * `deleteAll()` already make elsewhere in this library.
   */
  async restore(): Promise<boolean> {
    const ctor = this.constructor as typeof Model;
    if (!ctor.columns.has(SOFT_DELETE_COLUMN)) {
      throw new Error(`${ctor.name} is not soft-deletable (no ${SOFT_DELETE_COLUMN} column).`);
    }
    const pk = ctor.primaryKey;
    await ctor
      .query()
      .where(pk, getAttr(this, pk))
      .update({ [SOFT_DELETE_COLUMN]: null });
    setAttr(this, SOFT_DELETE_COLUMN, undefined);
    this.snapshotAttributes();
    return true;
  }

  /** Whether this record is soft-deleted. Always false on a model without a `deletedAt` column. */
  get isDeleted(): boolean {
    const ctor = this.constructor as typeof Model;
    return ctor.columns.has(SOFT_DELETE_COLUMN) && getAttr(this, SOFT_DELETE_COLUMN) != null;
  }

  /** Assigns `attrs` then saves. Returns false — without writing — under the same conditions as save(). */
  async update(attrs: Partial<AttributesOf<this>>): Promise<boolean> {
    Object.assign(this, attrs);
    return this.save();
  }

  /** Like update(), but throws instead of returning false — see saveOrFail(). */
  async updateOrFail(attrs: Partial<AttributesOf<this>>): Promise<this> {
    Object.assign(this, attrs);
    return this.saveOrFail();
  }

  /** An unpersisted copy of this record's column values, excluding the primary key. */
  dup(): this {
    const ctor = this.constructor as typeof Model;
    const pk = ctor.primaryKey;
    const attrs: Record<string, any> = {};
    for (const name of ctor.columns.keys()) {
      if (name === pk) continue;
      const value = getAttr(this, name);
      if (value !== undefined) attrs[name] = value;
    }
    return new (ctor as any)(attrs) as this;
  }
}

/**
 * Applies each condition value's column cast before it reaches Knex — shared
 * by `Model.where()` and `QueryChain.where()` so a caster-backed column (a
 * `json` column, a deterministic `encryptedCaster`, any custom `Caster`)
 * matches on its raw DB representation instead of the JS value. Without
 * this, `where({ metadata: {...} })` against a `json` column, or `where({
 * ssn: '...' })` against a deterministically-encrypted one, would silently
 * never match anything.
 */
function castConditions(ctor: typeof Model, conditions: Record<string, any>): Record<string, any> {
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(conditions)) {
    result[key] = ctor.castForWrite(key, value);
  }
  return result;
}

/**
 * Shared grouping logic for `preloadHasManyThrough`/`preloadHasAndBelongsToMany`
 * — identical once `joinRows` are in hand, they only differ in how those rows
 * get fetched (a join `Model` vs. a bare table name). `fetchTargets` is passed
 * in (rather than this function calling `target.query()` itself) so the
 * caller — a `Model` static method — can build the query through the private
 * `scopedQuery()`, which isn't reachable from this module-level function.
 */
async function groupAndAttachThrough<R extends typeof Model>(
  records: Model[],
  target: R,
  joinRows: Array<Record<string, any>>,
  sourceKey: string,
  targetKey: string,
  localKey: string,
  as: string,
  fetchTargets: (ids: any[]) => Promise<Array<Record<string, any>>>
): Promise<void> {
  const targetIdsBySource = new Map<any, any[]>();
  for (const row of joinRows) {
    const list = targetIdsBySource.get(row[sourceKey]) ?? [];
    list.push(row[targetKey]);
    targetIdsBySource.set(row[sourceKey], list);
  }

  const allTargetIds = [...new Set(joinRows.map((row) => row[targetKey]))];
  const targetRows = allTargetIds.length > 0 ? await fetchTargets(allTargetIds) : [];
  const targetsById = new Map<any, InstanceType<R>>();
  for (const row of targetRows) {
    targetsById.set(row[target.primaryKey], target.fromRow(row));
  }

  for (const record of records) {
    const ids = targetIdsBySource.get(getAttr(record, localKey)) ?? [];
    setAttr(
      record,
      as,
      ids.map((id) => targetsById.get(id)).filter((instance): instance is InstanceType<R> => instance !== undefined)
    );
  }
}

/**
 * Thin lazy wrapper around a Knex query builder so `.where().order().limit()`
 * chains stay ActiveRecord-shaped and only hit the DB once awaited.
 */
export class QueryChain<T extends typeof Model> implements PromiseLike<InstanceType<T>[]> {
  constructor(
    private readonly modelClass: T,
    private qb: Knex.QueryBuilder
  ) {}

  where(conditions: Partial<AttributesOf<InstanceType<T>>>): this {
    this.qb = this.qb.where(castConditions(this.modelClass, conditions as Record<string, any>));
    return this;
  }

  /**
   * The escape hatch for conditions `.where({...})`'s object-shape can't
   * express — ORs, raw SQL functions, anything — without abandoning the
   * chain. Wraps Knex's own `.whereRaw()`; bind values with `?` rather than
   * interpolating them into the string, same as any other parameterized query.
   */
  whereRaw(sql: string, bindings: readonly any[] = []): this {
    this.qb = this.qb.whereRaw(sql, bindings as any[]);
    return this;
  }

  order(column: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.qb = this.qb.orderBy(column, direction);
    return this;
  }

  limit(n: number): this {
    this.qb = this.qb.limit(n);
    return this;
  }

  /**
   * Pessimistic row locking — `SELECT ... FOR UPDATE` (default) or `FOR
   * SHARE`. A thin wrapper over Knex's own `.forUpdate()`/`.forShare()`;
   * only meaningful inside `transaction()` (Postgres/MySQL hold the lock
   * until the surrounding transaction commits or rolls back — outside one,
   * there's no transaction to hold it across, so the lock is released the
   * instant the SELECT completes). SQLite has no row-level locking at all
   * and silently ignores this — it already locks at the database/table
   * level for writes, so there's nothing to add here.
   */
  lock(mode: 'update' | 'share' = 'update'): this {
    this.qb = mode === 'update' ? this.qb.forUpdate() : this.qb.forShare();
    return this;
  }

  /** Threads this chain through an arbitrary function — the composition point for chaining scopes together. */
  apply<R>(fn: (chain: this) => R): R {
    return fn(this);
  }

  async first(): Promise<InstanceType<T> | undefined> {
    const row = await this.qb.clone().first();
    return row ? this.modelClass.fromRow(row) : undefined;
  }

  /** Selects just this column and returns the raw values — skips instantiating full model instances. */
  async pluck<K extends keyof AttributesOf<InstanceType<T>> & string>(
    column: K
  ): Promise<Array<AttributesOf<InstanceType<T>>[K]>> {
    const rows = await this.qb.clone().select(column);
    return rows.map((row: any) => row[column]);
  }

  async count(): Promise<number> {
    const result = await this.qb.clone().count({ count: '*' }).first();
    return Number(result?.count ?? 0);
  }

  async exists(): Promise<boolean> {
    const row = await this.qb.clone().first();
    return row !== undefined;
  }

  /**
   * Bulk-updates every row matching this chain in a single SQL statement —
   * no `beforeSave`/`afterSave`/`beforeUpdate`/`afterUpdate` callbacks,
   * no validations, no dirty-tracking. `attrs` is cast the same way
   * `where()` conditions and `save()` are (`castForWrite` per column), so a
   * `json`/`encryptedCaster()` column written through here still round-trips
   * correctly. Returns the number of rows updated.
   */
  async updateAll(attrs: Partial<AttributesOf<InstanceType<T>>>): Promise<number> {
    return this.qb.clone().update(castConditions(this.modelClass, attrs as Record<string, any>));
  }

  /**
   * Bulk-deletes every row matching this chain in a single SQL statement —
   * Rails' `delete_all`, not `destroy_all`. Skips instantiating records
   * entirely, so `beforeDestroy`/`afterDestroy` callbacks (and anything they
   * do, like `HasManyAttached`'s auto-purge or a `destroy()` override) never
   * run. Use `destroyAll()` instead when those need to fire; reach for
   * `deleteAll()` when the target has no such side effects to preserve and
   * you want one query instead of N. Returns the number of rows deleted.
   */
  async deleteAll(): Promise<number> {
    return this.qb.clone().delete();
  }

  /**
   * Rails' `destroy_all`: loads every matching row and calls destroy() on
   * each in turn, so beforeDestroy/afterDestroy callbacks (and anything they
   * do) run exactly as if you'd called destroy() on each individually —
   * this just saves writing the loop. One query per record plus the initial
   * SELECT, unlike deleteAll()'s single statement. Returns the count
   * actually destroyed, which is lower than the number matched if a
   * beforeDestroy callback blocks any of them.
   */
  async destroyAll(): Promise<number> {
    const records = await this;
    let destroyed = 0;
    for (const record of records) {
      if (await record.destroy()) destroyed++;
    }
    return destroyed;
  }

  then<TResult1 = InstanceType<T>[], TResult2 = never>(
    onfulfilled?: ((value: InstanceType<T>[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.qb
      .select()
      .then((rows: any[]) => rows.map((row) => this.modelClass.fromRow(row)))
      .then(onfulfilled, onrejected);
  }
}
