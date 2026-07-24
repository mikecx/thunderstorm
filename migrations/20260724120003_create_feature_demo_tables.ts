import type { Knex } from 'knex';

// Tables backing the casting/accessors/delegate/scopes/timestamps/enum/transactions
// sections of src/example/demo.ts — kept separate from users/posts/profiles so
// those core tables stay focused on the CRUD/validations/callbacks/associations demo.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('orders', (t) => {
    t.increments('id');
    t.string('code');
    t.integer('paid');
    t.text('placedAt');
    t.text('metadata');
  });

  await knex.schema.createTable('writers', (t) => {
    t.increments('id');
    t.string('name');
  });

  await knex.schema.createTable('articles', (t) => {
    t.increments('id');
    t.integer('writerId');
  });

  await knex.schema.createTable('tickets', (t) => {
    t.increments('id');
    t.string('subject');
    t.integer('status').notNullable().defaultTo(0);
  });

  await knex.schema.createTable('accounts', (t) => {
    t.increments('id');
    t.string('name');
    t.integer('balance');
  });

  await knex.schema.createTable('timestamped_posts', (t) => {
    t.increments('id');
    t.string('title');
    t.text('createdAt');
    t.text('updatedAt');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('timestamped_posts');
  await knex.schema.dropTableIfExists('accounts');
  await knex.schema.dropTableIfExists('tickets');
  await knex.schema.dropTableIfExists('articles');
  await knex.schema.dropTableIfExists('writers');
  await knex.schema.dropTableIfExists('orders');
}
