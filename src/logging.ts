import type { Knex } from 'knex';

export interface QueryLogInfo {
  sql: string;
  bindings: readonly unknown[];
  ms: number;
}

function defaultFormatter(info: QueryLogInfo): void {
  const bindings = info.bindings.length > 0 ? ` ${JSON.stringify(info.bindings)}` : '';
  console.log(`(${info.ms.toFixed(1)}ms) ${info.sql}${bindings}`);
}

interface KnexQueryEvent {
  __knexQueryUid: string;
  sql: string;
  bindings?: readonly unknown[];
}

/**
 * Logs every query run through `knex`, with real per-query timing — the
 * closest thing here to Rails' dev-log `Model Load (2.1ms)  SELECT ...`
 * lines, which thunderstorm otherwise has no equivalent of.
 *
 * The one non-obvious part this centralizes: Knex's `query` event fires
 * before a query runs, `query-response`/`query-error` after — neither
 * carries a duration of its own. This correlates the two via Knex's
 * internal `__knexQueryUid` (undocumented, underscore-prefixed, not really
 * public API) to compute actual elapsed time, rather than leaving every
 * caller to reimplement that correlation themselves.
 *
 * Deliberately does *not* decide formatting or *whether* to call this at
 * all (dev-only, say) — those are app policy, not something this needs to
 * centralize. `formatter` defaults to a plain one-liner; pass your own for
 * colorized/Rails-styled output, routing to a real logger, etc.
 */
export function logQueries(knex: Knex, formatter: (info: QueryLogInfo) => void = defaultFormatter): void {
  const startedAt = new Map<string, number>();

  knex.on('query', (query: KnexQueryEvent) => {
    startedAt.set(query.__knexQueryUid, performance.now());
  });

  const log = (query: KnexQueryEvent): void => {
    const start = startedAt.get(query.__knexQueryUid);
    startedAt.delete(query.__knexQueryUid);
    const ms = start === undefined ? 0 : performance.now() - start;
    formatter({ sql: query.sql, bindings: query.bindings ?? [], ms });
  };

  knex.on('query-response', (_response: unknown, query: KnexQueryEvent) => log(query));
  knex.on('query-error', (_error: unknown, query: KnexQueryEvent) => log(query));
}
