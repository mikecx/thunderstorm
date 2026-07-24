import path from 'path';
import knexFactory from 'knex';
import { Model, connect, transaction } from '../Model';
import {
  BeforeCreate,
  AfterCreate,
  BeforeDestroy,
  Column,
  Delegate,
  Enum,
  PrimaryKey,
  Timestamped,
  Validates,
} from '../decorators';

class User extends Model {
  static tableName = 'users';

  @PrimaryKey()
  id!: number;

  @Column()
  @Validates({ presence: true, length: { min: 2, max: 50 } })
  name!: string;

  @Column()
  @Validates({ presence: true })
  @Validates({ format: { with: /^[^@\s]+@[^@\s]+\.[^@\s]+$/ }, message: 'is not a valid email address' })
  email!: string;

  posts() {
    return this.hasMany(Post, { foreignKey: 'userId' });
  }
}

class Post extends Model {
  static tableName = 'posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;

  @Column()
  slug!: string;

  @Column()
  pinned!: number;

  @Column()
  userId!: number;

  @BeforeCreate()
  generateSlug() {
    this.slug = this.title.toLowerCase().trim().replace(/\s+/g, '-');
  }

  @AfterCreate()
  logCreated() {
    console.log(`  [afterCreate] post #${this.id} created with slug "${this.slug}"`);
  }

  @BeforeDestroy()
  blockDestroyIfPinned() {
    if (this.pinned) {
      console.log('  [beforeDestroy] blocked: post is pinned');
      return false;
    }
  }

  author() {
    return this.belongsTo(User, { foreignKey: 'userId' });
  }
}

// --- casting + custom accessor -----------------------------------------

class Order extends Model {
  static tableName = 'orders';

  @PrimaryKey()
  id!: number;

  @Column({ type: 'boolean' })
  paid!: boolean;

  @Column({ type: 'date' })
  placedAt!: Date;

  @Column({ type: 'json' })
  metadata!: Record<string, any>;

  // Custom setter normalizing every write. Backing field has NO initializer —
  // one is needed here (see README) so it doesn't get reset after super() runs.
  // @Column() goes on the first of the get/set pair (TS requires exactly one).
  private _code!: string;

  @Column()
  get code(): string {
    return this._code;
  }

  set code(value: string) {
    this._code = value.trim().toUpperCase();
  }
}

// --- delegate ------------------------------------------------------------

class Writer extends Model {
  static tableName = 'writers';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;
}

@Delegate(['name'], { to: 'writer' })
class Article extends Model {
  static tableName = 'articles';

  @PrimaryKey()
  id!: number;

  @Column()
  writerId!: number;

  writer() {
    return this.belongsTo(Writer, { foreignKey: 'writerId' });
  }
}
interface Article {
  writerName(): Promise<string | undefined>;
}

// --- enum + scopes ---------------------------------------------------------

@Enum('status', { open: 0, inProgress: 1, closed: 2 })
class Ticket extends Model {
  static tableName = 'tickets';

  @PrimaryKey()
  id!: number;

  @Column()
  subject!: string;

  @Column()
  status!: number;

  static open<T extends typeof Ticket>(this: T) {
    return this.where({ status: 0 } as any);
  }
}
interface Ticket {
  statusLabel: string;
  isOpen(): boolean;
  isInProgress(): boolean;
  isClosed(): boolean;
}

// --- timestamps ------------------------------------------------------------

class TimestampedPost extends Timestamped(Model) {
  static tableName = 'timestamped_posts';

  @PrimaryKey()
  id!: number;

  @Column()
  title!: string;
}

// --- transactions ----------------------------------------------------------

class Account extends Model {
  static tableName = 'accounts';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column()
  balance!: number;
}

