import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect, noTouching } from './Model';
import { Column, PrimaryKey, Timestamped } from './decorators';
import { Touch } from './touch';

class Post extends Timestamped(Model) {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;
}

@Touch('post')
class Comment extends Timestamped(Model) {
  static tableName = 'comments';

  @PrimaryKey()
  id!: number;

  @Column()
  postId!: number;

  @Column()
  body!: string;

  post() {
    return this.belongsTo(Post, { foreignKey: 'postId' });
  }
}

class Tag extends Model {
  static tableName = 'tags';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('comments');
  await knex.schema.dropTableIfExists('posts');
  await knex.schema.dropTableIfExists('tags');
  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
    t.dateTime('createdAt');
    t.dateTime('updatedAt');
  });
  await knex.schema.createTable('comments', (t) => {
    t.increments('id');
    t.integer('postId');
    t.string('body');
    t.dateTime('createdAt');
    t.dateTime('updatedAt');
  });
  await knex.schema.createTable('tags', (t) => {
    t.increments('id');
    t.string('name');
  });
});

afterAll(async () => {
  await knex.destroy();
});

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('touch()', () => {
  it('bumps updatedAt to now via a direct UPDATE', async () => {
    const post = await Post.create({ title: 'Hello' });
    const originalUpdatedAt = post.updatedAt;
    await wait(5);

    const result = await post.touch();

    expect(result).toBe(true);
    expect(post.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
    const reloaded = await Post.find(post.id);
    expect(reloaded!.updatedAt.getTime()).toBe(post.updatedAt.getTime());
  });

  it('also bumps any additional column names passed to it', async () => {
    await knex.schema.alterTable('posts', (t) => {
      t.dateTime('publishedAt');
    });
    class PublishablePost extends Timestamped(Model) {
      static tableName = 'posts';
      @PrimaryKey() id!: number;
      @Column() title!: string;
      @Column({ type: 'date' }) publishedAt!: Date;
    }

    const post = await PublishablePost.create({ title: 'Hello' });
    await post.touch('publishedAt');

    expect(post.publishedAt).toBeInstanceOf(Date);
    const reloaded = await PublishablePost.find(post.id);
    expect(reloaded!.publishedAt.getTime()).toBe(post.publishedAt.getTime());
  });

  it('throws when the model has no updatedAt column', async () => {
    const tag = await Tag.create({ name: 'ts' });
    await expect(tag.touch()).rejects.toThrow(/not touchable/);
  });

  it('throws when called on an unpersisted record', async () => {
    const post = new Post({ title: 'Draft' });
    await expect(post.touch()).rejects.toThrow(/unpersisted/);
  });

  it('is a no-op inside noTouching(), returning false without writing', async () => {
    const post = await Post.create({ title: 'Hello' });
    const originalUpdatedAt = post.updatedAt;
    await wait(5);

    const result = await noTouching(() => post.touch());

    expect(result).toBe(false);
    expect(post.updatedAt.getTime()).toBe(originalUpdatedAt.getTime());
    const reloaded = await Post.find(post.id);
    expect(reloaded!.updatedAt.getTime()).toBe(originalUpdatedAt.getTime());
  });
});

describe('@Touch', () => {
  it('touches the parent when the child is created', async () => {
    const post = await Post.create({ title: 'Hello' });
    const originalUpdatedAt = post.updatedAt;
    await wait(5);

    await Comment.create({ postId: post.id, body: 'First' });

    const reloaded = await Post.find(post.id);
    expect(reloaded!.updatedAt.getTime()).toBeGreaterThan(originalUpdatedAt.getTime());
  });

  it('touches the parent when the child is saved', async () => {
    const post = await Post.create({ title: 'Hello' });
    const comment = await Comment.create({ postId: post.id, body: 'First' });
    const afterCreateUpdatedAt = (await Post.find(post.id))!.updatedAt;
    await wait(5);

    await comment.update({ body: 'Edited' });

    const reloaded = await Post.find(post.id);
    expect(reloaded!.updatedAt.getTime()).toBeGreaterThan(afterCreateUpdatedAt.getTime());
  });

  it('touches the parent when the child is destroyed', async () => {
    const post = await Post.create({ title: 'Hello' });
    const comment = await Comment.create({ postId: post.id, body: 'First' });
    const afterCreateUpdatedAt = (await Post.find(post.id))!.updatedAt;
    await wait(5);

    await comment.destroy();

    const reloaded = await Post.find(post.id);
    expect(reloaded!.updatedAt.getTime()).toBeGreaterThan(afterCreateUpdatedAt.getTime());
  });

  it('is a no-op, not a crash, when the child has no resolvable parent', async () => {
    const orphan = await Comment.create({ postId: 999999, body: 'Orphaned' });
    await expect(orphan.destroy()).resolves.toBe(true);
  });

  it('is silently suppressed inside noTouching(), same as a direct touch() call', async () => {
    const post = await Post.create({ title: 'Hello' });
    const originalUpdatedAt = post.updatedAt;
    await wait(5);

    await noTouching(() => Comment.create({ postId: post.id, body: 'First' }));

    const reloaded = await Post.find(post.id);
    expect(reloaded!.updatedAt.getTime()).toBe(originalUpdatedAt.getTime());
  });
});
