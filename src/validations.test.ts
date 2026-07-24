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
  @Validates({ presence: true, length: { min: 2, max: 10 } })
  name!: string;

  @Column()
  @Validates({ presence: true })
  @Validates({ format: { with: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }, message: 'is not a valid email address' })
  email!: string;

  @Column()
  @Validates({ inclusion: { in: ['admin', 'member'] as const }, allowBlank: true })
  role?: string;
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
    t.string('role');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('isValid / errors', () => {
  it('is valid when every rule passes', () => {
    const user = new User({ name: 'Alice', email: 'alice@example.com' });
    expect(user.isValid()).toBe(true);
    expect(user.errors.isEmpty).toBe(true);
  });

  it('reports a presence failure', () => {
    const user = new User({ email: 'alice@example.com' });
    expect(user.isValid()).toBe(false);
    expect(user.errors.on('name')).toContain("can't be blank");
  });

  it('reports length failures with the default messages', () => {
    const tooShort = new User({ name: 'A', email: 'alice@example.com' });
    expect(tooShort.isValid()).toBe(false);
    expect(tooShort.errors.on('name')).toContain('is too short (minimum is 2 characters)');

    const tooLong = new User({ name: 'A'.repeat(11), email: 'alice@example.com' });
    expect(tooLong.isValid()).toBe(false);
    expect(tooLong.errors.on('name')).toContain('is too long (maximum is 10 characters)');
  });

  it('reports a format failure with a custom message', () => {
    const user = new User({ name: 'Alice', email: 'not-an-email' });
    expect(user.isValid()).toBe(false);
    expect(user.errors.on('email')).toContain('is not a valid email address');
  });

  it('reports an inclusion failure only when the value is present (allowBlank)', () => {
    const badRole = new User({ name: 'Alice', email: 'alice@example.com', role: 'root' });
    expect(badRole.isValid()).toBe(false);
    expect(badRole.errors.on('role')).toContain('is not included in the list');

    const noRole = new User({ name: 'Alice', email: 'alice@example.com' });
    expect(noRole.isValid()).toBe(true);
  });

  it('accumulates errors across multiple invalid fields', () => {
    const user = new User({ name: '', email: 'bad' });
    expect(user.isValid()).toBe(false);
    expect(user.errors.full.length).toBeGreaterThanOrEqual(2);
  });

  it('clears stale errors on re-validation', () => {
    const user = new User({});
    user.isValid();
    expect(user.errors.isEmpty).toBe(false);

    user.name = 'Alice';
    user.email = 'alice@example.com';
    user.isValid();
    expect(user.errors.isEmpty).toBe(true);
  });
});

describe('custom validator and validate() hook', () => {
  it('runs a validator function and can fail with a returned message', () => {
    class Account extends Model {
      static tableName = 'users';

      @Column()
      @Validates({
        validator: (value: number) => (value < 0 ? 'must not be negative' : null),
      })
      balance!: number;
    }

    const account = new Account({ balance: -5 });
    expect(account.isValid()).toBe(false);
    expect(account.errors.on('balance')).toContain('must not be negative');
  });

  it('supports cross-field checks via the validate() hook', () => {
    class SignupForm extends Model {
      static tableName = 'users';

      @Column()
      password!: string;

      @Column()
      passwordConfirmation!: string;

      protected validate(): void {
        if (this.password !== this.passwordConfirmation) {
          this.errors.add('passwordConfirmation', "doesn't match password");
        }
      }
    }

    const mismatched = new SignupForm({ password: 'a', passwordConfirmation: 'b' });
    expect(mismatched.isValid()).toBe(false);
    expect(mismatched.errors.on('passwordConfirmation')).toContain("doesn't match password");

    const matched = new SignupForm({ password: 'a', passwordConfirmation: 'a' });
    expect(matched.isValid()).toBe(true);
  });
});

describe('save() / saveOrFail() integration with validations', () => {
  it('save() returns false and does not persist an invalid record', async () => {
    const user = new User({ name: 'A', email: 'not-an-email' });
    const ok = await user.save();

    expect(ok).toBe(false);
    expect(user.isPersisted).toBe(false);
    expect(user.errors.isEmpty).toBe(false);
    expect(await User.all()).toHaveLength(0);
  });

  it('save() persists a valid record and returns true', async () => {
    const user = new User({ name: 'Alice', email: 'alice@example.com' });
    const ok = await user.save();

    expect(ok).toBe(true);
    expect(user.isPersisted).toBe(true);
    expect(await User.all()).toHaveLength(1);
  });

  it('saveOrFail() throws RecordInvalid and leaves the record unpersisted', async () => {
    const user = new User({ name: 'A', email: 'not-an-email' });

    await expect(user.saveOrFail()).rejects.toBeInstanceOf(RecordInvalid);
    expect(user.isPersisted).toBe(false);
  });

  it('saveOrFail() resolves with the instance when valid', async () => {
    const user = new User({ name: 'Alice', email: 'alice@example.com' });
    const result = await user.saveOrFail();
    expect(result).toBe(user);
    expect(result.isPersisted).toBe(true);
  });
});
