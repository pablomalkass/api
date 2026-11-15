export interface KnexStyleQuery {
  sql: string;
  bindings: unknown[];
}

/**
 * Repositories write native PostgreSQL placeholders ($1, $2, ...), which can repeat ($1 used twice).
 * MikroORM's `execute()` runs through Knex, which only understands positional `?` markers.
 * This converts one into the other: every `$n` becomes `?` and the bindings are expanded in order of appearance.
 *
 * Safety: a literal `?` outside a string would be silently taken as a binding by Knex, so it is rejected here.
 * Single-quoted string literals are copied verbatim.
 */
export function toKnexStyleQuery(sql: string, params: readonly unknown[] = []): KnexStyleQuery {
  const bindings: unknown[] = [];
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i] as string;

    if (ch === "'") {
      // copy a string literal ('' is an escaped quote)
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'") {
          if (sql[j + 1] === "'") {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      if (j >= sql.length) throw new Error('unterminated string literal in SQL');
      out += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }

    if (ch === '?') throw new Error('a literal "?" is not allowed in repository SQL (it would be read as a binding)');

    if (ch === '$' && /[0-9]/.test(sql[i + 1] ?? '')) {
      let j = i + 1;
      while (j < sql.length && /[0-9]/.test(sql[j] as string)) j++;
      const index = Number(sql.slice(i + 1, j));
      if (index < 1 || index > params.length) {
        throw new Error(`placeholder $${index} has no matching parameter (got ${params.length})`);
      }
      bindings.push(params[index - 1]);
      out += '?';
      i = j;
      continue;
    }

    out += ch;
    i++;
  }
  return { sql: out, bindings };
}
