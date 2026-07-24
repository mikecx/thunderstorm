import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey, Validates } from './decorators';
import { RecordInvalid } from './errors';

class User extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  @Validates({ presence: true })
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

describe('update()', () => {
  it('assigns attributes and saves in one call', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    const ok = await user.update({ email: 'alice@newdomain.com' });

    expect(ok).toBe(true);
    expect(user.email).toBe('alice@newdomain.com');
    const reloaded = await User.find(user.id);
    expect(reloaded!.email).toBe('alice@newdomain.com');
  });

  it('returns false and does not persist when the result is invalid', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    const ok = await user.update({ name: '' });

    expect(ok).toBe(false);
    const reloaded = await User.find(user.id);
    expect(reloaded!.name).toBe('Alice');
  });
});

describe('updateOrFail()', () => {
  it('resolves with the instance when valid', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    const result = await user.updateOrFail({ email: 'alice@newdomain.com' });
    expect(result).toBe(user);
    expect(result.email).toBe('alice@newdomain.com');
  });

  it('throws RecordInvalid and does not persist when invalid', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    await expect(user.updateOrFail({ name: '' })).rejects.toBeInstanceOf(RecordInvalid);
    const reloaded = await User.find(user.id);
    expect(reloaded!.name).toBe('Alice');
  });
});

describe('firstOrCreate()', () => {
  it('returns the existing row when one matches', async () => {
    const created = await User.create({ name: 'Alice', email: 'alice@example.com' });
    const found = await User.firstOrCreate({ name: 'Alice' });

    expect(found.id).toBe(created.id);
    expect(await User.all()).toHaveLength(1);
  });

  it('creates a new row from conditions merged with defaults when none matches', async () => {
    const user = await User.firstOrCreate({ name: 'Bob' }, { email: 'bob@example.com' });

    expect(user.isPersisted).toBe(true);
    expect(user.name).toBe('Bob');
    expect(user.email).toBe('bob@example.com');
    expect(await User.all()).toHaveLength(1);
  });

  it('defaults win over conditions on overlapping keys', async () => {
    const user = await User.firstOrCreate({ name: 'placeholder' }, { name: 'Real Name' });
    expect(user.name).toBe('Real Name');
  });
});

describe('dup()', () => {
  it('returns an unpersisted copy with the same attributes, excluding the primary key', async () => {
    const original = await User.create({ name: 'Alice', email: 'alice@example.com' });
    const copy = original.dup();

    expect(copy.isPersisted).toBe(false);
    expect(copy.id).toBeUndefined();
    expect(copy.name).toBe('Alice');
    expect(copy.email).toBe('alice@example.com');
  });

  it('the copy can be saved independently as a new row', async () => {
    const original = await User.create({ name: 'Alice', email: 'alice@example.com' });
    const copy = original.dup();
    await copy.save();

    expect(copy.id).not.toBe(original.id);
    expect(await User.all()).toHaveLength(2);
  });
});

describe('toJSON()', () => {
  it('includes only declared columns, not errors or other internals', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    expect(JSON.parse(JSON.stringify(user))).toEqual({
      id: user.id,
      name: 'Alice',
      email: 'alice@example.com',
    });
  });

  it('excludes ad-hoc properties attached by preloadHasMany/preloadBelongsTo', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    (user as any)._junk = ['should not appear'];
    const json = JSON.parse(JSON.stringify(user));
    expect(json._junk).toBeUndefined();
  });

  it('does not throw on a record with an unrelated circular reference attached', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    const circular: any = { user };
    circular.self = circular;
    (user as any)._circular = circular;

    expect(() => JSON.stringify(user)).not.toThrow();
  });
});
