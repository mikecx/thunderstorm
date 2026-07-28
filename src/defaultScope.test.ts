import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey, DefaultScope } from './decorators';

@DefaultScope((qb) => qb.where('active', 1))
class User extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column()
  active!: number;

  posts() {
    return this.hasMany(Post, { foreignKey: 'userId' });
  }
}

@DefaultScope((qb) => qb.whereNotNull('userId'))
@DefaultScope((qb) => qb.orderBy('title', 'asc'))
class Post extends Model {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;

  @Column()
  userId!: number;

  author() {
    return this.belongsTo(User, { foreignKey: 'userId' });
  }
}

class PlainUser extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column()
  active!: number;
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('posts');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name');
    t.integer('active').defaultTo(1);
  });
  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
    t.integer('userId');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('DefaultScope', () => {
  it('applies to all(), where(), and find()', async () => {
    await User.create({ name: 'Alice', active: 1 });
    await User.create({ name: 'Bob', active: 0 });

    expect((await User.all()).map((u) => u.name)).toEqual(['Alice']);
    expect((await User.where({ name: 'Bob' } as any)).map((u) => u.name)).toEqual([]);

    const bob = await PlainUser.where({ name: 'Bob' } as any).first();
    expect(await User.find(bob!.id)).toBeUndefined();
  });

  it('does not affect a class with no @DefaultScope', async () => {
    await User.create({ name: 'Alice', active: 1 });
    await User.create({ name: 'Bob', active: 0 });

    expect((await PlainUser.all()).map((u) => u.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('stacks multiple @DefaultScope applications (ANDed, order-independent)', async () => {
    await Post.create({ title: 'Zeta', userId: 1 });
    await Post.create({ title: 'Alpha', userId: 2 });
    await Post.create({ title: 'Orphaned', userId: null as any });

    const posts = await Post.all();
    expect(posts.map((p) => p.title)).toEqual(['Alpha', 'Zeta']);
  });

  it('unscoped() bypasses every registered default scope', async () => {
    await User.create({ name: 'Alice', active: 1 });
    await User.create({ name: 'Bob', active: 0 });

    expect((await User.unscoped()).map((u) => u.name).sort()).toEqual(['Alice', 'Bob']);
  });

  it('flows through associations built on where()/find(), like belongsTo', async () => {
    await User.create({ name: 'Alice', active: 1 });
    const inactiveUser = await PlainUser.create({ name: 'Bob', active: 0 });
    await Post.create({ title: 'From inactive user', userId: inactiveUser.id });

    const post = await Post.where({ title: 'From inactive user' } as any).first();
    expect(await post!.author()).toBeUndefined();
  });

  it('flows through preloadHasMany/preloadBelongsTo', async () => {
    const alice = await User.create({ name: 'Alice', active: 1 });
    const bob = await PlainUser.create({ name: 'Bob', active: 0 });
    await Post.create({ title: 'A1', userId: alice.id });
    await Post.create({ title: 'B1', userId: bob.id });

    const posts = await Post.unscoped();
    await Post.preloadBelongsTo(posts, User, { foreignKey: 'userId', as: 'author' });
    const byTitle = Object.fromEntries(posts.map((p) => [p.title, (p as any).author]));
    expect(byTitle['A1']?.name).toBe('Alice');
    expect(byTitle['B1']).toBeUndefined();
  });

  it('does not scope query()/save()/destroy() writes', async () => {
    const inactive = await PlainUser.create({ name: 'Charlie', active: 0 });
    // The instance was loaded outside the scope, but save()/destroy() operate by primary key directly.
    const loaded = (await User.unscoped()).find((u) => u.id === inactive.id)!;
    await loaded.update({ name: 'Charlie Updated' } as any);
    expect((await PlainUser.find(inactive.id))!.name).toBe('Charlie Updated');
  });
});
