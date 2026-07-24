import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey, Validates } from './decorators';
import { RecordInvalid, RecordNotSaved } from './errors';

class User extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  @Validates({ presence: true })
  @Validates({ uniqueness: true })
  email!: string;

  @Column()
  organizationId!: number;

  @Column()
  @Validates({ uniqueness: { scope: 'organizationId' }, message: 'is already taken in this organization' })
  handle!: string;
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
    t.string('email');
    t.integer('organizationId');
    t.string('handle');
  });
  queryCount = 0;
});

afterAll(async () => {
  await knex.destroy();
});

describe('uniqueness validation', () => {
  it('allows a unique value on create', async () => {
    const user = await User.create({ email: 'alice@example.com' });
    expect(user.isPersisted).toBe(true);
  });

  it('rejects a duplicate value on create', async () => {
    await User.create({ email: 'alice@example.com' });
    const dup = await User.create({ email: 'alice@example.com' });

    expect(dup.isPersisted).toBe(false);
    expect(dup.errors.on('email')).toContain('has already been taken');
  });

  it('never hits the database for uniqueness when the record is already otherwise invalid', async () => {
    queryCount = 0;
    const invalid = await User.create({ email: '' });

    expect(invalid.isPersisted).toBe(false);
    expect(invalid.errors.on('email')).toContain("can't be blank");
    expect(invalid.errors.on('email')).not.toContain('has already been taken');
    expect(queryCount).toBe(0); // isValid() failed, so save() returned before checkUniqueness() ever ran
  });

  it('updating a record without changing the unique field does not flag itself as a duplicate', async () => {
    const user = await User.create({ email: 'alice@example.com' });
    const ok = await user.update({ organizationId: 5 });
    expect(ok).toBe(true);
  });

  it('updating a record to a value already used by a different record is rejected', async () => {
    await User.create({ email: 'alice@example.com' });
    const bob = await User.create({ email: 'bob@example.com' });

    const ok = await bob.update({ email: 'alice@example.com' });
    expect(ok).toBe(false);
    expect(bob.errors.on('email')).toContain('has already been taken');
  });

  it('updating a record to its own current value is fine (self-exclusion works via the primary key)', async () => {
    const user = await User.create({ email: 'alice@example.com' });
    const ok = await user.update({ email: 'alice@example.com' });
    expect(ok).toBe(true);
  });

  it('scoped uniqueness allows the same value in a different scope', async () => {
    await User.create({ email: 'a@example.com', organizationId: 1, handle: 'root' });
    const otherOrg = await User.create({ email: 'b@example.com', organizationId: 2, handle: 'root' });
    expect(otherOrg.isPersisted).toBe(true);
  });

  it('scoped uniqueness rejects the same value within the same scope, with the custom message', async () => {
    await User.create({ email: 'a@example.com', organizationId: 1, handle: 'root' });
    const dup = await User.create({ email: 'b@example.com', organizationId: 1, handle: 'root' });

    expect(dup.isPersisted).toBe(false);
    expect(dup.errors.on('handle')).toContain('is already taken in this organization');
  });

  it('saveOrFail() throws RecordInvalid (not RecordNotSaved) on a uniqueness violation', async () => {
    await User.create({ email: 'alice@example.com' });
    const dup = new User({ email: 'alice@example.com' });

    await expect(dup.saveOrFail()).rejects.toBeInstanceOf(RecordInvalid);
    await expect(dup.saveOrFail()).rejects.not.toBeInstanceOf(RecordNotSaved);
  });

  it('blank values are never considered duplicates of each other', async () => {
    const first = await User.create({ email: 'unique1@example.com', handle: '' });
    expect(first.isPersisted).toBe(true);
    const second = await User.create({ email: 'unique2@example.com', handle: '' });
    expect(second.isPersisted).toBe(true);
  });
});
