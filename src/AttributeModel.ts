import { COLUMNS, ColumnOptions, VALIDATIONS, ValidationRule } from './decorators';
import { Errors } from './errors';

const SNAPSHOT = Symbol('snapshot');
const PREVIOUS_CHANGES = Symbol('previousChanges');

export type Changes = Record<string, [any, any]>;

/**
 * The data-attribute shape of a model instance: every declared string-keyed
 * member except methods. Used to type conditions/update payloads so they
 * get real autocomplete/typo-checking against a subclass's own declared
 * fields — this can't distinguish an `@Column()` field from an ordinary
 * declared property/getter (decorator metadata isn't visible to the type
 * system), so it's an approximation, not a guarantee every key is a real column.
 */
export type AttributesOf<T> = {
  [K in keyof T as K extends string ? (T[K] extends (...args: any[]) => any ? never : K) : never]: T[K];
};

/** Centralizes the escape hatch for reading/writing a column by a runtime string key. */
export function getAttr(instance: AttributeModel, key: string): any {
  return (instance as any)[key];
}

export function setAttr(instance: AttributeModel, key: string, value: any): void {
  (instance as any)[key] = value;
}

export interface SerializeOptions {
  only?: string[];
  except?: string[];
  include?: string[];
}

/**
 * The ActiveModel-equivalent layer: attributes (`@Column()`, with
 * casting/virtual/default support), validations, ActiveModel::Dirty-style
 * change tracking, and serialization — no notion of a database table.
 * `Model` (see Model.ts) extends this and adds persistence, querying,
 * associations, and lifecycle callbacks.
 *
 * Extend this directly for something validated and dirty-tracked like a
 * record but never persisted — a form object, a search/filter object, an
 * API request DTO. Nothing here needs `tableName`, `save()`, or a database
 * connection at all.
 */
export class AttributeModel {
  private [SNAPSHOT]: Record<string, any> = {};
  private [PREVIOUS_CHANGES]: Changes = {};
  readonly errors = new Errors();

  constructor(attrs: Record<string, any> = {}) {
    Object.assign(this, attrs);

    const ctor = this.constructor as typeof AttributeModel;
    for (const [name, options] of ctor.columns) {
      if (options.default === undefined || getAttr(this, name) !== undefined) continue;
      setAttr(this, name, typeof options.default === 'function' ? options.default() : options.default);
    }
  }

  // --- schema introspection -------------------------------------------

  static get columns(): Map<string, ColumnOptions> {
    return (this as any)[Symbol.metadata]?.[COLUMNS] ?? new Map();
  }

  static get validations(): Map<string, ValidationRule[]> {
    return (this as any)[Symbol.metadata]?.[VALIDATIONS] ?? new Map();
  }

  // --- mass-assignment protection -----------------------------------------

  /**
   * Filters a raw untrusted object (e.g. `req.body`) down to a safe payload
   * for `create()`/`update()`/`new Model(...)`. Only declared `@Column()`
   * keys ever pass through — anything else in `raw` is silently dropped,
   * same as an unrecognized param in Rails' strong parameters. The primary
   * key and any `@Column({ guarded: true })` field are always excluded,
   * regardless of `allowedKeys`.
   *
   * Pass `allowedKeys` for the common case — an explicit per-form/per-endpoint
   * allowlist, exactly like Rails' `params.permit(:name, :email)` — since a
   * blocklist alone (`guarded`) only protects fields you remembered to mark;
   * `guarded` is defense in depth on top of that, not a substitute for it.
   *
   * `new Model(attrs)`/`create(attrs)`/`update(attrs)` themselves are NOT
   * guarded — they're used by trusted internal code too (`dup()`, seed
   * scripts, admin tooling) that legitimately needs to set anything. Never
   * pass a raw request body to them directly; always route it through
   * `permit()` first.
   */
  static permit<T extends typeof AttributeModel>(
    this: T,
    raw: Record<string, any>,
    allowedKeys?: Array<keyof AttributesOf<InstanceType<T>> & string>
  ): Partial<AttributesOf<InstanceType<T>>> {
    const result: Record<string, any> = {};
    for (const [key, options] of this.columns) {
      if (options.primary || options.guarded) continue;
      if (allowedKeys && !(allowedKeys as string[]).includes(key)) continue;
      if (!(key in raw)) continue;
      result[key] = raw[key];
    }
    return result as Partial<AttributesOf<InstanceType<T>>>;
  }

  // --- validation (ActiveModel-style) -------------------------------------

  /** Override in a subclass for custom/cross-field checks; call this.errors.add(...) on failure. */
  protected validate(): void {
    // no-op by default
  }

  private static isBlank(value: any): boolean {
    return value === undefined || value === null || value === '';
  }

