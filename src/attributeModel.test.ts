import { describe, it, expect } from 'vitest';
import { AttributeModel } from './AttributeModel';
import { Model } from './Model';
import { Column, Validates } from './decorators';

class SearchFilter extends AttributeModel {
  @Column()
  @Validates({ presence: true, length: { min: 2 } })
  query!: string;

  @Column({ default: 'relevance' })
  sortBy!: string;

  @Column({ virtual: true })
  page!: number;
}

describe('AttributeModel used standalone (no persistence)', () => {
  it('has no tableName requirement and needs no DB connection at all', () => {
    expect(() => new SearchFilter({ query: 'thunderstorm' })).not.toThrow();
  });

  it('runs validations and populates errors, same as Model', () => {
    const filter = new SearchFilter({ query: '' });
    expect(filter.isValid()).toBe(false);
    expect(filter.errors.on('query')).toContain("can't be blank");

    const valid = new SearchFilter({ query: 'thunderstorm' });
    expect(valid.isValid()).toBe(true);
  });

  it('applies attribute defaults', () => {
    const filter = new SearchFilter({ query: 'thunderstorm' });
    expect(filter.sortBy).toBe('relevance');
  });

  it('tracks dirty state — though there is no save() to ever reset the baseline', () => {
    const filter = new SearchFilter({ query: 'thunderstorm' });
    expect(filter.isChanged).toBe(true);
    expect(filter.isAttributeChanged('query')).toBe(true);
    expect(filter.previousChanges).toEqual({}); // never populated — nothing ever "saves"
  });

  it('serializes via toJSON()/serializableHash(), excluding virtual columns by default', () => {
    const filter = new SearchFilter({ query: 'thunderstorm', page: 2 });
    expect(JSON.parse(JSON.stringify(filter))).toEqual({ query: 'thunderstorm', sortBy: 'relevance' });
    expect(filter.serializableHash({ include: ['page'] })).toEqual({
      query: 'thunderstorm',
      sortBy: 'relevance',
      page: 2,
    });
  });

  it('has none of Model’s persistence surface — no save/destroy/isPersisted/dup/tableName/query', () => {
    const filter = new SearchFilter({ query: 'thunderstorm' });
    expect((filter as any).save).toBeUndefined();
    expect((filter as any).destroy).toBeUndefined();
    expect((filter as any).isPersisted).toBeUndefined();
    expect((filter as any).dup).toBeUndefined();
    expect((filter as any).reload).toBeUndefined();
    expect((SearchFilter as any).tableName).toBeUndefined();
    expect((SearchFilter as any).find).toBeUndefined();
    expect((SearchFilter as any).where).toBeUndefined();
    expect((SearchFilter as any).query).toBeUndefined();
  });
});

describe('Model extends AttributeModel', () => {
  it('a Model subclass instance is also an AttributeModel instance', () => {
    class Widget extends Model {
      static tableName = 'widgets';
      @Column() name!: string;
    }
    const widget = new Widget({ name: 'thing' });
    expect(widget).toBeInstanceOf(AttributeModel);
    expect(widget).toBeInstanceOf(Model);
  });
});
