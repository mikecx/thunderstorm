import { describe, it, expect } from 'vitest';
import { Errors, RecordInvalid, StaleObjectError } from './errors';

describe('Errors', () => {
  it('starts empty', () => {
    const errors = new Errors();
    expect(errors.isEmpty).toBe(true);
    expect(errors.full).toEqual([]);
  });

  it('groups multiple messages per attribute', () => {
    const errors = new Errors();
    errors.add('email', "can't be blank");
    errors.add('email', 'is invalid');
    errors.add('name', "can't be blank");

    expect(errors.isEmpty).toBe(false);
    expect(errors.on('email')).toEqual(["can't be blank", 'is invalid']);
    expect(errors.on('name')).toEqual(["can't be blank"]);
    expect(errors.on('missing')).toEqual([]);
  });

  it('formats full messages as "attribute message"', () => {
    const errors = new Errors();
    errors.add('email', 'is invalid');
    expect(errors.full).toEqual(['email is invalid']);
  });

  it('clear() empties the collection', () => {
    const errors = new Errors();
    errors.add('name', "can't be blank");
    errors.clear();
    expect(errors.isEmpty).toBe(true);
  });
});

describe('RecordInvalid', () => {
  it('summarizes the record errors in its message', () => {
    const errors = new Errors();
    errors.add('name', "can't be blank");
    const err = new RecordInvalid({ errors });
    expect(err.name).toBe('RecordInvalid');
    expect(err.message).toContain("name can't be blank");
    expect(err.record.errors).toBe(errors);
  });
});

describe('StaleObjectError', () => {
  it('carries the record it was thrown for', () => {
    const record = { id: 1 };
    const err = new StaleObjectError(record);
    expect(err.name).toBe('StaleObjectError');
    expect(err.record).toBe(record);
  });
});
