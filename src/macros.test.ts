import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, Delegate, Enum, PrimaryKey, Timestamped } from './decorators';

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

afterAll(async () => {
  await knex.destroy();
});

describe('Timestamped mixin', () => {
  class Post extends Timestamped(Model) {
    static tableName = 'timestamped_posts';

    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;
  }

  beforeEach(async () => {
    await knex.schema.dropTableIfExists('timestamped_posts');
    await knex.schema.createTable('timestamped_posts', (t) => {
      t.increments('id');
      t.string('title');
      t.text('createdAt');
      t.text('updatedAt');
    });
  });

  it('stamps createdAt and updatedAt on insert', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    const post = await Post.create({ title: 'Hello' });

    expect(post.createdAt).toBeInstanceOf(Date);
    expect(post.updatedAt).toBeInstanceOf(Date);
    expect(post.createdAt.getTime()).toBe(new Date('2026-01-01T00:00:00.000Z').getTime());

    vi.useRealTimers();
  });

  it('bumps only updatedAt on a later update, leaving createdAt untouched', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const post = await Post.create({ title: 'Hello' });
    const originalCreatedAt = post.createdAt.getTime();

    vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'));
    post.title = 'Updated';
    await post.save();

    expect(post.createdAt.getTime()).toBe(originalCreatedAt);
    expect(post.updatedAt.getTime()).toBe(new Date('2026-01-02T00:00:00.000Z').getTime());

    vi.useRealTimers();
  });

  it('round-trips through the database as real Date instances', async () => {
    const post = await Post.create({ title: 'Hello' });
    const reloaded = await Post.find(post.id);
    expect(reloaded!.createdAt).toBeInstanceOf(Date);
    expect(reloaded!.updatedAt).toBeInstanceOf(Date);
  });
});

describe('metadata inheritance across a mixin + a further subclass', () => {
  it('a subclass adding its own @Column keeps the inherited timestamp columns and callback', () => {
    class BasePost extends Timestamped(Model) {
      static tableName = 'timestamped_posts';
      @PrimaryKey()
      id!: number;
    }
    class Post extends BasePost {
      @Column()
      title!: string;
    }

    expect(Post.columns.has('createdAt')).toBe(true);
    expect(Post.columns.has('updatedAt')).toBe(true);
    expect(Post.columns.has('title')).toBe(true);
    expect(Post.callbacksFor('beforeCreate')).toContain('__stampCreatedAt');
    expect(Post.callbacksFor('beforeUpdate')).toContain('__stampUpdatedAt');

    // The base class's own metadata must be untouched by the subclass's additions.
    expect(BasePost.columns.has('title')).toBe(false);
  });
});

describe('Delegate', () => {
  class Author extends Model {
    static tableName = 'authors';
    @PrimaryKey() id!: number;
    @Column() name!: string;
    @Column() email!: string;
  }

  @Delegate(['name', 'email'], { to: 'author' })
  class Article extends Model {
    static tableName = 'articles';
    @PrimaryKey() id!: number;
    @Column() authorId!: number;

    author() {
      return this.belongsTo(Author, { foreignKey: 'authorId' });
    }
  }

  beforeEach(async () => {
    await knex.schema.dropTableIfExists('articles');
    await knex.schema.dropTableIfExists('authors');
    await knex.schema.createTable('authors', (t) => {
      t.increments('id');
      t.string('name');
      t.string('email');
    });
    await knex.schema.createTable('articles', (t) => {
      t.increments('id');
      t.integer('authorId');
    });
  });

  it('generates async <to><Capitalized attribute>() methods forwarding through the relation', async () => {
    const author = await Author.create({ name: 'Alice', email: 'alice@example.com' });
    const article = await Article.create({ authorId: author.id });

    expect(await (article as any).authorName()).toBe('Alice');
    expect(await (article as any).authorEmail()).toBe('alice@example.com');
  });

  it('resolves to undefined when the relation has no match', async () => {
    const article = await Article.create({ authorId: 999 });
    expect(await (article as any).authorName()).toBeUndefined();
  });
});

describe('Enum', () => {
  @Enum('status', { draft: 0, published: 1, archived: 2 })
  class Post extends Model {
    static tableName = 'enum_posts';
    @PrimaryKey() id!: number;
    @Column() status!: number;
  }

  beforeEach(async () => {
    await knex.schema.dropTableIfExists('enum_posts');
    await knex.schema.createTable('enum_posts', (t) => {
      t.increments('id');
      t.integer('status');
    });
  });

  it('exposes a <attribute>Label getter', async () => {
    const post = await Post.create({ status: 0 });
    expect((post as any).statusLabel).toBe('draft');

    post.status = 1;
    expect((post as any).statusLabel).toBe('published');
  });

  it('generates is<Label>() predicates', async () => {
    const post = await Post.create({ status: 1 });
    expect((post as any).isDraft()).toBe(false);
    expect((post as any).isPublished()).toBe(true);
    expect((post as any).isArchived()).toBe(false);
  });

  it('generates a static with<Attribute>(label) scope', async () => {
    await Post.create({ status: 0 });
    await Post.create({ status: 1 });
    await Post.create({ status: 1 });

    const published = await (Post as any).withStatus('published');
    expect(published).toHaveLength(2);
  });

  it('the static scope throws on an unknown label', () => {
    expect(() => (Post as any).withStatus('bogus')).toThrow(/Unknown status/);
  });

  it('the raw column itself is unaffected — a plain @Column() int', async () => {
    const post = await Post.create({ status: 1 });
    const reloaded = await Post.find(post.id);
    expect(reloaded!.status).toBe(1);
  });
});
