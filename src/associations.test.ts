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

  // many-to-many via a real join Model (hasManyThrough)
  tags() {
    return this.hasManyThrough(Tag, PostTag, { sourceKey: 'postId', targetKey: 'tagId' });
  }

  // many-to-many via a bare join table (hasAndBelongsToMany)
  favoriteTags() {
    return this.hasAndBelongsToMany(Tag, {
      joinTable: 'postsFavoriteTags',
      sourceKey: 'postId',
      targetKey: 'tagId',
    });
  }
  addFavoriteTag(tag: Tag) {
    return this.associate(Tag, { joinTable: 'postsFavoriteTags', sourceKey: 'postId', targetKey: 'tagId' }, tag);
  }
  removeFavoriteTag(tag: Tag) {
    return this.dissociate(Tag, { joinTable: 'postsFavoriteTags', sourceKey: 'postId', targetKey: 'tagId' }, tag);
  }

  // polymorphic
  comments() {
    return this.hasManyPolymorphic(Comment, {
      idField: 'commentableId',
      typeField: 'commentableType',
      typeValue: 'post',
    });
  }

  latestComment() {
    return this.hasOnePolymorphic(Comment, {
      idField: 'commentableId',
      typeField: 'commentableType',
      typeValue: 'post',
    });
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

class Tag extends Model {
  static tableName = 'tags';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;
}

class PostTag extends Model {
  static tableName = 'postTags';

  @PrimaryKey()
  id!: number;

  @Column()
  postId!: number;

  @Column()
  tagId!: number;
}

class Photo extends Model {
  static tableName = 'photos';

  @PrimaryKey()
  id!: number;

  @Column()
  url!: string;

  comments() {
    return this.hasManyPolymorphic(Comment, {
      idField: 'commentableId',
      typeField: 'commentableType',
      typeValue: 'photo',
    });
  }
}

const COMMENTABLE_TYPES = { post: Post, photo: Photo };

class Comment extends Model {
  static tableName = 'comments';

  @PrimaryKey()
  id!: number;

  @Column()
  body!: string;

  @Column()
  commentableId!: number;

  @Column()
  commentableType!: string;

  commentable() {
    return this.belongsToPolymorphic({ idField: 'commentableId', typeField: 'commentableType' }, COMMENTABLE_TYPES);
  }
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
  await knex.schema.dropTableIfExists('tags');
  await knex.schema.dropTableIfExists('postTags');
  await knex.schema.dropTableIfExists('postsFavoriteTags');
  await knex.schema.dropTableIfExists('photos');
  await knex.schema.dropTableIfExists('comments');
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
  await knex.schema.createTable('tags', (t) => {
    t.increments('id');
    t.string('name');
  });
  await knex.schema.createTable('postTags', (t) => {
    t.increments('id');
    t.integer('postId');
    t.integer('tagId');
  });
  await knex.schema.createTable('postsFavoriteTags', (t) => {
    t.integer('postId');
    t.integer('tagId');
  });
  await knex.schema.createTable('photos', (t) => {
    t.increments('id');
    t.string('url');
  });
  await knex.schema.createTable('comments', (t) => {
    t.increments('id');
    t.string('body');
    t.integer('commentableId');
    t.string('commentableType');
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

describe('association memoization', () => {
  it('belongsTo only queries once across repeated calls on the same instance', async () => {
    const alice = await User.create({ name: 'Alice' });
    const post = await Post.create({ title: 'A1', userId: alice.id });

    queryCount = 0;
    const first = await post.author();
    const second = await post.author();

    expect(queryCount).toBe(1);
    expect(first).toBe(second);
  });

  it('hasOne only queries once across repeated calls on the same instance', async () => {
    const alice = await User.create({ name: 'Alice' });
    await Profile.create({ userId: alice.id, bio: 'hello' });

    queryCount = 0;
    const first = await alice.profile();
    const second = await alice.profile();

    expect(queryCount).toBe(1);
    expect(first).toBe(second);
  });

  it('does not memoize across different instances', async () => {
    const alice = await User.create({ name: 'Alice' });
    const bob = await User.create({ name: 'Bob' });
    await Post.create({ title: 'A1', userId: alice.id });
    await Post.create({ title: 'B1', userId: bob.id });

    const alicePost = (await alice.posts())[0];
    const bobPost = (await bob.posts())[0];

    queryCount = 0;
    const alicesAuthor = await alicePost.author();
    const bobsAuthor = await bobPost.author();

    expect(queryCount).toBe(2);
    expect(alicesAuthor?.name).toBe('Alice');
    expect(bobsAuthor?.name).toBe('Bob');
  });

  it('{ reload: true } bypasses the cache and re-queries', async () => {
    const alice = await User.create({ name: 'Alice' });
    const post = await Post.create({ title: 'A1', userId: alice.id });

    await post.author();
    queryCount = 0;
    await (post as any).belongsTo(User, { foreignKey: 'userId', reload: true });

    expect(queryCount).toBe(1);
  });

  it("Model.reload() clears every cached association, not just the record's own attributes", async () => {
    const alice = await User.create({ name: 'Alice' });
    const post = await Post.create({ title: 'A1', userId: alice.id });

    await post.author();
    await post.reload();

    queryCount = 0;
    await post.author();

    expect(queryCount).toBe(1);
  });

  it('a failed load is not cached, so the next call retries', async () => {
    const post = await Post.create({ title: 'Orphan', userId: 999 });
    // belongsTo resolving to undefined isn't a rejection, so simulate a real
    // failure via a target that queries a nonexistent table.
    class BrokenTarget extends Model {
      static tableName = 'does_not_exist';
      @PrimaryKey() id!: number;
    }

    await expect((post as any).belongsTo(BrokenTarget, { foreignKey: 'userId' })).rejects.toThrow();
    await expect((post as any).belongsTo(BrokenTarget, { foreignKey: 'userId' })).rejects.toThrow();
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

describe('hasManyThrough (real join Model)', () => {
  it('returns tags reachable via the join table, and stays lazy/chainable', async () => {
    const post = await Post.create({ title: 'A', userId: 1 });
    const ruby = await Tag.create({ name: 'ruby' });
    const ts = await Tag.create({ name: 'typescript' });
    await PostTag.create({ postId: post.id, tagId: ruby.id });
    await PostTag.create({ postId: post.id, tagId: ts.id });

    const tags = await post.tags();
    expect(tags.map((t) => t.name).sort()).toEqual(['ruby', 'typescript']);

    const first = await post.tags().order('name', 'asc').first();
    expect(first?.name).toBe('ruby');
  });

  it('a post with no join rows has no tags', async () => {
    const post = await Post.create({ title: 'Untagged', userId: 1 });
    expect(await post.tags()).toEqual([]);
  });

  it('the join Model is an ordinary Model — create()/destroy() add and remove the association', async () => {
    const post = await Post.create({ title: 'A', userId: 1 });
    const tag = await Tag.create({ name: 'ruby' });
    const join = await PostTag.create({ postId: post.id, tagId: tag.id });

    expect((await post.tags()).map((t) => t.name)).toEqual(['ruby']);

    await join.destroy();
    expect(await post.tags()).toEqual([]);
  });

  it('a single query fetches tags for the target regardless of how many join rows match', async () => {
    const post = await Post.create({ title: 'A', userId: 1 });
    const ruby = await Tag.create({ name: 'ruby' });
    const ts = await Tag.create({ name: 'typescript' });
    await PostTag.create({ postId: post.id, tagId: ruby.id });
    await PostTag.create({ postId: post.id, tagId: ts.id });

    queryCount = 0;
    await post.tags();
    expect(queryCount).toBe(1);
  });

  it('preloadHasManyThrough fetches every post’s tags in two queries total', async () => {
    const a = await Post.create({ title: 'A', userId: 1 });
    const b = await Post.create({ title: 'B', userId: 1 });
    const ruby = await Tag.create({ name: 'ruby' });
    const ts = await Tag.create({ name: 'typescript' });
    await PostTag.create({ postId: a.id, tagId: ruby.id });
    await PostTag.create({ postId: a.id, tagId: ts.id });
    await PostTag.create({ postId: b.id, tagId: ruby.id });

    const posts = await Post.all();
    queryCount = 0;
    await Post.preloadHasManyThrough(posts, Tag, PostTag, { sourceKey: 'postId', targetKey: 'tagId', as: '_tags' });

    expect(queryCount).toBe(2);
    const byTitle = Object.fromEntries(posts.map((p) => [p.title, (p as any)._tags.map((t: Tag) => t.name).sort()]));
    expect(byTitle).toEqual({ A: ['ruby', 'typescript'], B: ['ruby'] });
  });

  it('preloadHasManyThrough short-circuits without querying when given no records', async () => {
    queryCount = 0;
    await Post.preloadHasManyThrough([], Tag, PostTag, { sourceKey: 'postId', targetKey: 'tagId', as: '_tags' });
    expect(queryCount).toBe(0);
  });
});

describe('hasAndBelongsToMany (bare join table)', () => {
  it('associate() inserts a join row, and it shows up via the query side', async () => {
    const post = await Post.create({ title: 'A', userId: 1 });
    const ruby = await Tag.create({ name: 'ruby' });

    await post.addFavoriteTag(ruby);

    expect((await post.favoriteTags()).map((t) => t.name)).toEqual(['ruby']);
  });

  it('dissociate() removes the join row', async () => {
    const post = await Post.create({ title: 'A', userId: 1 });
    const ruby = await Tag.create({ name: 'ruby' });
    await post.addFavoriteTag(ruby);

    await post.removeFavoriteTag(ruby);

    expect(await post.favoriteTags()).toEqual([]);
  });

  it('preloadHasAndBelongsToMany fetches every post’s favorite tags in two queries total', async () => {
    const a = await Post.create({ title: 'A', userId: 1 });
    const b = await Post.create({ title: 'B', userId: 1 });
    const ruby = await Tag.create({ name: 'ruby' });
    const ts = await Tag.create({ name: 'typescript' });
    await a.addFavoriteTag(ruby);
    await a.addFavoriteTag(ts);
    await b.addFavoriteTag(ruby);

    const posts = await Post.all();
    queryCount = 0;
    await Post.preloadHasAndBelongsToMany(posts, Tag, {
      joinTable: 'postsFavoriteTags',
      sourceKey: 'postId',
      targetKey: 'tagId',
      as: '_favoriteTags',
    });

    expect(queryCount).toBe(2);
    const byTitle = Object.fromEntries(
      posts.map((p) => [p.title, (p as any)._favoriteTags.map((t: Tag) => t.name).sort()])
    );
    expect(byTitle).toEqual({ A: ['ruby', 'typescript'], B: ['ruby'] });
  });
});

describe('polymorphic associations', () => {
  it('hasManyPolymorphic only matches comments with the matching type, not just the matching id', async () => {
    const post = await Post.create({ title: 'A', userId: 1 });
    const photo = await Photo.create({ url: 'a.png' });
    // deliberately share the same numeric id across both tables to prove the type filter matters
    await Comment.create({ body: 'on the post', commentableId: post.id, commentableType: 'post' });
    await Comment.create({ body: 'on the photo', commentableId: photo.id, commentableType: 'photo' });

    const postComments = await post.comments();
    expect(postComments.map((c) => c.body)).toEqual(['on the post']);

    const photoComments = await photo.comments();
    expect(photoComments.map((c) => c.body)).toEqual(['on the photo']);
  });

  it('hasOnePolymorphic returns the first match', async () => {
    const post = await Post.create({ title: 'A', userId: 1 });
    await Comment.create({ body: 'first', commentableId: post.id, commentableType: 'post' });
    await Comment.create({ body: 'second', commentableId: post.id, commentableType: 'post' });

    const latest = await post.latestComment();
    expect(latest?.body).toBe('first');
  });

  it('belongsToPolymorphic resolves to the right target class based on the type column', async () => {
    const post = await Post.create({ title: 'A', userId: 1 });
    const photo = await Photo.create({ url: 'a.png' });
    const onPost = await Comment.create({ body: 'x', commentableId: post.id, commentableType: 'post' });
    const onPhoto = await Comment.create({ body: 'y', commentableId: photo.id, commentableType: 'photo' });

    const postResolved = await onPost.commentable();
    expect(postResolved).toBeInstanceOf(Post);
    expect((postResolved as Post).title).toBe('A');

    const photoResolved = await onPhoto.commentable();
    expect(photoResolved).toBeInstanceOf(Photo);
    expect((photoResolved as Photo).url).toBe('a.png');
  });

  it('belongsToPolymorphic resolves to undefined for an unrecognized type string', async () => {
    const comment = await Comment.create({ body: 'x', commentableId: 1, commentableType: 'video' });
    expect(await comment.commentable()).toBeUndefined();
  });

  it('preloadHasManyPolymorphic fetches every post’s comments in a single query, respecting the type filter', async () => {
    const a = await Post.create({ title: 'A', userId: 1 });
    const b = await Post.create({ title: 'B', userId: 1 });
    await Comment.create({ body: 'a1', commentableId: a.id, commentableType: 'post' });
    await Comment.create({ body: 'a2', commentableId: a.id, commentableType: 'post' });
    await Comment.create({ body: 'b1', commentableId: b.id, commentableType: 'post' });
    await Comment.create({ body: 'fake', commentableId: a.id, commentableType: 'photo' }); // shares a.id, wrong type

    const posts = await Post.all();
    queryCount = 0;
    await Post.preloadHasManyPolymorphic(posts, Comment, {
      idField: 'commentableId',
      typeField: 'commentableType',
      typeValue: 'post',
      as: '_comments',
    });

    expect(queryCount).toBe(1);
    const byTitle = Object.fromEntries(
      posts.map((p) => [p.title, (p as any)._comments.map((c: Comment) => c.body).sort()])
    );
    expect(byTitle).toEqual({ A: ['a1', 'a2'], B: ['b1'] });
  });

  it('preloadBelongsToPolymorphic resolves mixed-type records in one query per distinct type present', async () => {
    const post = await Post.create({ title: 'A', userId: 1 });
    const photo = await Photo.create({ url: 'a.png' });
    await Comment.create({ body: 'x', commentableId: post.id, commentableType: 'post' });
    await Comment.create({ body: 'y', commentableId: photo.id, commentableType: 'photo' });

    const comments = await Comment.all();
    queryCount = 0;
    await Comment.preloadBelongsToPolymorphic(comments, {
      idField: 'commentableId',
      typeField: 'commentableType',
      types: COMMENTABLE_TYPES,
      as: '_commentable',
    });

    expect(queryCount).toBe(2); // one query for the "post" bucket, one for the "photo" bucket
    const byBody = Object.fromEntries(comments.map((c) => [c.body, (c as any)._commentable]));
    expect(byBody['x']).toBeInstanceOf(Post);
    expect(byBody['y']).toBeInstanceOf(Photo);
  });

  it('preloadBelongsToPolymorphic leaves `as` undefined for an unrecognized type string', async () => {
    const comment = await Comment.create({ body: 'x', commentableId: 1, commentableType: 'video' });
    await Comment.preloadBelongsToPolymorphic([comment], {
      idField: 'commentableId',
      typeField: 'commentableType',
      types: COMMENTABLE_TYPES,
      as: '_commentable',
    });
    expect((comment as any)._commentable).toBeUndefined();
  });

  it('preloadHasManyPolymorphic short-circuits without querying when given no records', async () => {
    queryCount = 0;
    await Post.preloadHasManyPolymorphic([], Comment, {
      idField: 'commentableId',
      typeField: 'commentableType',
      typeValue: 'post',
      as: '_comments',
    });
    expect(queryCount).toBe(0);
  });
});
