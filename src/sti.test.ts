import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey, STI } from './decorators';

class Vehicle extends Model {
  static tableName = 'vehicles';

  @PrimaryKey()
  id!: number;

  @Column()
  type!: string;

  @Column()
  make!: string;
}

@STI('car')
class Car extends Vehicle {
  @Column()
  doors!: number;

  honk(): string {
    return 'beep';
  }
}

@STI('truck')
class Truck extends Vehicle {
  @Column()
  bedLength!: number;

  honk(): string {
    return 'HONK';
  }
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('vehicles');
  await knex.schema.createTable('vehicles', (t) => {
    t.increments('id');
    t.string('type');
    t.string('make');
    t.integer('doors').nullable();
    t.integer('bedLength').nullable();
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('STI', () => {
  it('@STI stamps the type column automatically on create()', async () => {
    const car = await Car.create({ make: 'Honda', doors: 4 });
    const truck = await Truck.create({ make: 'Ford', bedLength: 6 });

    expect(car.type).toBe('car');
    expect(truck.type).toBe('truck');
  });

  it("a subclass's all()/where()/find() only see its own type", async () => {
    const car = await Car.create({ make: 'Honda', doors: 4 });
    const truck = await Truck.create({ make: 'Ford', bedLength: 6 });

    expect((await Car.all()).map((c) => c.make)).toEqual(['Honda']);
    expect((await Truck.all()).map((t) => t.make)).toEqual(['Ford']);
    expect(await Car.find(truck.id)).toBeUndefined();
    expect(await Truck.find(car.id)).toBeUndefined();
  });

  it('the base class sees every type, instantiated as the correct subclass', async () => {
    const car = await Car.create({ make: 'Honda', doors: 4 });
    const truck = await Truck.create({ make: 'Ford', bedLength: 6 });

    const all = await Vehicle.all();
    expect(all).toHaveLength(2);

    const foundCar = all.find((v) => v.id === car.id)!;
    const foundTruck = all.find((v) => v.id === truck.id)!;
    expect(foundCar).toBeInstanceOf(Car);
    expect(foundTruck).toBeInstanceOf(Truck);
    expect((foundCar as Car).doors).toBe(4);
    expect((foundTruck as Truck).bedLength).toBe(6);
    expect((foundCar as Car).honk()).toBe('beep');
    expect((foundTruck as Truck).honk()).toBe('HONK');
  });

  it('Vehicle.find() also reconstructs the correct subclass', async () => {
    const truck = await Truck.create({ make: 'Ford', bedLength: 6 });

    const found = await Vehicle.find(truck.id);
    expect(found).toBeInstanceOf(Truck);
    expect((found as Truck).bedLength).toBe(6);
  });

  it('falls back to the queried class for an unrecognized type value', async () => {
    await knex('vehicles').insert({ type: 'motorcycle', make: 'Honda' });

    const all = await Vehicle.all();
    expect(all).toHaveLength(1);
    expect(all[0]).toBeInstanceOf(Vehicle);
    expect(all[0]).not.toBeInstanceOf(Car);
    expect(all[0]).not.toBeInstanceOf(Truck);
  });
});
