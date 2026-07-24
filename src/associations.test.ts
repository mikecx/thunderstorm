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

  posts() {
    return this.hasMany(Post, { foreignKey: 'userId' });
  }

  profile() {
    return this.hasOne(Profile, { foreignKey: 'userId' });
  }
}

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

class Profile extends Model {
  static tableName = 'profiles';

  @PrimaryKey()
  id!: number;

  @Column()
  userId!: number;

  @Column()
  bio!: string;
}

let knex: Knex;
let queryCount: number;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
  knex.on('query', () => {
    queryCount++;
  });
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('posts');
  await knex.schema.dropTableIfExists('profiles');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name');
  });
  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
    t.integer('userId');
  });
  await knex.schema.createTable('profiles', (t) => {
    t.increments('id');
    t.integer('userId');
    t.string('bio');
  });
  queryCount = 0;
});

afterAll(async () => {
  await knex.destroy();
});

describe('lazy relations', () => {
  it('hasMany returns a QueryChain scoped to the foreign key', async () => {
    const alice = await User.create({ name: 'Alice' });
    const bob = await User.create({ name: 'Bob' });
    await Post.create({ title: 'A1', userId: alice.id });
    await Post.create({ title: 'A2', userId: alice.id });
    await Post.create({ title: 'B1', userId: bob.id });

    const alicePosts = await alice.posts();
    expect(alicePosts.map((p) => p.title).sort()).toEqual(['A1', 'A2']);
  });

  it('hasMany chain supports further scoping before awaiting', async () => {
    const alice = await User.create({ name: 'Alice' });
    await Post.create({ title: 'Z', userId: alice.id });
    await Post.create({ title: 'A', userId: alice.id });

    const first = await alice.posts().order('title', 'asc').first();
    expect(first?.title).toBe('A');
  });

  it('belongsTo resolves the owning record', async () => {
    const alice = await User.create({ name: 'Alice' });
    const post = await Post.create({ title: 'A1', userId: alice.id });

    const author = await post.author();
    expect(author?.name).toBe('Alice');
  });

  it('belongsTo resolves to undefined when the foreign key has no match', async () => {
    const post = await Post.create({ title: 'Orphan', userId: 999 });
    expect(await post.author()).toBeUndefined();
  });

  it('hasOne returns a single related record', async () => {
    const alice = await User.create({ name: 'Alice' });
    await Profile.create({ userId: alice.id, bio: 'hello' });

    const profile = await alice.profile();
    expect(profile?.bio).toBe('hello');
  });

  it('hasOne resolves to undefined when there is no related record', async () => {
    const bob = await User.create({ name: 'Bob' });
    expect(await bob.profile()).toBeUndefined();
  });
});

describe('preload avoids N+1', () => {
  it('preloadHasMany fetches all related rows in a single query', async () => {
    const alice = await User.create({ name: 'Alice' });
    const bob = await User.create({ name: 'Bob' });
    await Post.create({ title: 'A1', userId: alice.id });
    await Post.create({ title: 'A2', userId: alice.id });
    await Post.create({ title: 'B1', userId: bob.id });

    const users = await User.all();
    queryCount = 0;
    await User.preloadHasMany(users, Post, { foreignKey: 'userId', as: '_posts' });

    expect(queryCount).toBe(1);
    const byName = Object.fromEntries(users.map((u) => [u.name, (u as any)._posts.map((p: Post) => p.title).sort()]));
    expect(byName).toEqual({ Alice: ['A1', 'A2'], Bob: ['B1'] });
  });

  it('produces the same data as N naive per-record queries, using far fewer queries', async () => {
    const alice = await User.create({ name: 'Alice' });
    const bob = await User.create({ name: 'Bob' });
    await Post.create({ title: 'A1', userId: alice.id });
    await Post.create({ title: 'B1', userId: bob.id });

    const users = await User.all();

    queryCount = 0;
    const naive: Record<string, string[]> = {};
    for (const user of users) {
      naive[user.name] = (await user.posts()).map((p) => p.title);
    }
    const naiveQueryCount = queryCount;

    queryCount = 0;
    await User.preloadHasMany(users, Post, { foreignKey: 'userId', as: '_posts' });
    const preloadQueryCount = queryCount;

    expect(naiveQueryCount).toBe(users.length);
    expect(preloadQueryCount).toBe(1);
    expect(preloadQueryCount).toBeLessThan(naiveQueryCount);

    const preloaded = Object.fromEntries(users.map((u) => [u.name, (u as any)._posts.map((p: Post) => p.title)]));
    expect(preloaded).toEqual(naive);
  });

  it('preloadHasMany short-circuits without querying when given no records', async () => {
    queryCount = 0;
    await User.preloadHasMany([], Post, { foreignKey: 'userId', as: '_posts' });
    expect(queryCount).toBe(0);
  });

  it('preloadBelongsTo fetches all owning rows in a single query', async () => {
    const alice = await User.create({ name: 'Alice' });
    const bob = await User.create({ name: 'Bob' });
    await Post.create({ title: 'A1', userId: alice.id });
    await Post.create({ title: 'B1', userId: bob.id });

    const posts = await Post.all();
    queryCount = 0;
    await Post.preloadBelongsTo(posts, User, { foreignKey: 'userId', as: '_author' });

    expect(queryCount).toBe(1);
    const byTitle = Object.fromEntries(posts.map((p) => [p.title, (p as any)._author?.name]));
    expect(byTitle).toEqual({ A1: 'Alice', B1: 'Bob' });
  });

  it('preloadBelongsTo leaves `as` undefined for records with no matching parent', async () => {
    const post = await Post.create({ title: 'Orphan', userId: 999 });
    await Post.preloadBelongsTo([post], User, { foreignKey: 'userId', as: '_author' });
    expect((post as any)._author).toBeUndefined();
  });
});
