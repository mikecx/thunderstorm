import { randomBytes } from 'crypto';
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import knexFactory, { Knex } from 'knex';
import { Model, connect } from './Model';
import { Column, PrimaryKey, Validates } from './decorators';
import { encryptedCaster } from './encryption';

const keyA = randomBytes(32);
const keyB = randomBytes(32);

class Patient extends Model {
  static tableName = 'patients';

  @PrimaryKey()
  id!: number;

  @Column()
  name!: string;

  @Column({ type: encryptedCaster({ keys: [keyA] }) })
  diagnosis!: string; // non-deterministic (default)

  @Column({ type: encryptedCaster({ keys: [keyA], deterministic: true }) })
  @Validates({ uniqueness: true })
  ssn!: string; // deterministic — queryable
}

let knex: Knex;

beforeAll(() => {
  knex = knexFactory({ client: 'sqlite3', connection: { filename: ':memory:' }, useNullAsDefault: true });
  connect(knex);
});

beforeEach(async () => {
  await knex.schema.dropTableIfExists('patients');
  await knex.schema.createTable('patients', (t) => {
    t.increments('id');
    t.string('name');
    t.text('diagnosis');
    t.text('ssn');
  });
});

afterAll(async () => {
  await knex.destroy();
});

describe('encryptedCaster', () => {
  it('round-trips a value and stores real ciphertext, not the plaintext, at rest', async () => {
    const patient = await Patient.create({ name: 'Alice', diagnosis: 'seasonal allergies', ssn: '111-11-1111' });

    const rawRow = await knex('patients').where('id', patient.id).first();
    expect(rawRow.diagnosis).not.toBe('seasonal allergies');
    expect(rawRow.diagnosis.length).toBeGreaterThan(0);

    const reloaded = await Patient.find(patient.id);
    expect(reloaded!.diagnosis).toBe('seasonal allergies');
  });

  it('non-deterministic: the same plaintext encrypts to different ciphertext each time', async () => {
    const a = await Patient.create({ name: 'A', diagnosis: 'flu', ssn: '111-11-1111' });
    const b = await Patient.create({ name: 'B', diagnosis: 'flu', ssn: '222-22-2222' });

    const rowA = await knex('patients').where('id', a.id).first();
    const rowB = await knex('patients').where('id', b.id).first();
    expect(rowA.diagnosis).not.toBe(rowB.diagnosis);
  });

  // A deterministic column with no uniqueness rule, distinct from Patient's
  // ssn — same/different-ciphertext behavior is orthogonal to uniqueness,
  // and duplicate ssns would fail Patient's own uniqueness validation.
  class Sample extends Model {
    static tableName = 'patients';
    @PrimaryKey() id!: number;
    @Column() name!: string;
    @Column({ type: encryptedCaster({ keys: [keyA], deterministic: true }) }) diagnosis!: string;
  }

  it('deterministic: the same plaintext encrypts to the same ciphertext', async () => {
    const a = await Sample.create({ name: 'A', diagnosis: 'flu' });
    const b = await Sample.create({ name: 'B', diagnosis: 'flu' });

    const rowA = await knex('patients').where('id', a.id).first();
    const rowB = await knex('patients').where('id', b.id).first();
    expect(rowA.diagnosis).toBe(rowB.diagnosis);
  });

  it('deterministic: different plaintexts encrypt to different ciphertext', async () => {
    const a = await Sample.create({ name: 'A', diagnosis: 'flu' });
    const b = await Sample.create({ name: 'B', diagnosis: 'cold' });

    const rowA = await knex('patients').where('id', a.id).first();
    const rowB = await knex('patients').where('id', b.id).first();
    expect(rowA.diagnosis).not.toBe(rowB.diagnosis);
  });

  it('deterministic columns are queryable via where() — Model.where() casts the condition value', async () => {
    await Patient.create({ name: 'Alice', diagnosis: 'flu', ssn: '111-11-1111' });
    await Patient.create({ name: 'Bob', diagnosis: 'cold', ssn: '222-22-2222' });

    const matches = await Patient.where({ ssn: '111-11-1111' });
    expect(matches.map((p) => p.name)).toEqual(['Alice']);
  });

  it('deterministic columns work with @Validates({ uniqueness }) out of the box', async () => {
    await Patient.create({ name: 'Alice', diagnosis: 'flu', ssn: '111-11-1111' });

    const dupe = new Patient({ name: 'Bob', diagnosis: 'cold', ssn: '111-11-1111' });
    expect(await dupe.save()).toBe(false);
    expect(dupe.errors.on('ssn')).toContain('has already been taken');
  });

  it('non-deterministic columns are NOT queryable — where() will not match the encrypted value', async () => {
    await Patient.create({ name: 'Alice', diagnosis: 'flu', ssn: '111-11-1111' });
    const matches = await Patient.where({ diagnosis: 'flu' });
    expect(matches).toEqual([]);
  });

  it('key rotation: an old key after the current one still decrypts existing rows', async () => {
    class LegacyPatient extends Model {
      static tableName = 'patients';
      @PrimaryKey() id!: number;
      @Column() name!: string;
      @Column({ type: encryptedCaster({ keys: [keyA] }) }) diagnosis!: string;
    }
    const written = await LegacyPatient.create({ name: 'Alice', diagnosis: 'flu' });

    // keyB is now the current (first) key for new writes; keyA stays listed
    // so rows written before the rotation still decrypt.
    class RotatedPatient extends Model {
      static tableName = 'patients';
      @PrimaryKey() id!: number;
      @Column() name!: string;
      @Column({ type: encryptedCaster({ keys: [keyB, keyA] }) }) diagnosis!: string;
    }
    expect((await RotatedPatient.find(written.id))!.diagnosis).toBe('flu');

    // a caster that no longer knows keyA at all can't decrypt that row —
    // rotation isn't automatic re-encryption, old keys just have to stay
    // listed until every row written under them has been rewritten.
    class KeyBOnlyPatient extends Model {
      static tableName = 'patients';
      @PrimaryKey() id!: number;
      @Column({ type: encryptedCaster({ keys: [keyB] }) }) diagnosis!: string;
    }
    await expect(KeyBOnlyPatient.find(written.id)).rejects.toThrow(/could not decrypt/i);
  });

  it('a key that matches nothing throws a clear error rather than returning garbage', async () => {
    const written = await Patient.create({ name: 'Alice', diagnosis: 'flu', ssn: '111-11-1111' });

    class WrongKeyPatient extends Model {
      static tableName = 'patients';
      @PrimaryKey() id!: number;
      @Column({ type: encryptedCaster({ keys: [keyB] }) }) diagnosis!: string;
    }
    await expect(WrongKeyPatient.find(written.id)).rejects.toThrow(/could not decrypt/i);
  });

  it('null values pass through untouched — no encryption/decryption attempted', async () => {
    const patient = await Patient.create({ name: 'Alice', diagnosis: null, ssn: null } as any);
    expect(patient.diagnosis).toBeNull();

    const rawRow = await knex('patients').where('id', patient.id).first();
    expect(rawRow.diagnosis).toBeNull();

    expect((await Patient.find(patient.id))!.diagnosis).toBeNull();
  });

  it('rejects a key that is not exactly 32 bytes, at caster-creation time', () => {
    expect(() => encryptedCaster({ keys: [randomBytes(16)] })).toThrow(/32 bytes/);
  });

  it('rejects an empty keys array', () => {
    expect(() => encryptedCaster({ keys: [] })).toThrow(/at least one key/);
  });
});
