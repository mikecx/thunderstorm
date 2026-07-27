import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey, Validates } from './decorators';
import { HasOneAttached, HasManyAttached, BlobStorage } from './attachments';

/** In-memory BlobStorage test double — records every put/delete call so tests can assert on them. */
class FakeStorage implements BlobStorage {
  readonly blobs = new Map<string, { data: Buffer; contentType: string }>();
  readonly putCalls: string[] = [];
  readonly deleteCalls: string[] = [];

  async put(key: string, data: Buffer, contentType: string): Promise<void> {
    this.putCalls.push(key);
    this.blobs.set(key, { data, contentType });
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    this.blobs.delete(key);
  }
}

const avatarStorage = new FakeStorage();
const imageStorage = new FakeStorage();

class PostImage extends Model {
  static tableName = 'post_images';

  @PrimaryKey()
  id!: number;

  @Column()
  postId!: number;

  @Column()
  key!: string;

  @Column()
  filename!: string;

  @Column()
  contentType!: string;

  @Column()
  byteSize!: number;
}

@HasOneAttached('avatar', avatarStorage)
class User extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  @Validates({ presence: true })
  email!: string;
}

interface User {
  avatarKey: string | null;
  avatarFilename: string | null;
  avatarContentType: string | null;
  avatarByteSize: number | null;
  readonly avatarAttached: boolean;
  attachAvatar(data: Buffer, meta: { filename: string; contentType: string }): Promise<void>;
  purgeAvatar(): Promise<void>;
}

@HasManyAttached('images', PostImage, { foreignKey: 'postId' }, imageStorage)
class Post extends Model {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;
}

interface Post {
  images(): Promise<PostImage[]>;
  attachImages(data: Buffer, meta: { filename: string; contentType: string }): Promise<PostImage>;
  purgeImages(): Promise<void>;
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  avatarStorage.blobs.clear();
  avatarStorage.putCalls.length = 0;
  avatarStorage.deleteCalls.length = 0;
  imageStorage.blobs.clear();
  imageStorage.putCalls.length = 0;
  imageStorage.deleteCalls.length = 0;

