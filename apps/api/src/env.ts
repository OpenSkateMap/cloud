import type { DatabaseSession } from "@openskatemap/db";
import type { Auth } from "./auth/create-auth.ts";
import type { Role } from "./auth/roles.ts";
import type { PlaceLookup } from "./lib/nominatim.ts";

export interface CurrentUser {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly role: Role;
  readonly createdAt: Date;
}

export interface Variables {
  database: DatabaseSession;
  auth: Auth;
  user: CurrentUser;
  /** Null where nothing may call out to find a city (tests). */
  placeLookup: PlaceLookup | null;
}

export type AppEnv = { Bindings: Env; Variables: Variables };
