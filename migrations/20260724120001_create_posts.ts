import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('posts', (t) => {
    t.increments('id');
    t.string('title').notNullable();
    t.string('slug');
    t.integer('pinned').notNullable().defaultTo(0);
    t.integer('userId').references('id').inTable('users');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('posts');
}
