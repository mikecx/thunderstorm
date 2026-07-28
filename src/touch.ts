import { ownCallbackList } from './decorators';
import type { Model } from './Model';

/**
 * Cascades `touch()` up to a `belongsTo`/`hasOne` parent whenever this
 * record is created, saved, or destroyed — mirrors `belongs_to ...,
 * touch: true`. Declared on the child (the side holding the foreign key),
 * naming the association method that resolves the parent — the same "name
 * an existing association method, don't add a param to hasMany/belongsTo"
 * shape `@Dependent`/`@CounterCache` already use (see AGENTS.md).
 *
 * Goes through the resolved parent's own `touch()` rather than writing
 * `updatedAt` itself, so a `noTouching()` block silently suppresses this
 * cascade too — no separate check needed here.
 */
export function Touch(associationMethod: string) {
  return function (target: any, context: ClassDecoratorContext): void {
    async function touchParent(this: Model): Promise<void> {
      const parent = await (this as any)[associationMethod]();
      if (!parent) return;
      await (parent as Model).touch();
    }

    const methodName = `__touchParent_${associationMethod}`;
    target.prototype[methodName] = function (this: Model) {
      return touchParent.call(this);
    };

    ownCallbackList(context.metadata, 'afterCreate').push(methodName);
    ownCallbackList(context.metadata, 'afterUpdate').push(methodName);
    ownCallbackList(context.metadata, 'afterDestroy').push(methodName);
  };
}
