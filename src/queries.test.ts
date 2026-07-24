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
