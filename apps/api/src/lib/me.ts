import { z } from "@hono/zod-openapi";
import { RoleSchema } from "../auth/roles.ts";
import type { CurrentUser } from "../env.ts";
import { parsePushSettings, signPushIdentity } from "./buzzkit.ts";

export const MeSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    role: RoleSchema,
    createdAt: z.iso.datetime(),
    pushIdentity: z.string().nullable().openapi({
      description: "Pass to BuzzKit's identify as `identityHash` (the id is `id`); null while push isn't set up",
    }),
  })
  .openapi("Me");

export type Me = z.infer<typeof MeSchema>;

export async function toMe(user: CurrentUser, env: unknown): Promise<Me> {
  const push = parsePushSettings(env);
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    createdAt: user.createdAt.toISOString(),
    pushIdentity: push ? await signPushIdentity(user.id, push.identitySecret) : null,
  };
}
