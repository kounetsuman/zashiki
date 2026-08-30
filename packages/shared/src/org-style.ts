import { z } from "zod";

import { orgColorTokenSchema } from "./repos-add.js";

/**
 * REST contracts for changing an org's display style in repos.conf: its color (`POST /api/orgs/color`),
 * its alias (`POST /api/orgs/alias`), and the org display order (`POST /api/orgs/order`). The color/alias
 * rewrites the org's conf line, preserving the verbatim path and the untouched attribute; a blank value
 * resets that attribute (color → automatic hash color, alias → the org identity). The order reorders the
 * conf root lines. After the write the server reflects it live via state.sync.
 */

/** Max alias length (character count, matching the server's `ORG_ALIAS_MAX_CHARS`). */
export const ORG_ALIAS_MAX_CHARS = 64;

/**
 * A storable alias: no whitespace and no `#` (so it round-trips through repos.conf as a `@token`) and no
 * leading `@` (which would be written as `@@name`). Mirrors the server's `is_valid_alias_token`.
 */
export const orgAliasSchema = z
  .string()
  .min(1)
  .max(ORG_ALIAS_MAX_CHARS)
  .regex(/^[^\s#@][^\s#]*$/);

export const orgColorRequestSchema = z.object({
  /** The org (root basename) whose color is being set. */
  org: z.string().min(1),
  /** A `#rgb`/`#rrggbb` token, or "" to reset to the automatic color. */
  color: z.union([orgColorTokenSchema, z.literal("")]),
});
export type OrgColorRequest = z.infer<typeof orgColorRequestSchema>;

export const orgAliasRequestSchema = z.object({
  /** The org (root basename) whose alias is being set. */
  org: z.string().min(1),
  /** An alias token, or "" to reset to the org identity. */
  alias: z.union([orgAliasSchema, z.literal("")]),
});
export type OrgAliasRequest = z.infer<typeof orgAliasRequestSchema>;

export const orgOrderRequestSchema = z.object({
  /** The full org display order to persist (reorders repos.conf root lines; membership unchanged). */
  orgs: z.array(z.string().min(1)),
});
export type OrgOrderRequest = z.infer<typeof orgOrderRequestSchema>;
