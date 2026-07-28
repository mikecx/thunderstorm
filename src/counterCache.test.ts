import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey } from './decorators';
import { CounterCache } from './counterCache';

class Post extends Model {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;

  @Column({ default: 0 })
  commentsCount!: number;
}

@CounterCache('post', 'commentsCount')
class Comment extends Model {
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

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('comments');
  await knex.schema.dropTableIfExists('posts');
  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
    t.integer('commentsCount').notNullable().defaultTo(0);
  });
  await knex.schema.createTable('comments', (t) => {
    t.increments('id');
    t.integer('postId');
    t.string('body');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('CounterCache', () => {
  it('increments the parent column each time a child is created', async () => {
    const post = await Post.create({ title: 'Hello' });
    await Comment.create({ postId: post.id, body: 'First' });
    await Comment.create({ postId: post.id, body: 'Second' });

    const reloaded = await Post.find(post.id);
    expect(reloaded!.commentsCount).toBe(2);
  });

  it('decrements the parent column when a child is destroyed', async () => {
    const post = await Post.create({ title: 'Hello' });
    const comment = await Comment.create({ postId: post.id, body: 'First' });
    await Comment.create({ postId: post.id, body: 'Second' });

    await comment.destroy();

    const reloaded = await Post.find(post.id);
    expect(reloaded!.commentsCount).toBe(1);
  });

  it('does not touch or move the count when a child is reassigned to a different parent', async () => {
    const postA = await Post.create({ title: 'A' });
    const postB = await Post.create({ title: 'B' });
    const comment = await Comment.create({ postId: postA.id, body: 'First' });

    await comment.update({ postId: postB.id });

    expect((await Post.find(postA.id))!.commentsCount).toBe(1);
    expect((await Post.find(postB.id))!.commentsCount).toBe(0);
  });

  it('is a no-op, not a crash, when the child has no resolvable parent', async () => {
    const orphan = await Comment.create({ postId: 999999, body: 'Orphaned' });
    await expect(orphan.destroy()).resolves.toBe(true);
  });

  it('keeps an accurate running count across several creates', async () => {
    const post = await Post.create({ title: 'Hello' });

    for (let i = 0; i < 5; i++) {
      await Comment.create({ postId: post.id, body: `Comment ${i}` });
    }

    const reloaded = await Post.find(post.id);
    expect(reloaded!.commentsCount).toBe(5);
  });
});
