import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect, QueryChain } from './Model';
import { Column, PrimaryKey } from './decorators';

class Post extends Model {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;

  @Column()
  published!: number;

  @Column()
  views!: number;

  // A scope is just a static method returning (or extending) a QueryChain — no decorator needed,
  // the same pattern already used for hasMany/belongsTo relation methods.
  static published<T extends typeof Post>(this: T) {
    return this.where({ published: 1 } as any);
  }
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('posts');
  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
    t.integer('published').defaultTo(0);
    t.integer('views').defaultTo(0);
  });
  await Post.create({ title: 'Draft', published: 0, views: 100 });
  await Post.create({ title: 'Popular published', published: 1, views: 50 });
  await Post.create({ title: 'Quiet published', published: 1, views: 5 });
});

afterAll(async () => {
  await knex.destroy();
});

describe('scopes as plain static methods', () => {
  it('a scope returning this.where(...) is directly awaitable', async () => {
    const posts = await Post.published();
    expect(posts.map((p) => p.title).sort()).toEqual(['Popular published', 'Quiet published']);
  });

  it('a scope result can still be chained with the normal QueryChain methods', async () => {
    const first = await Post.published().order('views', 'asc').first();
    expect(first?.title).toBe('Quiet published');
  });
});

describe('QueryChain.apply() composes scope-like functions', () => {
  const orderByViewsDesc = (chain: QueryChain<typeof Post>) => chain.order('views', 'desc');

  it('threads a chain through an arbitrary function and returns whatever it returns', async () => {
    const posts = await Post.published().apply(orderByViewsDesc);
    expect(posts.map((p) => p.title)).toEqual(['Popular published', 'Quiet published']);
  });

  it('composes multiple scope-shaped functions by chaining .apply() calls', async () => {
    const takeFirst = (chain: QueryChain<typeof Post>) => chain.first();

    const top = await Post.published().apply(orderByViewsDesc).apply(takeFirst);
    expect(top?.title).toBe('Popular published');
  });
});
