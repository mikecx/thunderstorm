import type { Caster, ColumnType } from './casters';
import type { Model } from './Model';

export interface ColumnOptions {
  primary?: boolean;
  /** Converts between the raw DB value and the JS attribute value on load/save. See src/casters.ts. */
  type?: ColumnType | Caster;
}

export const COLUMNS = Symbol('columns');

/**
 * Marks a class field as a mapped database column. Metadata is stored per-
 * constructor (not inherited) so each Model subclass owns its own column set.
 */
export function Column(options: ColumnOptions = {}): PropertyDecorator {
  return (target, propertyKey) => {
    ownColumns(target.constructor).set(propertyKey as string, options);
  };
}

export function PrimaryKey(): PropertyDecorator {
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
}

export const VALIDATIONS = Symbol('validations');

/**
 * Declares a validation rule for an attribute. Stacks: applying @Validates
 * more than once on the same field (or to different fields) accumulates
 * rules, mirroring Rails' repeated `validates :attr, ...` calls.
 */
export function Validates(rule: ValidationRule): PropertyDecorator {
  return (target, propertyKey) => {
    ownValidationList(target.constructor, propertyKey as string).push(rule);
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
function registerCallback(type: CallbackType): MethodDecorator {
  return (target, propertyKey) => {
    ownCallbackList(target.constructor, type).push(propertyKey as string);
  };
}

export const BeforeSave = (): MethodDecorator => registerCallback('beforeSave');
export const AfterSave = (): MethodDecorator => registerCallback('afterSave');
export const BeforeCreate = (): MethodDecorator => registerCallback('beforeCreate');
export const AfterCreate = (): MethodDecorator => registerCallback('afterCreate');
export const BeforeUpdate = (): MethodDecorator => registerCallback('beforeUpdate');
export const AfterUpdate = (): MethodDecorator => registerCallback('afterUpdate');
export const BeforeDestroy = (): MethodDecorator => registerCallback('beforeDestroy');
export const AfterDestroy = (): MethodDecorator => registerCallback('afterDestroy');

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

/**
 * Returns `ctor`'s own metadata map for `symbolKey`, creating one on first
 * use. When `ctor` doesn't have its own map yet but an ancestor does (e.g. a
 * `Timestamped(Model)` mixin registering columns/callbacks, then a further
 * subclass adding its own `@Column()`), the new map is seeded with cloned
 * copies of the inherited entries — a shallow `Map` copy alone would share
 * the same array *values*, so a subclass's `.push()` would silently mutate
 * its ancestor's list too.
 */
function ownMetadataMap<K, V>(ctor: any, symbolKey: symbol, cloneValue: (v: V) => V): Map<K, V> {
  if (!Object.prototype.hasOwnProperty.call(ctor, symbolKey)) {
    const inherited: Map<K, V> | undefined = ctor[symbolKey];
    const fresh = new Map<K, V>();
    if (inherited) {
      for (const [key, value] of inherited) fresh.set(key, cloneValue(value));
    }
    ctor[symbolKey] = fresh;
  }
  return ctor[symbolKey];
}

function ownCallbackList(ctor: any, type: CallbackType): string[] {
  const map = ownMetadataMap<CallbackType, string[]>(ctor, CALLBACKS, (methods) => [...methods]);
  const list = map.get(type) ?? [];
  map.set(type, list);
  return list;
}

function ownColumns(ctor: any): Map<string, ColumnOptions> {
  return ownMetadataMap<string, ColumnOptions>(ctor, COLUMNS, (options) => ({ ...options }));
}

function ownValidationList(ctor: any, attribute: string): ValidationRule[] {
  const map = ownMetadataMap<string, ValidationRule[]>(ctor, VALIDATIONS, (rules) => [...rules]);
  const list = map.get(attribute) ?? [];
  map.set(attribute, list);
  return list;
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
export function Delegate(attributes: string[], options: { to: string }): ClassDecorator {
  return (target: any) => {
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

  const columns = ownColumns(WithTimestamps);
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

  ownCallbackList(WithTimestamps, 'beforeCreate').push('__stampCreatedAt');
  ownCallbackList(WithTimestamps, 'beforeUpdate').push('__stampUpdatedAt');

  return WithTimestamps;
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
export function Enum(attribute: string, values: Record<string, number | string>): ClassDecorator {
  return (target: any) => {
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
