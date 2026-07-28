import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey } from './decorators';

class User extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column()
  active!: number;
}

let knex: Knex;
let queryCount: number;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
  knex.on('query', () => queryCount++);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('users');
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name');
    t.integer('active').defaultTo(1);
  });
  queryCount = 0;
});

afterAll(async () => {
  await knex.destroy();
});

describe('pluck', () => {
  it('returns just the requested column, as raw values', async () => {
    await User.create({ name: 'Bob' });
    await User.create({ name: 'Alice' });

    const names = await User.all().order('name', 'asc').pluck('name');
    expect(names).toEqual(['Alice', 'Bob']);
  });

  it('respects where() filtering', async () => {
    await User.create({ name: 'Alice', active: 1 });
    await User.create({ name: 'Bob', active: 0 });

    const names = await User.where({ active: 1 } as any).pluck('name');
    expect(names).toEqual(['Alice']);
  });
});

describe('count', () => {
  it('counts every row for all()', async () => {
    await User.create({ name: 'Alice' });
    await User.create({ name: 'Bob' });
    expect(await User.all().count()).toBe(2);
  });

  it('counts only matching rows for where()', async () => {
    await User.create({ name: 'Alice', active: 1 });
    await User.create({ name: 'Bob', active: 0 });
    await User.create({ name: 'Carol', active: 1 });

    expect(await User.where({ active: 1 } as any).count()).toBe(2);
  });

  it('is 0 for an empty table', async () => {
    expect(await User.all().count()).toBe(0);
  });
});

describe('exists', () => {
  it('is true when a matching row exists', async () => {
    await User.create({ name: 'Alice' });
    expect(await User.where({ name: 'Alice' } as any).exists()).toBe(true);
  });

  it('is false when no row matches', async () => {
    await User.create({ name: 'Alice' });
    expect(await User.where({ name: 'Bob' } as any).exists()).toBe(false);
  });

  it('is false for an empty table', async () => {
    expect(await User.all().exists()).toBe(false);
  });
});

describe('deleteAll', () => {
  it('deletes every matching row and returns the count deleted', async () => {
    await User.create({ name: 'Alice', active: 1 });
    await User.create({ name: 'Bob', active: 0 });
    await User.create({ name: 'Carol', active: 1 });

    const deleted = await User.where({ active: 1 } as any).deleteAll();

    expect(deleted).toBe(2);
    expect(await User.all().pluck('name')).toEqual(['Bob']);
  });

  it('deletes nothing and returns 0 when no rows match', async () => {
    await User.create({ name: 'Alice', active: 1 });

    const deleted = await User.where({ name: 'Nobody' } as any).deleteAll();

    expect(deleted).toBe(0);
    expect(await User.all().count()).toBe(1);
  });

  it('issues a single bulk statement rather than one query per row', async () => {
    await User.create({ name: 'Alice' });
    await User.create({ name: 'Bob' });
    await User.create({ name: 'Carol' });
    queryCount = 0;

    await User.all().deleteAll();

    expect(queryCount).toBe(1);
  });
});

describe('destroyAll', () => {
  it('destroys every matching row and returns the count destroyed', async () => {
    await User.create({ name: 'Alice', active: 1 });
    await User.create({ name: 'Bob', active: 0 });
    await User.create({ name: 'Carol', active: 1 });

    const destroyed = await User.where({ active: 1 } as any).destroyAll();

    expect(destroyed).toBe(2);
    expect(await User.all().pluck('name')).toEqual(['Bob']);
  });

  it('destroys nothing and returns 0 when no rows match', async () => {
    await User.create({ name: 'Alice', active: 1 });

    const destroyed = await User.where({ name: 'Nobody' } as any).destroyAll();

    expect(destroyed).toBe(0);
    expect(await User.all().count()).toBe(1);
  });

  it('issues one query per record plus the initial SELECT, unlike deleteAll()', async () => {
    await User.create({ name: 'Alice' });
    await User.create({ name: 'Bob' });
    await User.create({ name: 'Carol' });
    queryCount = 0;

    await User.all().destroyAll();

    expect(queryCount).toBe(4); // 1 SELECT + 3 DELETEs
  });
});

describe('findEach / findInBatches', () => {
  beforeEach(async () => {
    for (let i = 1; i <= 7; i++) {
      await User.create({ name: `User ${i}` });
    }
  });

  it('findInBatches yields batches of the requested size, last one partial', async () => {
    const sizes: number[] = [];
    for await (const batch of User.findInBatches({ batchSize: 3 })) {
      sizes.push(batch.length);
    }
    expect(sizes).toEqual([3, 3, 1]);
  });

  it('findInBatches issues one query per batch (cursor pagination, not one giant SELECT)', async () => {
    queryCount = 0;
    for await (const _batch of User.findInBatches({ batchSize: 3 })) {
      // just draining the generator
    }
    expect(queryCount).toBe(3);
  });

  it('findEach visits every record exactly once, in primary-key order', async () => {
    const ids: number[] = [];
    for await (const user of User.findEach({ batchSize: 3 })) {
      ids.push(user.id);
    }
    expect(ids).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('yields nothing for an empty table', async () => {
    await knex('users').del();
    const seen: number[] = [];
    for await (const user of User.findEach({ batchSize: 3 })) {
      seen.push(user.id);
    }
    expect(seen).toEqual([]);
  });
});

describe('whereRaw', () => {
  it('applies a raw SQL condition with bound parameters', async () => {
    await User.create({ name: 'Alice', active: 1 });
    await User.create({ name: 'Bob', active: 0 });

    const active = await User.all().whereRaw('active = ?', [1]);
    expect(active.map((u) => u.name)).toEqual(['Alice']);
  });

  it('composes with the rest of the chain rather than replacing it', async () => {
    await User.create({ name: 'Carol', active: 1 });
    await User.create({ name: 'Alice', active: 1 });
    await User.create({ name: 'Bob', active: 0 });

    const names = await User.where({ active: 1 } as any)
      .whereRaw('name != ?', ['Carol'])
      .order('name', 'asc');
    expect(names.map((u) => u.name)).toEqual(['Alice']);
  });

  it('expresses an OR condition the object-shaped where() cannot', async () => {
    await User.create({ name: 'Alice', active: 0 });
    await User.create({ name: 'Bob', active: 0 });
    await User.create({ name: 'Carol', active: 0 });

    const matches = await User.all().whereRaw('name = ? OR name = ?', ['Alice', 'Carol']).order('name', 'asc');
    expect(matches.map((u) => u.name)).toEqual(['Alice', 'Carol']);
  });

  it('is chainable with pluck()/count()/exists() too, since they all share the same underlying builder', async () => {
    await User.create({ name: 'Alice', active: 1 });
    await User.create({ name: 'Bob', active: 0 });

    expect(await User.all().whereRaw('active = ?', [1]).count()).toBe(1);
    expect(await User.all().whereRaw('active = ?', [1]).exists()).toBe(true);
    expect(await User.all().whereRaw('active = ?', [0]).pluck('name')).toEqual(['Bob']);
  });
});
