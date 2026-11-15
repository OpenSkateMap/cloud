import { z } from "@hono/zod-openapi";
import { createAccessControl } from "better-auth/plugins/access";
import { adminAc, defaultStatements, userAc } from "better-auth/plugins/admin/access";

export const ROLES = ["user", "editor", "admin"] as const;
export const RoleSchema = z.enum(ROLES).openapi("Role");
export type Role = z.infer<typeof RoleSchema>;

const ac = createAccessControl({ ...defaultStatements, submission: ["review"] });

export const accessControl = {
  ac,
  roles: {
    user: ac.newRole({ ...userAc.statements }),
    editor: ac.newRole({ ...userAc.statements, submission: ["review"] }),
    admin: ac.newRole({ ...adminAc.statements, submission: ["review"] }),
  },
} satisfies { ac: typeof ac; roles: Record<Role, unknown> };
