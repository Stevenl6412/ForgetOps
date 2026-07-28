import type { Sql, TransactionSql } from "postgres";

export async function inTransaction<T>(
  client: Sql,
  work: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return (await client.begin(work)) as T;
}

export async function inTenantTransaction<T>(
  client: Sql,
  tenantId: string,
  work: (transaction: TransactionSql) => Promise<T>,
): Promise<T> {
  return inTransaction(client, async (transaction) => {
    await transaction.unsafe("set local role forgetops_app");
    await transaction`select set_config('app.tenant_id', ${tenantId}, true)`;
    return work(transaction);
  });
}
