import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { AfterSave, Column, PrimaryKey } from './decorators';

let afterSaveSnapshot: { isChanged: boolean; previousChanges: Record<string, [any, any]> } | null;

class User extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column()
  email!: string;

  @AfterSave()
  captureStateDuringCallback() {
    afterSaveSnapshot = { isChanged: this.isChanged, previousChanges: this.previousChanges };
  }
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  afterSaveSnapshot = null;
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

describe('new (unpersisted) records', () => {
  it('is changed once attributes are set, with [undefined, value] pairs', () => {
    const user = new User({ name: 'Alice', email: 'alice@example.com' });
    expect(user.isChanged).toBe(true);
    expect(user.changes).toEqual({
      name: [undefined, 'Alice'],
      email: [undefined, 'alice@example.com'],
    });
    expect(user.isAttributeChanged('name')).toBe(true);
  });

  it('an attribute never assigned is not reported as changed', () => {
    const user = new User({ name: 'Alice' });
    expect(user.isAttributeChanged('email')).toBe(false);
  });
});

describe('loaded records', () => {
  it('is not changed right after find()', async () => {
    const created = await User.create({ name: 'Alice', email: 'alice@example.com' });
    const found = await User.find(created.id);

    expect(found!.isChanged).toBe(false);
    expect(found!.changes).toEqual({});
  });

  it('assigning a new value marks only that attribute changed', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });

    user.email = 'alice@newdomain.com';

    expect(user.isChanged).toBe(true);
    expect(user.isAttributeChanged('email')).toBe(true);
    expect(user.isAttributeChanged('name')).toBe(false);
    expect(user.changes).toEqual({ email: ['alice@example.com', 'alice@newdomain.com'] });
  });

  it('reassigning the same value does not mark the attribute changed', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    user.name = 'Alice';
    expect(user.isChanged).toBe(false);
  });
});

describe('save() resets tracking and populates previousChanges', () => {
  it('clears changes and records previousChanges after create', async () => {
    const user = new User({ name: 'Alice', email: 'alice@example.com' });
    await user.save();

    expect(user.isChanged).toBe(false);
    expect(user.previousChanges).toEqual({
      name: [undefined, 'Alice'],
      email: [undefined, 'alice@example.com'],
    });
  });

  it('clears changes and records previousChanges after update', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });

    user.email = 'alice@newdomain.com';
    await user.save();

    expect(user.isChanged).toBe(false);
    expect(user.previousChanges).toEqual({ email: ['alice@example.com', 'alice@newdomain.com'] });
  });

  it('previousChanges is empty after a no-op save', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    await user.save();
    expect(user.previousChanges).toEqual({});
  });

  it('afterSave callbacks see the post-save state: not changed, but previousChanges populated', async () => {
    await User.create({ name: 'Alice', email: 'alice@example.com' });
    expect(afterSaveSnapshot).toEqual({
      isChanged: false,
      previousChanges: { name: [undefined, 'Alice'], email: [undefined, 'alice@example.com'] },
    });
  });
});

describe('partial writes', () => {
  it('save() only sends changed columns, so concurrent edits to different columns both survive', async () => {
    const created = await User.create({ name: 'Alice', email: 'alice@example.com' });

    const copyA = await User.find(created.id);
    const copyB = await User.find(created.id);

    copyA!.name = 'Alicia';
    copyB!.email = 'alice@newdomain.com';

    await copyA!.save();
    await copyB!.save();

    const final = await User.find(created.id);
    expect(final!.name).toBe('Alicia');
    expect(final!.email).toBe('alice@newdomain.com');
  });
});

describe('reload()', () => {
  it('discards unsaved changes and resets dirty tracking', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    user.name = 'Something Else';
    expect(user.isChanged).toBe(true);

    await user.reload();

    expect(user.name).toBe('Alice');
    expect(user.isChanged).toBe(false);
  });

  it('throws if the row no longer exists', async () => {
    const user = await User.create({ name: 'Alice', email: 'alice@example.com' });
    await user.destroy();
    await expect(user.reload()).rejects.toThrow();
  });
});
