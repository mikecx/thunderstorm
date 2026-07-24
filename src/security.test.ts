import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey, SecurePassword, SecureToken } from './decorators';
import { generateToken, hashPassword, verifyPassword } from './security';

class User extends SecurePassword(Model) {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  email!: string;
}

class ApiKey extends SecureToken(Model) {
  static tableName = 'api_keys';

  @PrimaryKey()
  id!: number;

  @Column()
  label!: string;
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
    t.string('email');
    t.string('passwordDigest');
  });
  await knex.schema.dropTableIfExists('api_keys');
  await knex.schema.createTable('api_keys', (t) => {
    t.increments('id');
    t.string('label');
    t.string('token');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('security.ts primitives', () => {
  it('hashPassword/verifyPassword round-trip correctly', async () => {
    const digest = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', digest)).toBe(true);
    expect(await verifyPassword('wrong password', digest)).toBe(false);
  });

  it('two hashes of the same password are different (random salt per hash)', async () => {
    const a = await hashPassword('same password');
    const b = await hashPassword('same password');
    expect(a).not.toBe(b);
  });

  it('generateToken produces distinct, reasonably long URL-safe strings', () => {
    const a = generateToken();
    const b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('SecurePassword mixin', () => {
  it('requires a password on create', async () => {
    const user = new User({ email: 'alice@example.com' });
    const ok = await user.save();
    expect(ok).toBe(false);
    expect(user.errors.on('password')).toContain("can't be blank");
  });

  it('hashes the password into passwordDigest on create, never storing it in the clear', async () => {
    const user = await User.create({ email: 'alice@example.com', password: 'hunter2' });
    expect(user.isPersisted).toBe(true);
    expect(user.passwordDigest).toBeDefined();
    expect(user.passwordDigest).not.toContain('hunter2');
  });

  it('authenticate() verifies the correct password and rejects the wrong one', async () => {
    const user = await User.create({ email: 'alice@example.com', password: 'hunter2' });
    expect(await user.authenticate('hunter2')).toBe(true);
    expect(await user.authenticate('wrong')).toBe(false);
  });

  it('rejects a mismatched passwordConfirmation', async () => {
    const user = new User({ email: 'alice@example.com', password: 'hunter2', passwordConfirmation: 'nope' });
    const ok = await user.save();
    expect(ok).toBe(false);
    expect(user.errors.on('passwordConfirmation')).toContain("doesn't match password");
  });

  it('accepts a matching passwordConfirmation', async () => {
    const user = await User.create({
      email: 'alice@example.com',
      password: 'hunter2',
      passwordConfirmation: 'hunter2',
    });
    expect(user.isPersisted).toBe(true);
  });

  it('updating other fields without touching password leaves the digest untouched', async () => {
    const user = await User.create({ email: 'alice@example.com', password: 'hunter2' });
    const originalDigest = user.passwordDigest;

    await user.update({ email: 'alice@newdomain.com' });

    expect(user.passwordDigest).toBe(originalDigest);
    expect(await user.authenticate('hunter2')).toBe(true);
  });

  it('updating with a new password re-hashes it and invalidates the old one', async () => {
    const user = await User.create({ email: 'alice@example.com', password: 'hunter2' });
    await user.update({ password: 'newpassword' });

    expect(await user.authenticate('newpassword')).toBe(true);
    expect(await user.authenticate('hunter2')).toBe(false);
  });

  it('passwordDigest is guarded — excluded from permit() even with an explicit allowlist', () => {
    const filtered = User.permit({ passwordDigest: 'fake-hash', email: 'x' }, ['passwordDigest', 'email'] as any);
    expect('passwordDigest' in filtered).toBe(false);
    expect(filtered.email).toBe('x');
  });

  it('passwordDigest is excluded from default serialization', async () => {
    const user = await User.create({ email: 'alice@example.com', password: 'hunter2' });
    const json = JSON.parse(JSON.stringify(user));
    expect(json.passwordDigest).toBeUndefined();
    expect(json.password).toBeUndefined(); // virtual
  });
});

describe('SecureToken mixin', () => {
  it('generates a token on create if none was given', async () => {
    const key = await ApiKey.create({ label: 'ci' });
    expect(key.token).toBeDefined();
    expect(key.token.length).toBeGreaterThan(20);
  });

  it('does not overwrite a token explicitly provided on create', async () => {
    const key = await ApiKey.create({ label: 'ci', token: 'my-own-token' });
    expect(key.token).toBe('my-own-token');
  });

  it('regenerateToken() replaces the token and persists the change', async () => {
    const key = await ApiKey.create({ label: 'ci' });
    const original = key.token;

    const ok = await key.regenerateToken();
    expect(ok).toBe(true);
    expect(key.token).not.toBe(original);

    const reloaded = await ApiKey.find(key.id);
    expect(reloaded!.token).toBe(key.token);
  });

  it('token is guarded — excluded from permit() even with an explicit allowlist', () => {
    const filtered = ApiKey.permit({ token: 'attacker-supplied', label: 'x' }, ['token', 'label'] as any);
    expect('token' in filtered).toBe(false);
    expect(filtered.label).toBe('x');
  });
});
