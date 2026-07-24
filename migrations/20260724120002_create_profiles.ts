import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('profiles', (t) => {
    t.increments('id');
    t.integer('userId').references('id').inTable('users');
    t.string('bio');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('profiles');
}
