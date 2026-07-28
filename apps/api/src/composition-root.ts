import {
  PostgresHierarchyStore,
  type DatabaseConnection,
  // Pairing is still exposed from the API module until the agent-management
  // application port is extracted in the next boundary pass.
} from "@forgetops/database";
import type { AuthContextProvider } from "./auth-context.js";
import { buildApp } from "./app.js";
import {
  PairingService,
  PostgresPairingRepository,
} from "./modules/agents/pairing-service.js";

export interface ApiCompositionRootOptions {
  database: DatabaseConnection;
  authProvider: AuthContextProvider;
}

export function createApiCompositionRoot(options: ApiCompositionRootOptions) {
  return buildApp({
    authProvider: options.authProvider,
    store: new PostgresHierarchyStore(options.database.client),
    pairingService: new PairingService(
      new PostgresPairingRepository(options.database.client),
    ),
  });
}
