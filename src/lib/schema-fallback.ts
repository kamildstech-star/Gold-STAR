/**
 * Is this error "the database has not caught up with the code yet"?
 *
 * Migrations are written here but applied by hand through Lovable, so there is
 * always a window where a column or a foreign key exists in the query and not
 * in the database. PostgREST answers that with an error on the WHOLE read, so
 * one unshipped column takes down the entire estimate rather than the one
 * field that depends on it. Every query that reaches for something newer than
 * the last applied migration should fall back rather than fail.
 *
 * 42703 is Postgres for an unknown column; PGRST200 is a relationship missing
 * from the schema cache; PGRST204/205 are the column/table equivalents.
 */
export function isMissingSchema(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  if (code === "42703" || code === "PGRST200" || code === "PGRST204" || code === "PGRST205") {
    return true;
  }
  const message = String((error as { message?: string } | null)?.message ?? "");
  return /does not exist|schema cache/i.test(message);
}
