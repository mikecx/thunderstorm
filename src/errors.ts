/**
 * ActiveModel::Errors-alike: a multimap of attribute -> messages.
 */
export class Errors {
  private readonly messages = new Map<string, string[]>();

  add(attribute: string, message: string): void {
    const list = this.messages.get(attribute) ?? [];
    list.push(message);
    this.messages.set(attribute, list);
  }

  clear(): void {
    this.messages.clear();
  }

  get isEmpty(): boolean {
    return this.messages.size === 0;
  }

  /** Messages for a single attribute, e.g. errors.on('email') -> ["is invalid"]. */
  on(attribute: string): string[] {
    return this.messages.get(attribute) ?? [];
  }

  /** All "attribute message" strings, e.g. ["email is invalid", "name can't be blank"]. */
  get full(): string[] {
    const out: string[] = [];
    for (const [attribute, msgs] of this.messages) {
      for (const message of msgs) out.push(`${attribute} ${message}`);
    }
    return out;
  }
}

export class RecordInvalid extends Error {
  constructor(public readonly record: { errors: Errors }) {
    super(`Validation failed: ${record.errors.full.join(', ')}`);
    this.name = 'RecordInvalid';
  }
}

/** Thrown by saveOrFail() when a before* callback halts the save instead of validation failing. */
export class RecordNotSaved extends Error {
  constructor(public readonly record: unknown) {
    super('Save aborted by a callback');
    this.name = 'RecordNotSaved';
  }
}
