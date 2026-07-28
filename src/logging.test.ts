import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey } from './decorators';
import { logQueries, QueryLogInfo } from './logging';

class Widget extends Model {
  static tableName = 'widgets';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('widgets');
  await knex.schema.createTable('widgets', (t) => {
    t.increments('id');
    t.string('name');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('logQueries', () => {
  it('calls the formatter once per query, with the SQL, bindings, and a non-negative duration', async () => {
    const logged: QueryLogInfo[] = [];
    logQueries(knex, (info) => logged.push(info));

    await Widget.create({ name: 'Gadget' } as any);

    const insert = logged.find((info) => /insert/i.test(info.sql));
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/widgets/i);
    expect(insert!.bindings).toContain('Gadget');
    expect(insert!.ms).toBeGreaterThanOrEqual(0);
  });

  it('correlates start/end correctly across multiple in-flight queries, not just one at a time', async () => {
    const logged: QueryLogInfo[] = [];
    logQueries(knex, (info) => logged.push(info));

    await Promise.all([
      Widget.create({ name: 'A' } as any),
      Widget.create({ name: 'B' } as any),
      Widget.create({ name: 'C' } as any),
    ]);

    const inserts = logged.filter((info) => /insert/i.test(info.sql));
    expect(inserts).toHaveLength(3);
    const names = inserts.map((info) => info.bindings[0]).sort();
    expect(names).toEqual(['A', 'B', 'C']);
    for (const info of inserts) {
      expect(info.ms).toBeGreaterThanOrEqual(0);
    }
  });

  it('logs failed queries too, via query-error', async () => {
    const logged: QueryLogInfo[] = [];
    logQueries(knex, (info) => logged.push(info));

    await expect(knex.raw('select * from no_such_table')).rejects.toThrow();

    expect(logged.some((info) => /no_such_table/i.test(info.sql))).toBe(true);
  });

  it('falls back to a default console formatter when none is given', async () => {
    expect(() => logQueries(knex)).not.toThrow();
    await expect(Widget.create({ name: 'Defaulted' } as any)).resolves.toBeDefined();
  });
});