  await knex.schema.dropTableIfExists('users');
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('email');
    t.string('avatarKey');
    t.string('avatarFilename');
    t.string('avatarContentType');
    t.integer('avatarByteSize');
  });

  await knex.schema.dropTableIfExists('posts');
  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title');
  });
  await knex.schema.dropTableIfExists('post_images');
  await knex.schema.createTable('post_images', (t) => {
    t.increments('id');
    t.integer('postId');
    t.string('key');
    t.string('filename');
    t.string('contentType');
    t.integer('byteSize');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('@HasOneAttached', () => {
  it('attaches a file: persists metadata, writes the blob under a generated key', async () => {
    const user = await User.create({ email: 'a@example.com' });
    const data = Buffer.from('hello world');

    await user.attachAvatar(data, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(user.avatarKey).toBeTruthy();
    expect(user.avatarFilename).toBe('photo.jpg');
    expect(user.avatarContentType).toBe('image/jpeg');
    expect(user.avatarByteSize).toBe(data.length);
    expect(user.avatarAttached).toBe(true);
    expect(avatarStorage.putCalls).toEqual([user.avatarKey]);
    expect(avatarStorage.blobs.get(user.avatarKey!)?.data.toString()).toBe('hello world');

    const reloaded = await User.find(user.id);
    expect(reloaded!.avatarKey).toBe(user.avatarKey);
  });

  it('avatarAttached is false before anything is attached', async () => {
    const user = await User.create({ email: 'a@example.com' });
    expect(user.avatarAttached).toBe(false);
  });

  it('does not require a caller-supplied key — generateKey produces a fresh one each time', async () => {
    const user = await User.create({ email: 'a@example.com' });
    await user.attachAvatar(Buffer.from('one'), { filename: 'a.png', contentType: 'image/png' });
    const firstKey = user.avatarKey;
    await user.attachAvatar(Buffer.from('two'), { filename: 'b.png', contentType: 'image/png' });
    expect(user.avatarKey).not.toBe(firstKey);
  });

  it('reattaching deletes the previous blob automatically', async () => {
    const user = await User.create({ email: 'a@example.com' });
    await user.attachAvatar(Buffer.from('one'), { filename: 'a.png', contentType: 'image/png' });
    const firstKey = user.avatarKey!;

    await user.attachAvatar(Buffer.from('two'), { filename: 'b.png', contentType: 'image/png' });

    expect(avatarStorage.deleteCalls).toEqual([firstKey]);
    expect(avatarStorage.blobs.has(firstKey)).toBe(false);
    expect(avatarStorage.blobs.has(user.avatarKey!)).toBe(true);
  });

  it('purgeAvatar clears the columns and deletes the blob', async () => {
    const user = await User.create({ email: 'a@example.com' });
    await user.attachAvatar(Buffer.from('one'), { filename: 'a.png', contentType: 'image/png' });
    const key = user.avatarKey!;

    await user.purgeAvatar();

    expect(user.avatarKey).toBeNull();
    expect(user.avatarAttached).toBe(false);
    expect(avatarStorage.deleteCalls).toEqual([key]);

    const reloaded = await User.find(user.id);
    expect(reloaded!.avatarKey).toBeNull();
  });

  it('purgeAvatar on a record with nothing attached is a harmless no-op', async () => {
    const user = await User.create({ email: 'a@example.com' });
    await expect(user.purgeAvatar()).resolves.toBeUndefined();
    expect(avatarStorage.deleteCalls).toEqual([]);
  });

  it('destroy() auto-purges the attached blob without calling purgeAvatar first', async () => {
    const user = await User.create({ email: 'a@example.com' });
    await user.attachAvatar(Buffer.from('one'), { filename: 'a.png', contentType: 'image/png' });
    const key = user.avatarKey!;

    await user.destroy();

    expect(avatarStorage.deleteCalls).toEqual([key]);
  });

  it('destroy() on a record with nothing attached does not call storage.delete', async () => {
    const user = await User.create({ email: 'a@example.com' });
    await user.destroy();
    expect(avatarStorage.deleteCalls).toEqual([]);
  });

  it('if the metadata save fails after the blob was written, the orphaned blob is best-effort cleaned up and the error propagates', async () => {
    const user = new User({}); // no email — violates presence validation, never persisted
    const data = Buffer.from('doomed');

    await expect(user.attachAvatar(data, { filename: 'x.png', contentType: 'image/png' })).rejects.toThrow();

    expect(avatarStorage.putCalls).toHaveLength(1);
    const attemptedKey = avatarStorage.putCalls[0];
    expect(avatarStorage.deleteCalls).toEqual([attemptedKey]);
    expect(avatarStorage.blobs.has(attemptedKey)).toBe(false);
  });

  it('the four generated columns are guarded — excluded from permit() and default serialization', async () => {
    const user = await User.create({ email: 'a@example.com' });
    await user.attachAvatar(Buffer.from('one'), { filename: 'a.png', contentType: 'image/png' });

    const permitted = User.permit({ email: 'x@example.com', avatarKey: 'hacked-key' }, ['email', 'avatarKey'] as any);
    expect(permitted).not.toHaveProperty('avatarKey');

    const json = user.toJSON();
    expect(json).not.toHaveProperty('avatarKey');
  });
});

describe('@HasManyAttached', () => {
  it('attaches multiple files, each as its own row', async () => {
    const post = await Post.create({ title: 'Hello' });
    const first = await post.attachImages(Buffer.from('one'), { filename: 'a.png', contentType: 'image/png' });
    const second = await post.attachImages(Buffer.from('two'), { filename: 'b.png', contentType: 'image/png' });

    expect(first.key).not.toBe(second.key);
    expect(imageStorage.putCalls).toEqual([first.key, second.key]);

    const images = await post.images();
    expect(images.map((i) => i.filename).sort()).toEqual(['a.png', 'b.png']);
  });

  it('purgeImages deletes every blob and every row', async () => {
    const post = await Post.create({ title: 'Hello' });
    const first = await post.attachImages(Buffer.from('one'), { filename: 'a.png', contentType: 'image/png' });
    const second = await post.attachImages(Buffer.from('two'), { filename: 'b.png', contentType: 'image/png' });

    await post.purgeImages();

    expect(imageStorage.deleteCalls.sort()).toEqual([first.key, second.key].sort());
    expect(await post.images()).toEqual([]);
  });

  it('destroy() auto-purges every attached image', async () => {
    const post = await Post.create({ title: 'Hello' });
    const first = await post.attachImages(Buffer.from('one'), { filename: 'a.png', contentType: 'image/png' });

    await post.destroy();

    expect(imageStorage.deleteCalls).toEqual([first.key]);
    expect(await PostImage.find(first.id)).toBeUndefined();
  });

  it('a post with no images destroys cleanly with no storage calls', async () => {
    const post = await Post.create({ title: 'Hello' });
    await post.destroy();
    expect(imageStorage.deleteCalls).toEqual([]);
  });
});