  private applyRule(attribute: string, value: any, rule: ValidationRule): void {
    if (rule.presence && AttributeModel.isBlank(value)) {
      this.errors.add(attribute, rule.message ?? "can't be blank");
    }

    if (AttributeModel.isBlank(value) && (rule.allowBlank || rule.presence)) {
      // Presence already reported above; skip shape checks on an absent value.
      return;
    }

    if (rule.length) {
      const len = value == null ? 0 : String(value).length;
      if (rule.length.min !== undefined && len < rule.length.min) {
        this.errors.add(attribute, rule.message ?? `is too short (minimum is ${rule.length.min} characters)`);
      }
      if (rule.length.max !== undefined && len > rule.length.max) {
        this.errors.add(attribute, rule.message ?? `is too long (maximum is ${rule.length.max} characters)`);
      }
    }

    if (rule.format && !rule.format.with.test(String(value))) {
      this.errors.add(attribute, rule.message ?? 'is invalid');
    }

    if (rule.inclusion && !rule.inclusion.in.includes(value)) {
      this.errors.add(attribute, rule.message ?? 'is not included in the list');
    }

    if (rule.validator) {
      const message = rule.validator(value, this);
      if (message) this.errors.add(attribute, message);
    }
  }

  private runValidations(): void {
    this.errors.clear();
    const ctor = this.constructor as typeof AttributeModel;
    for (const [attribute, rules] of ctor.validations) {
      for (const rule of rules) {
        this.applyRule(attribute, getAttr(this, attribute), rule);
      }
    }
    this.validate();
  }

  /** Runs all validations and returns whether the record is valid, populating `errors` as a side effect. */
  isValid(): boolean {
    this.runValidations();
    return this.errors.isEmpty;
  }

  // --- dirty tracking (ActiveModel::Dirty-style) --------------------------

  protected snapshotAttributes(): void {
    const ctor = this.constructor as typeof AttributeModel;
    const snapshot: Record<string, any> = {};
    for (const name of ctor.columns.keys()) {
      snapshot[name] = getAttr(this, name);
    }
    this[SNAPSHOT] = snapshot;
  }

  private static valuesEqual(a: any, b: any): boolean {
    if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
    return Object.is(a, b);
  }

  /** Column-by-column diff of the in-memory record against its last-loaded/saved state: { attr: [old, new] }. */
  get changes(): Changes {
    const ctor = this.constructor as typeof AttributeModel;
    const snapshot = this[SNAPSHOT];
    const result: Changes = {};
    for (const name of ctor.columns.keys()) {
      const oldValue = snapshot[name];
      const newValue = getAttr(this, name);
      if (!AttributeModel.valuesEqual(oldValue, newValue)) {
        result[name] = [oldValue, newValue];
      }
    }
    return result;
  }

  get isChanged(): boolean {
    return Object.keys(this.changes).length > 0;
  }

  isAttributeChanged(attribute: string): boolean {
    return attribute in this.changes;
  }

  /** What `changes` held immediately before the most recent successful save. Empty before the first save. */
  get previousChanges(): Changes {
    return this[PREVIOUS_CHANGES];
  }

  protected setPreviousChanges(changes: Changes): void {
    this[PREVIOUS_CHANGES] = changes;
  }

  // --- serialization -------------------------------------------------------

  /**
   * Plain-object view of this record's declared, non-virtual, non-guarded
   * columns by default — excludes `errors` and any ad-hoc preloaded
   * properties, and (unlike `permit()`, where `guarded` is about incoming
   * data) also excludes anything marked `@Column({ guarded: true })` since
   * that's exactly the "never let this leak" signal (a password digest, for
   * instance) — `only`/`except` can't resurrect an excluded column, only
   * narrow the safe default set further. Pull in extra own properties (e.g.
   * a `preloadHasMany`/`preloadBelongsTo` result, or a virtual/guarded
   * column you deliberately want) with `include` instead — an
   * `AttributeModel` or array of them found there is serialized recursively.
   */
  serializableHash(options: SerializeOptions = {}): Record<string, any> {
    const ctor = this.constructor as typeof AttributeModel;
    let names = [...ctor.columns.keys()].filter((name) => {
      const columnOptions = ctor.columns.get(name);
      return !columnOptions?.virtual && !columnOptions?.guarded;
    });
    if (options.only) names = names.filter((name) => options.only!.includes(name));
    if (options.except) names = names.filter((name) => !options.except!.includes(name));

    const result: Record<string, any> = {};
    for (const name of names) result[name] = getAttr(this, name);

    for (const key of options.include ?? []) {
      const value = getAttr(this, key);
      result[key] = Array.isArray(value)
        ? value.map((v) => (v instanceof AttributeModel ? v.serializableHash() : v))
        : value instanceof AttributeModel
          ? value.serializableHash()
          : value;
    }

    return result;
  }

  toJSON(): Record<string, any> {
    return this.serializableHash();
  }
}
