import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect, transaction } from './Model';
import { Column, PrimaryKey } from './decorators';

class Account extends Model {
  static tableName = 'accounts';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column()
  balance!: number;
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('accounts');
  await knex.schema.createTable('accounts', (t) => {
    t.increments('id');
    t.string('name');
    t.integer('balance');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('transaction()', () => {
  it('commits every write made inside it when fn resolves', async () => {
    await transaction(async () => {
      await Account.create({ name: 'Alice', balance: 100 });
      await Account.create({ name: 'Bob', balance: 50 });
    });

    expect(await Account.all()).toHaveLength(2);
  });

  it('rolls back every write made inside it when fn throws', async () => {
    await expect(
      transaction(async () => {
        await Account.create({ name: 'Alice', balance: 100 });
        throw new Error('simulated failure');
      })
    ).rejects.toThrow('simulated failure');

    expect(await Account.all()).toHaveLength(0);
  });

  it('rolls back a partially-completed multi-step operation on failure midway through', async () => {
    const alice = await Account.create({ name: 'Alice', balance: 100 });
    const bob = await Account.create({ name: 'Bob', balance: 50 });

    await expect(
      transaction(async () => {
        alice.balance -= 30;
        await alice.save();
        bob.balance += 30;
        await bob.save();
        throw new Error('oops, abort the transfer');
      })
    ).rejects.toThrow();

    const reloadedAlice = await Account.find(alice.id);
    const reloadedBob = await Account.find(bob.id);
    expect(reloadedAlice!.balance).toBe(100);
    expect(reloadedBob!.balance).toBe(50);
  });

  it('a successful multi-step operation persists all its writes together', async () => {
    const alice = await Account.create({ name: 'Alice', balance: 100 });
    const bob = await Account.create({ name: 'Bob', balance: 50 });

    await transaction(async () => {
      alice.balance -= 30;
      await alice.save();
      bob.balance += 30;
      await bob.save();
    });

    const reloadedAlice = await Account.find(alice.id);
    const reloadedBob = await Account.find(bob.id);
    expect(reloadedAlice!.balance).toBe(70);
    expect(reloadedBob!.balance).toBe(80);
  });

  it('a nested transaction() call reuses the outer transaction rather than erroring', async () => {
    await transaction(async () => {
      await Account.create({ name: 'Alice', balance: 100 });
      await transaction(async () => {
        await Account.create({ name: 'Bob', balance: 50 });
      });
    });

    expect(await Account.all()).toHaveLength(2);
  });

  it('an inner nested transaction() throwing rolls back everything in the outer transaction too', async () => {
    await expect(
      transaction(async () => {
        await Account.create({ name: 'Alice', balance: 100 });
        await transaction(async () => {
          await Account.create({ name: 'Bob', balance: 50 });
          throw new Error('inner failure');
        });
      })
    ).rejects.toThrow('inner failure');

    expect(await Account.all()).toHaveLength(0);
  });

  it('Model.transaction is an equivalent alias', async () => {
    await Account.transaction(async () => {
      await Account.create({ name: 'Alice', balance: 100 });
    });
    expect(await Account.all()).toHaveLength(1);
  });

  it('queries outside a transaction are unaffected by one that ran earlier', async () => {
    await transaction(async () => {
      await Account.create({ name: 'Alice', balance: 100 });
    });
    await Account.create({ name: 'Bob', balance: 50 });
    expect(await Account.all()).toHaveLength(2);
  });
});
