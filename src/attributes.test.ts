import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey, Validates } from './decorators';

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

afterAll(async () => {
  await knex.destroy();
});

describe('virtual (non-persisted) attributes', () => {
  class SignupForm extends Model {
    static tableName = 'signup_forms';

    @PrimaryKey()
    id!: number;

    @Column()
    @Validates({ presence: true })
    password!: string;

    @Column({ virtual: true })
    @Validates({ presence: true })
    passwordConfirmation!: string;

    protected validate(): void {
      if (this.password !== this.passwordConfirmation) {
        this.errors.add('passwordConfirmation', "doesn't match password");
      }
    }
  }

  beforeEach(async () => {
    await knex.schema.dropTableIfExists('signup_forms');
    await knex.schema.createTable('signup_forms', (t) => {
      t.increments('id');
      t.string('password');
      // deliberately no passwordConfirmation column
    });
  });

  it('is validated like any other attribute', () => {
    const form = new SignupForm({ password: 'hunter2', passwordConfirmation: '' });
    expect(form.isValid()).toBe(false);
    expect(form.errors.on('passwordConfirmation')).toContain("can't be blank");
  });

  it('participates in cross-field validation', () => {
    const mismatched = new SignupForm({ password: 'hunter2', passwordConfirmation: 'nope' });
    expect(mismatched.isValid()).toBe(false);
    expect(mismatched.errors.on('passwordConfirmation')).toContain("doesn't match password");

    const matched = new SignupForm({ password: 'hunter2', passwordConfirmation: 'hunter2' });
    expect(matched.isValid()).toBe(true);
  });

  it('is excluded from the INSERT, so a real save succeeds despite no matching DB column', async () => {
    const form = new SignupForm({ password: 'hunter2', passwordConfirmation: 'hunter2' });
    const ok = await form.save();
    expect(ok).toBe(true);
    expect(form.isPersisted).toBe(true);
  });

  it('is excluded from serializableHash()/toJSON() by default', async () => {
    const form = new SignupForm({ password: 'hunter2', passwordConfirmation: 'hunter2' });
    await form.save();

    const json = JSON.parse(JSON.stringify(form));
    expect(json).toEqual({ id: form.id, password: 'hunter2' });
    expect(json.passwordConfirmation).toBeUndefined();
  });

  it('still participates in dirty tracking', () => {
    const form = new SignupForm({ password: 'hunter2', passwordConfirmation: 'hunter2' });
    expect(form.isChanged).toBe(true);
    expect(form.isAttributeChanged('passwordConfirmation')).toBe(true);
  });
});

describe('attribute defaults', () => {
  class Ticket extends Model {
    static tableName = 'tickets';

    @PrimaryKey()
    id!: number;

    @Column()
    subject!: string;

    @Column({ default: 'open' })
    status!: string;

    @Column({ type: 'json', default: () => ({}) })
    metadata!: Record<string, any>;
  }

  beforeEach(async () => {
    await knex.schema.dropTableIfExists('tickets');
    await knex.schema.createTable('tickets', (t) => {
      t.increments('id');
      t.string('subject');
      t.string('status');
      t.text('metadata');
    });
  });

  it('applies a literal default when the attribute is not set', () => {
    const ticket = new Ticket({ subject: 'Help' });
    expect(ticket.status).toBe('open');
  });

  it('does not override an explicitly provided value', () => {
    const ticket = new Ticket({ subject: 'Help', status: 'closed' });
    expect(ticket.status).toBe('closed');
  });

  it('calls a function default fresh per instance, so mutable defaults are not a shared reference', () => {
    const a = new Ticket({ subject: 'A' });
    const b = new Ticket({ subject: 'B' });

    expect(a.metadata).toEqual({});
    a.metadata.foo = 'bar';

    expect(b.metadata).toEqual({});
    expect(a.metadata).not.toBe(b.metadata);
  });

  it('does not apply the default to a record loaded from the database', async () => {
    await knex('tickets').insert({ subject: 'Legacy', status: null, metadata: '{}' });
    const reloaded = await Ticket.where({ subject: 'Legacy' } as any).first();
    expect(reloaded!.status).toBeNull();
  });

  it('the defaulted value round-trips through a real save', async () => {
    const ticket = await Ticket.create({ subject: 'Help' });
    const reloaded = await Ticket.find(ticket.id);
    expect(reloaded!.status).toBe('open');
  });
});

describe('serializableHash', () => {
  class Author extends Model {
    static tableName = 'authors2';
    @PrimaryKey() id!: number;
    @Column() name!: string;
  }

  class Post extends Model {
    static tableName = 'posts2';
    @PrimaryKey() id!: number;
    @Column() title!: string;
    @Column() authorId!: number;
    @Column({ virtual: true }) draftNote!: string;
  }

  beforeEach(async () => {
    await knex.schema.dropTableIfExists('posts2');
    await knex.schema.dropTableIfExists('authors2');
    await knex.schema.createTable('authors2', (t) => {
      t.increments('id');
      t.string('name');
    });
    await knex.schema.createTable('posts2', (t) => {
      t.increments('id');
      t.string('title');
      t.integer('authorId');
    });
  });

  it('only includes the requested columns', async () => {
    const author = await Author.create({ name: 'Alice' });
    expect(author.serializableHash({ only: ['name'] })).toEqual({ name: 'Alice' });
  });

  it('excludes the requested columns', async () => {
    const author = await Author.create({ name: 'Alice' });
    expect(author.serializableHash({ except: ['id'] })).toEqual({ name: 'Alice' });
  });

  it('include pulls in an arbitrary own property verbatim', async () => {
    const author = await Author.create({ name: 'Alice' });
    (author as any)._postCount = 3;
    expect(author.serializableHash({ include: ['_postCount'] })).toEqual({
      id: author.id,
      name: 'Alice',
      _postCount: 3,
    });
  });

  it('include recursively serializes a preloaded Model association', async () => {
    const author = await Author.create({ name: 'Alice' });
    const post = await Post.create({ title: 'Hello', authorId: author.id, draftNote: 'wip' });
    await Post.preloadBelongsTo([post], Author, { foreignKey: 'authorId', as: '_author' });

    const hash = post.serializableHash({ include: ['_author'] });
    expect(hash).toEqual({
      id: post.id,
      title: 'Hello',
      authorId: author.id,
      _author: { id: author.id, name: 'Alice' },
    });
    expect(hash.draftNote).toBeUndefined(); // virtual, and not explicitly included
  });

  it('include recursively serializes a preloaded array of Model instances', async () => {
    const author = await Author.create({ name: 'Alice' });
    await Post.create({ title: 'One', authorId: author.id });
    await Post.create({ title: 'Two', authorId: author.id });
    await Author.preloadHasMany([author], Post, { foreignKey: 'authorId', as: '_posts' });

    const hash = author.serializableHash({ include: ['_posts'] });
    expect(hash._posts).toEqual([
      { id: expect.any(Number), title: 'One', authorId: author.id },
      { id: expect.any(Number), title: 'Two', authorId: author.id },
    ]);
  });
});