async function main() {
  // Same migrations that `npm run migrate:latest` applies to the real dev
  // database (via knexfile.ts) — run here against a fresh in-memory DB so
  // the demo is self-contained and always reflects the real schema.
  const knex = knexFactory({
    client: 'sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    migrations: { directory: path.join(__dirname, '../../migrations') },
  });
  connect(knex);
  await knex.migrate.latest();

  const alice = await User.create({ name: 'Alice', email: 'alice@example.com' });
  console.log('created:', alice.id, alice.name, alice.isPersisted);

  await User.create({ name: 'Bob', email: 'bob@example.com' });

  const found = await User.find(alice.id);
  console.log('found:', found?.name);

  console.log('changed before edit:', found!.isChanged);
  found!.email = 'alice@newdomain.com';
  console.log('changes after edit:', found!.changes);
  await found!.save();
  console.log('changed after save:', found!.isChanged, '| previousChanges:', found!.previousChanges);
  const reloaded = await User.find(alice.id);
  console.log('after update:', reloaded?.email);

  const all = await User.all();
  console.log(
    'all users:',
    all.map((u) => u.name)
  );

  const bobs = await User.where({ name: 'Bob' });
  console.log(
    'where name=Bob:',
    bobs.map((u) => u.email)
  );

  const first = await User.where({}).order('name', 'desc').first();
  console.log('first ordered by name desc:', first?.name);

  await found!.destroy();
  console.log('remaining after destroy:', (await User.all()).length);

  const invalid = new User({ name: 'A', email: 'not-an-email' });
  const saved = await invalid.save();
  console.log('invalid save returned:', saved, 'isPersisted:', invalid.isPersisted);
  console.log('errors on name:', invalid.errors.on('name'));
  console.log('errors on email:', invalid.errors.on('email'));
  console.log('full messages:', invalid.errors.full);

  try {
    await invalid.saveOrFail();
  } catch (err: any) {
    console.log('saveOrFail threw:', err.name, '-', err.message);
  }

  const post = await Post.create({ title: 'Hello Callbacks', pinned: 1 });
  console.log('post slug (set by beforeCreate):', post.slug);

  const destroyedWhilePinned = await post.destroy();
  console.log('destroy while pinned returned:', destroyedWhilePinned, 'isPersisted:', post.isPersisted);

  post.pinned = 0;
  await post.save();
  const destroyedAfterUnpin = await post.destroy();
  console.log('destroy after unpin returned:', destroyedAfterUnpin, 'isPersisted:', post.isPersisted);

  const carol = await User.create({ name: 'Carol', email: 'carol@example.com' });
  const dave = await User.create({ name: 'Dave', email: 'dave@example.com' });
  await Post.create({ title: 'Carol Post 1', userId: carol.id });
  await Post.create({ title: 'Carol Post 2', userId: carol.id });
  await Post.create({ title: 'Dave Post 1', userId: dave.id });

  const carolsPosts = await carol.posts();
  console.log(
    "carol's posts (lazy hasMany):",
    carolsPosts.map((p) => p.title)
  );

  const somePost = carolsPosts[0];
  const author = await somePost.author();
  console.log('post author (lazy belongsTo):', author?.name);

  let queryCount = 0;
  knex.on('query', () => queryCount++);

  const authors = await User.where({});
  for (const u of authors) {
    await u.posts(); // naive: one query per user
  }
  console.log(`naive per-record loading: ${queryCount} queries for ${authors.length} users`);

  queryCount = 0;
  await User.preloadHasMany(authors, Post, { foreignKey: 'userId', as: '_posts' });
  console.log(`preloadHasMany: ${queryCount} query for the same ${authors.length} users`);
  console.log(
    'preloaded titles by user:',
    Object.fromEntries(authors.map((u) => [u.name, (u as any)._posts.map((p: Post) => p.title)]))
  );

  // --- casting + custom accessor -----------------------------------------

  const order = await Order.create({
    code: '  ab-123  ',
    paid: true,
    placedAt: new Date('2026-01-15T10:00:00.000Z'),
    metadata: { items: 2, currency: 'USD' },
  });
  console.log('order.code (custom setter normalized it):', order.code);
  const reloadedOrder = await Order.find(order.id);
  console.log(
    'order round-tripped through the DB — paid:',
    typeof reloadedOrder!.paid,
    reloadedOrder!.paid,
    '| placedAt:',
    reloadedOrder!.placedAt instanceof Date,
    '| metadata:',
    reloadedOrder!.metadata
  );

  // --- delegate ------------------------------------------------------------

  const writer = await Writer.create({ name: 'Grace' });
  const article = await Article.create({ writerId: writer.id });
  console.log('article.writerName() (delegate):', await article.writerName());

  // --- enum + scopes ---------------------------------------------------------

  await Ticket.create({ subject: 'Bug A', status: 0 });
  await Ticket.create({ subject: 'Bug B', status: 1 });
  const ticket = await Ticket.create({ subject: 'Bug C', status: 0 });
  console.log('ticket.statusLabel:', ticket.statusLabel, '| isOpen():', ticket.isOpen());
  const openTickets = await Ticket.open();
  console.log(
    'Ticket.open() scope:',
    openTickets.map((t) => t.subject)
  );

  // --- timestamps ------------------------------------------------------------

  const tsPost = await TimestampedPost.create({ title: 'Hello Timestamps' });
  console.log('createdAt set by Timestamped mixin:', tsPost.createdAt instanceof Date, tsPost.createdAt);
  const createdAt = tsPost.createdAt;
  tsPost.title = 'Updated title';
  await tsPost.save();
  console.log(
    'after update — createdAt unchanged:',
    tsPost.createdAt.getTime() === createdAt.getTime(),
    '| updatedAt bumped:',
    tsPost.updatedAt.getTime() >= createdAt.getTime()
  );

  // --- transactions ----------------------------------------------------------

  const alice2 = await Account.create({ name: 'Alice', balance: 100 });
  const bob2 = await Account.create({ name: 'Bob', balance: 50 });

  await transaction(async () => {
    alice2.balance -= 30;
    await alice2.save();
    bob2.balance += 30;
    await bob2.save();
  });
  console.log('after committed transfer — Alice:', alice2.balance, '| Bob:', bob2.balance);

  try {
    await transaction(async () => {
      alice2.balance -= 1000; // would go negative
      await alice2.save();
      throw new Error('insufficient funds, abort transfer');
    });
  } catch (err: any) {
    console.log('transaction rolled back after:', err.message);
  }
  const finalAlice = await Account.find(alice2.id);
  console.log('Alice balance unchanged after rollback:', finalAlice!.balance);

  await knex.destroy();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
