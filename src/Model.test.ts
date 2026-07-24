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
  email!: string;
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('users');
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name');
    t.string('email');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('Model.create / find / all', () => {
  it('creates a persisted row and assigns the generated primary key', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    expect(user.isPersisted).toBe(true);
    expect(user.id).toBeTypeOf('number');
  });

  it('finds a row by primary key', async () => {
    const created = await User.create({ name: 'Alice', email: 'alice@example.com' });
    const found = await User.find(created.id);
    expect(found?.name).toBe('Alice');
    expect(found?.isPersisted).toBe(true);
  });

  it('returns undefined when find() has no match', async () => {
    const found = await User.find(999);
    expect(found).toBeUndefined();
  });

  it('all() returns every row', async () => {
    await User.create({ name: 'Alice', email: 'alice@example.com' });
    await User.create({ name: 'Bob', email: 'bob@example.com' });
    const all = await User.all();
    expect(all.map((u) => u.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('all() is chainable like where({}), e.g. with order() and first()', async () => {
    await User.create({ name: 'Bob', email: 'bob@example.com' });
    await User.create({ name: 'Alice', email: 'alice@example.com' });

    const orderedNames = await User.all().order('name', 'asc');
    expect(orderedNames.map((u) => u.name)).toEqual(['Alice', 'Bob']);

    const first = await User.all().order('name', 'asc').first();
    expect(first?.name).toBe('Alice');
  });
});

describe('Model.where', () => {
  beforeEach(async () => {
    await User.create({ name: 'Alice', email: 'alice@example.com' });
    await User.create({ name: 'Bob', email: 'bob@example.com' });
    await User.create({ name: 'Bob', email: 'bob2@example.com' });
  });

  it('filters by conditions and is awaitable directly', async () => {
    const bobs = await User.where({ name: 'Bob' });
    expect(bobs).toHaveLength(2);
    expect(bobs.every((u) => u.name === 'Bob')).toBe(true);
  });

  it('supports order() and first()', async () => {
    const first = await User.where({}).order('email', 'asc').first();
    expect(first?.email).toBe('alice@example.com');
  });

  it('supports limit()', async () => {
    const limited = await User.where({}).order('email', 'asc').limit(1);
    expect(limited).toHaveLength(1);
  });
});

describe('instance save / destroy', () => {
  it('updates an existing row in place', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    user.email = 'alice@newdomain.com';
    const ok = await user.save();

    expect(ok).toBe(true);
    const reloaded = await User.find(user.id);
    expect(reloaded?.email).toBe('alice@newdomain.com');
  });

  it('destroy() removes the row and flips isPersisted', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    await user.destroy();

    expect(user.isPersisted).toBe(false);
    expect(await User.find(user.id)).toBeUndefined();
  });
});
