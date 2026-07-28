import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { AfterDestroy, Column, PrimaryKey } from './decorators';
import { Dependent } from './dependent';

let knex: Knex;

@Dependent('destroyedPosts', 'destroy')
class UserDestroy extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  destroyedPosts() {
    return this.hasMany(PostWithCallback, { foreignKey: 'userId' });
  }
}

@Dependent('deletedPosts', 'delete')
class UserDelete extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  deletedPosts() {
    return this.hasMany(PostWithCallback, { foreignKey: 'userId' });
  }
}

@Dependent('nullifiedPosts', { update: { userId: null } })
class UserNullify extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  nullifiedPosts() {
    return this.hasMany(Post, { foreignKey: 'userId' });
  }
}

@Dependent('restrictedPosts', 'restrict')
class UserRestrict extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  restrictedPosts() {
    return this.hasMany(Post, { foreignKey: 'userId' });
  }
}

@Dependent('profile', 'destroy')
class UserDestroyProfile extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  profile() {
    return this.hasOne(ProfileWithCallback, { foreignKey: 'userId' });
  }
}

@Dependent('profile', 'delete')
class UserDeleteProfile extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  profile() {
    return this.hasOne(ProfileWithCallback, { foreignKey: 'userId' });
  }
}

@Dependent('profile', 'restrict')
class UserRestrictProfile extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  profile() {
    return this.hasOne(Profile, { foreignKey: 'userId' });
  }
}

class Post extends Model {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  userId!: number | null;
}

let destroyLog: string[];

class PostWithCallback extends Model {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  userId!: number | null;

  @AfterDestroy()
  onAfterDestroy() {
    destroyLog.push(`post:${this.id}`);
  }
}

class Profile extends Model {
  static tableName = 'profiles';

  @PrimaryKey()
  id!: number;

  @Column()
  userId!: number;
}

class ProfileWithCallback extends Model {
  static tableName = 'profiles';

  @PrimaryKey()
  id!: number;

  @Column()
  userId!: number;

  @AfterDestroy()
  onAfterDestroy() {
    destroyLog.push(`profile:${this.id}`);
  }
}

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  destroyLog = [];
  await knex.schema.dropTableIfExists('posts');
  await knex.schema.dropTableIfExists('profiles');
  await knex.schema.dropTableIfExists('users');
  await knex.schema.createTable('users', (t) => {
    t.increments('id');
    t.string('name');
  });
  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
    t.integer('userId').nullable();
  });
  await knex.schema.createTable('profiles', (t) => {
    t.increments('id');
    t.integer('userId').notNullable();
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe("Dependent('...', 'destroy')", () => {
  it('runs the full destroy() lifecycle on every related record — hasMany', async () => {
    const user = await UserDestroy.create({ name: 'Alice' });
    await PostWithCallback.create({ userId: user.id });
    await PostWithCallback.create({ userId: user.id });

    const ok = await user.destroy();

    expect(ok).toBe(true);
    expect(destroyLog.sort()).toEqual(['post:1', 'post:2']);
    expect(await knex('posts').count({ c: '*' }).first()).toMatchObject({ c: 0 });
  });

  it('runs the full destroy() lifecycle on the related record — hasOne', async () => {
    const user = await UserDestroyProfile.create({ id: 1 } as any);
    await ProfileWithCallback.create({ userId: user.id });

    await user.destroy();

    expect(destroyLog).toEqual(['profile:1']);
    expect(await knex('profiles').count({ c: '*' }).first()).toMatchObject({ c: 0 });
  });

  it('does nothing if the hasOne association has no related record', async () => {
    const user = await UserDestroyProfile.create({ id: 1 } as any);

    const ok = await user.destroy();

    expect(ok).toBe(true);
    expect(destroyLog).toEqual([]);
  });
});

describe("Dependent('...', 'delete')", () => {
  it('bulk-deletes related records without running their callbacks — hasMany', async () => {
    const user = await UserDelete.create({} as any);
    await PostWithCallback.create({ userId: user.id });
    await PostWithCallback.create({ userId: user.id });

    await user.destroy();

    expect(destroyLog).toEqual([]);
    expect(await knex('posts').count({ c: '*' }).first()).toMatchObject({ c: 0 });
  });

  it('deletes the related record without running its callbacks — hasOne', async () => {
    const user = await UserDeleteProfile.create({ id: 1 } as any);
    await ProfileWithCallback.create({ userId: user.id });

    await user.destroy();

    expect(destroyLog).toEqual([]);
    expect(await knex('profiles').count({ c: '*' }).first()).toMatchObject({ c: 0 });
  });
});

describe("Dependent('...', { update: {...} })", () => {
  it('bulk-updates (nullifies) every related record instead of deleting it', async () => {
    const user = await UserNullify.create({} as any);
    const post = await Post.create({ userId: user.id });

    await user.destroy();

    const reloaded = await Post.find(post.id);
    expect(reloaded?.userId).toBeNull();
  });
});

describe("Dependent('...', 'restrict')", () => {
  it('blocks the destroy when a related record exists — hasMany', async () => {
    const user = await UserRestrict.create({} as any);
    await Post.create({ userId: user.id });

    const ok = await user.destroy();

    expect(ok).toBe(false);
    expect(user.isPersisted).toBe(true);
    expect(await knex('users').count({ c: '*' }).first()).toMatchObject({ c: 1 });
  });

  it('allows the destroy when no related record exists — hasMany', async () => {
    const user = await UserRestrict.create({} as any);

    const ok = await user.destroy();

    expect(ok).toBe(true);
  });

  it('blocks the destroy when a related record exists — hasOne', async () => {
    const user = await UserRestrictProfile.create({ id: 1 } as any);
    await Profile.create({ userId: user.id });

    const ok = await user.destroy();

    expect(ok).toBe(false);
  });

  it('allows the destroy when no related record exists — hasOne', async () => {
    const user = await UserRestrictProfile.create({ id: 1 } as any);

    const ok = await user.destroy();

    expect(ok).toBe(true);
  });
});
