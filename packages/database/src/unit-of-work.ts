import type { Sql, TransactionSql } from "postgres";

export async function inTransaction<T>(
  client: Sql,
  work: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return (await client.begin(work)) as T;
}
