import { randomUUID } from 'crypto';
import type { Knex } from 'knex';
import { getAttr } from './AttributeModel';
import { ownCallbackList, ownColumns } from './decorators';
import type { Model } from './Model';

/**
 * The one thing thunderstorm needs to guarantee correctness: writing bytes
 * on attach, deleting bytes on purge/destroy. Deliberately not a full
 * "storage service" — no `get`, no `url`, no variants. Serving a file back
 * out (signed URLs, a CDN path, a static file route) is a deployment-specific,
 * controller-shaped concern that stays entirely the caller's; thunderstorm
 * only owns the write/delete half of the lifecycle.
 */
export interface BlobStorage {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface AttachmentInput {
  filename: string;
  contentType: string;
}

interface AttachmentOptions {
  /** Overrides the default `randomUUID() + extension` key generator. */
  generateKey?: (filename: string) => string;
}

function defaultGenerateKey(filename: string): string {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot) : '';
  return `${randomUUID()}${ext}`;
}

function capitalize(word: string): string {
  return word.length === 0 ? word : word[0].toUpperCase() + word.slice(1);
}

/**
 * Attaches a single file's metadata (key/filename/content type/byte size) to
 * a `Model` — a class decorator, not a mixin, since (like `@Delegate`/`@Enum`)
 * the generated member names are derived from the runtime `name` string and
 * so aren't visible to the type checker on their own; declare them via
 * interface merging (see README's "File attachments").
 *
 * `storage` is required, not optional: a model can't be decorated without a
 * way to clean up after itself, which is what makes the destroy-time
 * auto-purge below a guarantee rather than something callers have to
 * remember to opt into.
 */
export function HasOneAttached(name: string, storage: BlobStorage, options: AttachmentOptions = {}) {
  const generateKey = options.generateKey ?? defaultGenerateKey;
  const keyProp = `${name}Key`;
  const filenameProp = `${name}Filename`;
  const contentTypeProp = `${name}ContentType`;
  const byteSizeProp = `${name}ByteSize`;
  const attachedProp = `${name}Attached`;
  const cap = capitalize(name);
  const attachMethod = `attach${cap}`;
  const purgeMethod = `purge${cap}`;
  const purgeOnDestroyMethod = `__purge${cap}OnDestroy`;

  return function (target: any, context: ClassDecoratorContext): void {
    const columns = ownColumns(context.metadata);
    // guarded: server-generated bookkeeping, never mass-assignable and never
    // serialized by default — same reasoning as SecurePassword's passwordDigest.
    columns.set(keyProp, { guarded: true });
    columns.set(filenameProp, { guarded: true });
    columns.set(contentTypeProp, { guarded: true });
    columns.set(byteSizeProp, { guarded: true });

    Object.defineProperty(target.prototype, attachedProp, {
      get(this: any) {
        return getAttr(this, keyProp) != null;
      },
      enumerable: true,
      configurable: true,
    });

    target.prototype[attachMethod] = async function (this: Model, data: Buffer, meta: AttachmentInput): Promise<void> {
      const key = generateKey(meta.filename);
      await storage.put(key, data, meta.contentType);

      const previousKey = getAttr(this as any, keyProp);
      try {
        await this.updateOrFail({
          [keyProp]: key,
          [filenameProp]: meta.filename,
          [contentTypeProp]: meta.contentType,
          [byteSizeProp]: data.length,
        } as any);
      } catch (err) {
        // the blob is already written but nothing points at it yet — best
        // effort cleanup, but don't let a delete failure mask the real error.
        await storage.delete(key).catch(() => {});
        throw err;
      }

      if (previousKey) await storage.delete(previousKey);
    };

    target.prototype[purgeMethod] = async function (this: Model): Promise<void> {
      const key = getAttr(this as any, keyProp);
      if (!key) return;
      await this.updateOrFail({
        [keyProp]: null,
        [filenameProp]: null,
        [contentTypeProp]: null,
        [byteSizeProp]: null,
      } as any);
      await storage.delete(key);
    };

    target.prototype[purgeOnDestroyMethod] = async function (this: Model): Promise<void> {
      const key = getAttr(this as any, keyProp);
      if (key) await storage.delete(key);
    };
    ownCallbackList(context.metadata, 'afterDestroy').push(purgeOnDestroyMethod);
  };
}

/**
 * Attaches multiple files to a `Model` via a real, ordinary `@Column()`
 * table — thunderstorm has no polymorphic associations, so each attachment
 * point gets its own table (`AttachmentModel`), defined the same way any
 * other model is. `name` accessor/method names are used exactly as given
 * (no pluralization/singularization guessing), matching `@Enum`'s existing
 * convention of deriving names directly from the literal string.
 */
export function HasManyAttached(
  name: string,
  AttachmentModel: typeof Model,
  associationOptions: { foreignKey: string; localKey?: string },
  storage: BlobStorage,
  options: AttachmentOptions = {}
) {
  const generateKey = options.generateKey ?? defaultGenerateKey;
  const cap = capitalize(name);
  const attachMethod = `attach${cap}`;
  const purgeMethod = `purge${cap}`;
  const purgeOnDestroyMethod = `__purge${cap}OnDestroy`;

  return function (target: any, context: ClassDecoratorContext): void {
    target.prototype[name] = function (this: Model) {
      return (this as any).hasMany(AttachmentModel, associationOptions);
    };

    target.prototype[attachMethod] = async function (this: Model, data: Buffer, meta: AttachmentInput) {
      const key = generateKey(meta.filename);
      await storage.put(key, data, meta.contentType);

      const localKey = associationOptions.localKey ?? (this.constructor as typeof Model).primaryKey;
      try {
        return await (AttachmentModel as any).create({
          [associationOptions.foreignKey]: getAttr(this as any, localKey),
          key,
          filename: meta.filename,
          contentType: meta.contentType,
          byteSize: data.length,
        });
      } catch (err) {
        await storage.delete(key).catch(() => {});
        throw err;
      }
    };

    const purgeAll = async function (this: Model): Promise<void> {
      const attached: InstanceType<typeof AttachmentModel>[] = await (this as any)[name]();
      for (const record of attached) {
        await storage.delete((record as any).key);
        await record.destroy();
      }
    };
    target.prototype[purgeMethod] = purgeAll;
    target.prototype[purgeOnDestroyMethod] = purgeAll;
    ownCallbackList(context.metadata, 'afterDestroy').push(purgeOnDestroyMethod);
  };
}

/** Adds the four nullable columns `@HasOneAttached(name, ...)` expects on the owning table. */
export function attachmentColumns(table: Knex.TableBuilder, name: string): void {
  table.string(`${name}Key`).nullable();
  table.string(`${name}Filename`).nullable();
  table.string(`${name}ContentType`).nullable();
  table.integer(`${name}ByteSize`).nullable();
}

/** Creates the table `@HasManyAttached(name, AttachmentModel, { foreignKey }, ...)` expects. */
export async function createAttachmentTable(
  knex: Knex,
  tableName: string,
  options: { foreignKey: string }
): Promise<void> {
  await knex.schema.createTable(tableName, (t) => {
    t.increments('id');
    t.integer(options.foreignKey).notNullable().index();
    t.string('key').notNullable();
    t.string('filename').notNullable();
    t.string('contentType').notNullable();
    t.integer('byteSize').notNullable();
  });
}
