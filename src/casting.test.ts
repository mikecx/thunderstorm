import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey } from './decorators';

class Widget extends Model {
  static tableName = 'widgets';

  @PrimaryKey()
  id!: number;

  @Column({ type: 'string' })
  name!: string;

  @Column({ type: 'number' })
  quantity!: number;

  @Column({ type: 'boolean' })
  active!: boolean;

  @Column({ type: 'date' })
  releasedAt!: Date | null;

  @Column({ type: 'json' })
  metadata!: Record<string, any> | null;

  // A custom setter normalizing every write; also runs when loading from the DB (see README caveat).
  //
  // The backing field must be `declare`d, not a real field declaration:
  // TC39 decorators require standards-compliant class-fields semantics, so
  // once any field in this class is decorated, *every* plain field
  // declaration — even one with no initializer — gets an implicit
  // `this._sku = undefined` inserted right after super() returns, clobbering
  // whatever the setter (invoked by Object.assign in Model's constructor,
  // via super()) had just written. `declare` tells TypeScript this property
  // exists without emitting any field-initialization code for it at all.
  declare private _sku: string;

  get sku(): string {
    return this._sku;
  }

  set sku(value: string) {
    this._sku = value.trim().toUpperCase();
  }
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('widgets');
  await knex.schema.createTable('widgets', (t) => {
    t.increments('id');
    t.string('name');
    t.integer('quantity');
    t.integer('active');
    t.text('releasedAt');
    t.text('metadata');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('built-in casters round-trip through the database', () => {
  it('boolean: stores as sqlite 0/1, loads back as a real JS boolean', async () => {
    const widget = await Widget.create({ name: 'Gadget', active: true });
    expect(widget.active).toBe(true);

    const rawRow = await knex('widgets').where('id', widget.id).first();
    expect(rawRow.active === 1 || rawRow.active === true).toBe(true);

    const reloaded = await Widget.find(widget.id);
    expect(reloaded!.active).toBe(true);
    expect(typeof reloaded!.active).toBe('boolean');

    const off = await Widget.create({ name: 'Off', active: false });
    expect((await Widget.find(off.id))!.active).toBe(false);
  });

  it('date: stores as an ISO string, loads back as a real Date instance', async () => {
    const when = new Date('2026-01-15T10:00:00.000Z');
    const widget = await Widget.create({ name: 'Timed', releasedAt: when });

    const rawRow = await knex('widgets').where('id', widget.id).first();
    expect(typeof rawRow.releasedAt).toBe('string');

    const reloaded = await Widget.find(widget.id);
    expect(reloaded!.releasedAt).toBeInstanceOf(Date);
    expect(reloaded!.releasedAt!.getTime()).toBe(when.getTime());
  });

  it('json: stores as a JSON string, loads back as a real object', async () => {
    const widget = await Widget.create({ name: 'Configured', metadata: { color: 'red', tags: ['a', 'b'] } });

    const rawRow = await knex('widgets').where('id', widget.id).first();
    expect(typeof rawRow.metadata).toBe('string');
    expect(JSON.parse(rawRow.metadata)).toEqual({ color: 'red', tags: ['a', 'b'] });

    const reloaded = await Widget.find(widget.id);
    expect(reloaded!.metadata).toEqual({ color: 'red', tags: ['a', 'b'] });
  });

  it('number: coerces on load even if the driver hands back a string-ish value', async () => {
    const widget = await Widget.create({ name: 'Counted', quantity: 5 });
    await knex('widgets')
      .where('id', widget.id)
      .update({ quantity: '7' as any });

    const reloaded = await Widget.find(widget.id);
    expect(reloaded!.quantity).toBe(7);
    expect(typeof reloaded!.quantity).toBe('number');
  });

  it('null values pass through casters untouched', async () => {
    const widget = await Widget.create({ name: 'Bare', releasedAt: null, metadata: null });
    const reloaded = await Widget.find(widget.id);
    expect(reloaded!.releasedAt).toBeNull();
    expect(reloaded!.metadata).toBeNull();
  });
});

describe('dirty tracking with cast values', () => {
  it('treats two Date instances with the same timestamp as unchanged', async () => {
    const when = new Date('2026-01-15T10:00:00.000Z');
    const widget = await Widget.create({ name: 'Timed', releasedAt: when });

    widget.releasedAt = new Date('2026-01-15T10:00:00.000Z'); // different instance, same moment
    expect(widget.isChanged).toBe(false);

    widget.releasedAt = new Date('2026-02-01T00:00:00.000Z');
    expect(widget.isChanged).toBe(true);
  });
});

describe('custom accessors/setters', () => {
  it('a hand-written setter normalizes every write, including via the constructor', () => {
    const widget = new Widget({ name: 'X', sku: '  ab-123  ' });
    expect(widget.sku).toBe('AB-123');

    widget.sku = 'zz-999';
    expect(widget.sku).toBe('ZZ-999');
  });
});
