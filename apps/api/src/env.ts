import type { DatabaseSession } from "@openskatemap/db";
import type { Auth } from "./auth/create-auth.ts";
import type { Role } from "./auth/roles.ts";

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
}

export type AppEnv = { Bindings: Env; Variables: Variables };
