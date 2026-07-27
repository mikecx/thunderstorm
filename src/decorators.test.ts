import { describe, it, expect } from 'vitest';
import { Column, PrimaryKey, Validates, COLUMNS, VALIDATIONS } from './decorators';

describe('Column / PrimaryKey', () => {
  it('records each decorated field on the constructor', () => {
    class Widget {
      @PrimaryKey()
      id!: number;

      @Column()
      name!: string;
    }

    const columns: Map<string, any> = (Widget as any)[Symbol.metadata][COLUMNS];
    expect(columns.get('id')).toEqual({ primary: true });
    expect(columns.get('name')).toEqual({});
  });

  it('does not leak column metadata between unrelated classes', () => {
    class A {
      @Column()
      foo!: string;
    }
    class B {
      @Column()
      bar!: string;
    }

    expect((A as any)[Symbol.metadata][COLUMNS].has('bar')).toBe(false);
    expect((B as any)[Symbol.metadata][COLUMNS].has('foo')).toBe(false);
  });

  it('gives a subclass its own column map rather than inheriting the parent instance', () => {
    class Base {
      @Column()
      id!: number;
    }
    class Sub extends Base {
      @Column()
      extra!: string;
    }

    expect((Sub as any)[Symbol.metadata][COLUMNS]).not.toBe((Base as any)[Symbol.metadata][COLUMNS]);
    expect((Sub as any)[Symbol.metadata][COLUMNS].has('extra')).toBe(true);
    expect((Base as any)[Symbol.metadata][COLUMNS].has('extra')).toBe(false);
  });
});

describe('Validates', () => {
  it('accumulates multiple rules applied to the same field', () => {
    class Widget {
      @Validates({ presence: true })
      @Validates({ length: { min: 3 } })
      name!: string;
    }

    const rules: Map<string, any[]> = (Widget as any)[Symbol.metadata][VALIDATIONS];
    expect(rules.get('name')).toHaveLength(2);
  });
});
