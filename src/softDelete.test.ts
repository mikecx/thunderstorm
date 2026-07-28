import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { AfterDestroy, BeforeDestroy, Column, PrimaryKey, SoftDelete, Lockable } from './decorators';
import { StaleObjectError } from './errors';

let log: string[];

class Post extends SoftDelete(Model) {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;

  @Column()
  protect!: number;

  @BeforeDestroy()
  logBeforeDestroy() {
    log.push('beforeDestroy');
    if (this.protect) return false;
  }

  @AfterDestroy()
  logAfterDestroy() {
    log.push('afterDestroy');
  }
}

class Comment extends Model {
  static tableName = 'comments';

  @PrimaryKey()
  id!: number;

  @Column()
  postId!: number;
}

class LockablePost extends SoftDelete(Lockable(Model)) {
  static tableName = 'lockable_posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;
}

class PlainPost extends Model {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;

  @Column({ type: 'date' })
  deletedAt?: Date;
}

class NoSoftDelete extends Model {
  static tableName = 'comments';

  @PrimaryKey()
  id!: number;
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  log = [];
  await knex.schema.dropTableIfExists('comments');
  await knex.schema.dropTableIfExists('posts');
  await knex.schema.dropTableIfExists('lockable_posts');
  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
    t.integer('protect').defaultTo(0);
    t.dateTime('deletedAt').nullable();
  });
  await knex.schema.createTable('comments', (t) => {
    t.increments('id');
    t.integer('postId');
  });
  await knex.schema.createTable('lockable_posts', (t) => {
    t.increments('id');
    t.string('title');
    t.integer('lockVersion').notNullable().defaultTo(0);
    t.dateTime('deletedAt').nullable();
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('SoftDelete', () => {
  it('destroy() sets deletedAt via UPDATE instead of removing the row', async () => {
    const post = await Post.create({ title: 'Draft' });
    const ok = await post.destroy();

    expect(ok).toBe(true);
    expect(post.isPersisted).toBe(true);
    expect(post.deletedAt).toBeInstanceOf(Date);
    expect(post.isDeleted).toBe(true);

    const stillInTable = await PlainPost.where({ title: 'Draft' } as any).first();
    expect(stillInTable).not.toBeUndefined();
    expect(stillInTable!.deletedAt).not.toBeNull();
  });

  it('a soft-deleted row is invisible to find()/all()/where()', async () => {
    const post = await Post.create({ title: 'Draft' });
    await post.destroy();

    expect(await Post.find(post.id)).toBeUndefined();
    expect(await Post.all()).toEqual([]);
    expect(await Post.where({ title: 'Draft' } as any)).toEqual([]);
  });

  it('is reachable via Model.unscoped(), and restore() brings it back', async () => {
    const post = await Post.create({ title: 'Draft' });
    await post.destroy();

    const trashed = (await Post.unscoped()).find((p) => p.id === post.id);
    expect(trashed).not.toBeUndefined();
    expect(trashed!.isDeleted).toBe(true);

    const restored = await trashed!.restore();
    expect(restored).toBe(true);
    expect(trashed!.deletedAt).toBeUndefined();
    expect(trashed!.isDeleted).toBe(false);

    expect(await Post.find(post.id)).not.toBeUndefined();
  });

  it('restore() throws on a model with no deletedAt column', async () => {
    const comment = await NoSoftDelete.create({});
    await expect(comment.restore()).rejects.toThrow(/not soft-deletable/);
  });

  it('runs beforeDestroy/afterDestroy callbacks around a soft delete, same as a hard delete', async () => {
    const post = await Post.create({ title: 'Draft' });
    await post.destroy();

    expect(log).toEqual(['beforeDestroy', 'afterDestroy']);
  });

  it('destroy() returns false without soft-deleting when beforeDestroy aborts', async () => {
    const post = await Post.create({ title: 'Draft', protect: 1 });
    const ok = await post.destroy();

    expect(ok).toBe(false);
    expect(log).toEqual(['beforeDestroy']);
    expect(post.isDeleted).toBe(false);
    expect((await Post.find(post.id))!.title).toBe('Draft');
  });

  it('keeps isPersisted true after a soft delete, so a later save() updates rather than re-inserting', async () => {
    const post = await Post.create({ title: 'Draft' });
    await post.destroy();

    post.title = 'Edited after soft delete';
    await post.save();

    const reloaded = (await Post.unscoped()).find((p) => p.id === post.id);
    expect(reloaded!.title).toBe('Edited after soft delete');
    expect(await PlainPost.all()).toHaveLength(1);
  });

  it('composes with Lockable: throws StaleObjectError destroying a stale lockVersion', async () => {
    const post = await LockablePost.create({ title: 'Draft' });
    const staleCopy = await LockablePost.find(post.id);

    await post.update({ title: 'Edited' });

    await expect(staleCopy!.destroy()).rejects.toBeInstanceOf(StaleObjectError);
    expect((await LockablePost.find(post.id))!.title).toBe('Edited');
  });

  it('associations built on where() exclude soft-deleted parents, independent of their children', async () => {
    const post = await Post.create({ title: 'Draft' });
    await Comment.create({ postId: post.id });
    await post.destroy();

    expect(await Post.find(post.id)).toBeUndefined();
    expect(await Comment.where({ postId: post.id } as any)).toHaveLength(1);
  });
});
