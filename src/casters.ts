export interface Caster<T = any> {
  load(raw: any): T;
  save(value: T): any;
}

export type ColumnType = 'string' | 'number' | 'boolean' | 'date' | 'json';

/**
 * Built-in casters. `boolean.save` intentionally passes the JS value through
 * unchanged: Knex's sqlite3 dialect already converts true/false to 1/0 for
 * every param, and Postgres/MySQL drivers accept real booleans natively —
 * converting here ourselves would only break the non-sqlite dialects.
 */
export const CASTERS: Record<ColumnType, Caster> = {
  string: {
    load: (v) => (v == null ? v : String(v)),
    save: (v) => (v == null ? v : String(v)),
  },
  number: {
    load: (v) => (v == null ? v : Number(v)),
    save: (v) => (v == null ? v : Number(v)),
  },
  boolean: {
    load: (v) => (v == null ? v : Boolean(v)),
    save: (v) => v,
  },
  date: {
    load: (v) => (v == null || v instanceof Date ? v : new Date(v)),
    save: (v) => (v == null ? v : v instanceof Date ? v.toISOString() : v),
  },
  json: {
    load: (v) => (v == null || typeof v !== 'string' ? v : JSON.parse(v)),
    save: (v) => (v == null ? v : JSON.stringify(v)),
  },
};

export function resolveCaster(type: ColumnType | Caster): Caster {
  return typeof type === 'string' ? CASTERS[type] : type;
}
