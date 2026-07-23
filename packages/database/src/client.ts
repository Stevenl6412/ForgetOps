import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.js";

export function createDatabase(connectionString: string) {
  const client = postgres(connectionString);
  const db = drizzle(client, { schema });
  return {
    client,
    db,
    close: () => client.end(),
  };
}

export type DatabaseConnection = ReturnType<typeof createDatabase>;
