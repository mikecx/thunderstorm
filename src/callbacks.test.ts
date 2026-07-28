import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import {
  AfterCreate,
  AfterDestroy,
  AfterSave,
  AfterUpdate,
  BeforeCreate,
  BeforeDestroy,
  BeforeSave,
  BeforeUpdate,
  Column,
  PrimaryKey,
} from './decorators';
import { RecordInvalid, RecordNotSaved } from './errors';

let knex: Knex;
let log: string[];

class Post extends Model {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;

  @Column()
  slug!: string;

  @Column()
  blockDestroy!: number;

  @BeforeSave()
  onBeforeSave() {
    log.push('beforeSave');
  }

  @BeforeCreate()
  onBeforeCreate() {
    log.push('beforeCreate');
    this.slug = this.title.toLowerCase().replace(/\s+/g, '-');
  }

  @AfterCreate()
  onAfterCreate() {
    log.push('afterCreate');
  }

  @BeforeUpdate()
  onBeforeUpdate() {
    log.push('beforeUpdate');
  }

  @AfterUpdate()
  onAfterUpdate() {
    log.push('afterUpdate');
  }

  @AfterSave()
  onAfterSave() {
    log.push('afterSave');
  }

  @BeforeDestroy()
  onBeforeDestroy() {
    log.push('beforeDestroy');
    if (this.blockDestroy) return false;
  }

  @AfterDestroy()
  onAfterDestroy() {
    log.push('afterDestroy');
  }
}

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  log = [];
  await knex.schema.dropTableIfExists('posts');
  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
    t.string('slug');
    t.integer('blockDestroy').defaultTo(0);
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('save() callbacks', () => {
  it('runs beforeSave -> beforeCreate -> afterCreate -> afterSave in order on create', async () => {
    const post = new Post({ title: 'Hello World' });
    const ok = await post.save();

    expect(ok).toBe(true);
    expect(log).toEqual(['beforeSave', 'beforeCreate', 'afterCreate', 'afterSave']);
  });

  it('lets a beforeCreate callback mutate the instance before insert', async () => {
    const post = await Post.create({ title: 'Hello World' });
    expect(post.slug).toBe('hello-world');
    const reloaded = await Post.find(post.id);
    expect(reloaded?.slug).toBe('hello-world');
  });

  it('runs beforeSave -> beforeUpdate -> afterUpdate -> afterSave on update', async () => {
    const post = await Post.create({ title: 'Hello World' });
    log = [];

    post.title = 'Updated Title';
    const ok = await post.save();

    expect(ok).toBe(true);
    expect(log).toEqual(['beforeSave', 'beforeUpdate', 'afterUpdate', 'afterSave']);
  });

  it('does not run create callbacks on an update, or update callbacks on a create', async () => {
    const post = await Post.create({ title: 'Hello World' });
    expect(log).not.toContain('beforeUpdate');
    expect(log).not.toContain('afterUpdate');

    log = [];
    post.title = 'Changed';
    await post.save();
    expect(log).not.toContain('beforeCreate');
    expect(log).not.toContain('afterCreate');
  });
});

describe('destroy() callbacks', () => {
  it('runs beforeDestroy then afterDestroy', async () => {
    const post = await Post.create({ title: 'Hello World' });
    log = [];

    const ok = await post.destroy();

    expect(ok).toBe(true);
    expect(log).toEqual(['beforeDestroy', 'afterDestroy']);
    expect(post.isPersisted).toBe(false);
  });

  it('a beforeDestroy callback returning false halts the destroy', async () => {
    const post = await Post.create({ title: 'Hello World', blockDestroy: 1 });
    log = [];

    const ok = await post.destroy();

    expect(ok).toBe(false);
    expect(log).toEqual(['beforeDestroy']);
    expect(post.isPersisted).toBe(true);
    expect(await Post.find(post.id)).toBeDefined();
  });
});

describe('deleteAll() vs destroy()', () => {
  it('deleteAll() runs no callbacks at all, even ones that would block an individual destroy()', async () => {
    await Post.create({ title: 'Blocked', blockDestroy: 1 });
    await Post.create({ title: 'Unblocked' });
    log = [];

    const deleted = await Post.all().deleteAll();

    expect(deleted).toBe(2);
    expect(log).toEqual([]);
    expect(await Post.all().count()).toBe(0);
  });
});

describe('destroyAll()', () => {
  it('runs beforeDestroy/afterDestroy per record, same as calling destroy() on each', async () => {
    await Post.create({ title: 'First' });
    await Post.create({ title: 'Second' });
    log = [];

    const destroyed = await Post.all().destroyAll();

    expect(destroyed).toBe(2);
    expect(log).toEqual(['beforeDestroy', 'afterDestroy', 'beforeDestroy', 'afterDestroy']);
  });

  it('a beforeDestroy callback blocking one record still lets the rest be destroyed', async () => {
    await Post.create({ title: 'Blocked', blockDestroy: 1 });
    await Post.create({ title: 'Unblocked' });
    log = [];

    const destroyed = await Post.all().destroyAll();

    expect(destroyed).toBe(1);
    expect(await Post.all().pluck('title')).toEqual(['Blocked']);
  });
});

describe('saveOrFail() error type by failure cause', () => {
  class BlockedPost extends Model {
    static tableName = 'posts';

    @PrimaryKey()
    id!: number;

    @Column()
    title!: string;

    @BeforeSave()
    reject() {
      return false;
    }
  }

  it('throws RecordNotSaved (not RecordInvalid) when a callback aborts a valid record', async () => {
    const post = new BlockedPost({ title: 'Hello World' });

    await expect(post.saveOrFail()).rejects.toBeInstanceOf(RecordNotSaved);
    await expect(post.saveOrFail()).rejects.not.toBeInstanceOf(RecordInvalid);
  });
});
