import { getAttr } from './AttributeModel';
import { ownCallbackList } from './decorators';
import type { Model } from './Model';

/**
 * Auto-maintains a count column on the *other* side of a `belongsTo`/`hasOne`
 * association — mirrors `belongs_to ..., counter_cache: true`. Declared on
 * the child (the side holding the foreign key), naming the association
 * method that resolves the parent and the column on the parent to bump —
 * the same "name an existing association method, don't add a param to
 * hasMany/belongsTo" shape `@Dependent` already uses (see AGENTS.md).
 *
 * Only create and destroy are handled — incrementing/decrementing the
 * parent's column via `.increment()`/`.decrement()`, a single atomic
 * `UPDATE ... SET column = column + 1` rather than load-then-save, so
 * concurrent creates/destroys can't clobber each other's count. Reassigning
 * the child's foreign key on an existing record (moving it from one parent
 * to another) does **not** move the count — that would need the foreign key
 * column name threaded through explicitly to diff the old and new parent,
 * which isn't worth the complexity this decorator exists to avoid. Update
 * both counts by hand if you need that.
 */
export function CounterCache(associationMethod: string, column: string) {
  return function (target: any, context: ClassDecoratorContext): void {
    async function bump(this: Model, amount: 1 | -1): Promise<void> {
      const parent = await (this as any)[associationMethod]();
      if (!parent) return;
      const parentCtor = parent.constructor as typeof Model;
      const pk = parentCtor.primaryKey;
      const qb = parentCtor.query().where(pk, getAttr(parent, pk));
      if (amount === 1) await qb.increment(column, 1);
      else await qb.decrement(column, 1);
    }

    const incrementMethod = `__counterCacheIncrement_${associationMethod}`;
    target.prototype[incrementMethod] = function (this: Model) {
      return bump.call(this, 1);
    };
    ownCallbackList(context.metadata, 'afterCreate').push(incrementMethod);

    const decrementMethod = `__counterCacheDecrement_${associationMethod}`;
    target.prototype[decrementMethod] = function (this: Model) {
      return bump.call(this, -1);
    };
    ownCallbackList(context.metadata, 'afterDestroy').push(decrementMethod);
  };
}
