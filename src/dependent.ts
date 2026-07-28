import { getAttr } from './AttributeModel';
import { ownCallbackList } from './decorators';
import type { Model, QueryChain } from './Model';

export type DependentAction = 'destroy' | 'delete' | 'restrict' | { update: Record<string, any> };

function isChain(value: unknown): value is QueryChain<any> {
  return !!value && typeof (value as any).destroyAll === 'function';
}

/**
 * Declares what happens to an association's related record(s) when this
 * model is destroyed — Rails' `dependent:` option. A class decorator naming
 * an already-defined association *method*, not a parameter on `hasMany`/
 * `hasOne` themselves — those are plain per-call methods in this library
 * (see AGENTS.md), not a persistent association registry a param could hook
 * into. The association is declared exactly as it always is; `@Dependent`
 * just wires cleanup to it via `afterDestroy`/`beforeDestroy`.
 *
 * Works with both chain-returning associations (`hasMany`, `hasManyThrough`,
 * `hasAndBelongsToMany`) and single-record ones (`hasOne`, `belongsTo`),
 * detected at runtime by whether the association method's return value has
 * a `.destroyAll` (chain) or not (single record / `undefined`).
 *
 * - `'destroy'` — full `destroy()` lifecycle per related record (its own
 *   `beforeDestroy`/`afterDestroy` run, including e.g. `@HasManyAttached`'s
 *   own purge if the target has one).
 * - `'delete'` — bulk `DELETE` via `deleteAll()`, no callbacks. For a
 *   single-record association this still issues one `DELETE` scoped to that
 *   record's primary key rather than reusing `destroy()`'s callback-running
 *   path — no callbacks is the point, not just fewer queries.
 * - `{ update: {...} }` — bulk `UPDATE` via `updateAll()` (a chain) or
 *   `update()` (a single record); the common case is nullifying a foreign key.
 * - `'restrict'` — blocks the destroy (`beforeDestroy` returns `false`) if
 *   any related record still exists, instead of touching them at all.
 */
export function Dependent(associationMethod: string, action: DependentAction) {
  return function (target: any, context: ClassDecoratorContext): void {
    if (action === 'restrict') {
      const checkMethod = `__dependentRestrict_${associationMethod}`;
      target.prototype[checkMethod] = async function (this: Model): Promise<boolean> {
        const result = (this as any)[associationMethod]();
        const blocked = isChain(result) ? await result.exists() : (await result) !== undefined;
        return !blocked;
      };
      ownCallbackList(context.metadata, 'beforeDestroy').push(checkMethod);
      return;
    }

    const cleanupMethod = `__dependentCleanup_${associationMethod}`;
    target.prototype[cleanupMethod] = async function (this: Model): Promise<void> {
      const result = (this as any)[associationMethod]();

      if (isChain(result)) {
        if (action === 'destroy') await result.destroyAll();
        else if (action === 'delete') await result.deleteAll();
        else await result.updateAll(action.update);
        return;
      }

      const record = await result;
      if (!record) return;

      if (action === 'destroy') {
        await record.destroy();
      } else if (action === 'delete') {
        const ctor = record.constructor as typeof Model;
        await ctor.where({ [ctor.primaryKey]: getAttr(record, ctor.primaryKey) } as any).deleteAll();
      } else {
        await record.update(action.update);
      }
    };
    ownCallbackList(context.metadata, 'afterDestroy').push(cleanupMethod);
  };
}
