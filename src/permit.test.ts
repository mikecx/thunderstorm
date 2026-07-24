import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey, Validates } from './decorators';

class User extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  @Validates({ presence: true })
  name!: string;

  @Column()
  email!: string;

  @Column({ guarded: true })
  role!: string;

  @Column({ guarded: true })
  passwordDigest!: string;
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
    t.string('role').defaultTo('member');
    t.string('passwordDigest');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('permit()', () => {
  it('drops keys that are not declared @Column() fields at all', () => {
    const filtered = User.permit({ name: 'Alice', notAColumn: 'x' });
    expect(filtered).toEqual({ name: 'Alice' });
    expect('notAColumn' in filtered).toBe(false);
  });

  it('always excludes the primary key, even without an allowlist', () => {
    const filtered = User.permit({ id: 999, name: 'Alice' });
    expect('id' in filtered).toBe(false);
    expect(filtered.name).toBe('Alice');
  });

  it('always excludes guarded columns, even without an allowlist', () => {
    const filtered = User.permit({ name: 'Alice', role: 'admin', passwordDigest: 'x' });
    expect('role' in filtered).toBe(false);
    expect('passwordDigest' in filtered).toBe(false);
    expect(filtered.name).toBe('Alice');
  });

  it('guarded columns stay excluded even if named in an explicit allowlist', () => {
    const filtered = User.permit({ name: 'Alice', role: 'admin' }, ['name', 'role'] as any);
    expect('role' in filtered).toBe(false);
    expect(filtered.name).toBe('Alice');
  });

  it('an explicit allowlist narrows down to just those keys', () => {
    const filtered = User.permit({ name: 'Alice', email: 'alice@example.com' }, ['name']);
    expect(filtered).toEqual({ name: 'Alice' });
    expect('email' in filtered).toBe(false);
  });

  it('only includes keys actually present in the raw input', () => {
    const filtered = User.permit({ name: 'Alice' }, ['name', 'email']);
    expect(filtered).toEqual({ name: 'Alice' });
    expect('email' in filtered).toBe(false);
  });

  it('the filtered result is safe to pass straight to create()', async () => {
    const maliciousRequestBody = { name: 'Alice', email: 'alice@example.com', role: 'admin' };

    const user = await User.create(User.permit(maliciousRequestBody, ['name', 'email']));
    expect(user.isPersisted).toBe(true);
    expect(user.name).toBe('Alice');

    const reloaded = await User.find(user.id);
    expect(reloaded!.role).toBe('member'); // the table's own default — never got a chance to be 'admin'
  });

  it('demonstrates the actual vulnerability create() has without permit()', async () => {
    const maliciousRequestBody = { name: 'Eve', email: 'eve@example.com', role: 'admin' };

    // create()/update()/the constructor are intentionally NOT guarded — they're
    // used by trusted internal code too — so passing a raw body straight
    // through does let role slip in. This is exactly why permit() exists.
    const user = await User.create(maliciousRequestBody);
    expect(user.role).toBe('admin');
  });
});
