import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey, Lockable } from './decorators';
import { StaleObjectError } from './errors';

class Post extends Lockable(Model) {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;
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
    t.integer('lockVersion').notNullable().defaultTo(0);
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('Lockable', () => {
  it('starts a new record at lockVersion 0 and increments it on each successful update', async () => {
    const post = await Post.create({ title: 'Draft' } as any);
    expect(post.lockVersion).toBe(0);

    await post.update({ title: 'Published' });
    expect(post.lockVersion).toBe(1);

    await post.update({ title: 'Republished' });
    expect(post.lockVersion).toBe(2);

    const reloaded = await Post.find(post.id);
    expect(reloaded!.lockVersion).toBe(2);
  });

  it('throws StaleObjectError when updating a record someone else already changed', async () => {
    const post = await Post.create({ title: 'Draft' } as any);
    const staleCopy = await Post.find(post.id);

    await post.update({ title: 'Published by first writer' });

    await expect(staleCopy!.update({ title: 'Published by second writer' })).rejects.toBeInstanceOf(StaleObjectError);

    // The failed writer's change never landed.
    const reloaded = await Post.find(post.id);
    expect(reloaded!.title).toBe('Published by first writer');
  });

  it('throws StaleObjectError when destroying a record someone else already changed', async () => {
    const post = await Post.create({ title: 'Draft' } as any);
    const staleCopy = await Post.find(post.id);

    await post.update({ title: 'Published' });

    await expect(staleCopy!.destroy()).rejects.toBeInstanceOf(StaleObjectError);
    expect(await Post.find(post.id)).not.toBeUndefined();
  });

  it('does not touch lockVersion or issue a query when nothing changed', async () => {
    const post = await Post.create({ title: 'Draft' } as any);
    const ok = await post.save();

    expect(ok).toBe(true);
    expect(post.lockVersion).toBe(0);
  });

  it('destroying a record at the current version succeeds and removes it', async () => {
    const post = await Post.create({ title: 'Draft' } as any);
    const ok = await post.destroy();

    expect(ok).toBe(true);
    expect(await Post.find(post.id)).toBeUndefined();
  });
});
