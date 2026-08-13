import { z } from "zod";

/**
 * REST contract for registering a new org root into repos.conf
 * (`POST /api/repos/add`). The path is written verbatim into repos.conf (so
 * `~` stays portable); the server validates existence and de-duplicates by the
 * normalized absolute path.
 */

/** repos.conf color token: `#rgb` or `#rrggbb` (case-insensitive hex; matches the server's `is_color_token`). */
export const orgColorTokenSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);

export const addRepoRequestSchema = z.object({
  /** Directory path to register as an org root (absolute or `~`-prefixed; written verbatim). */
  path: z.string().min(1),
  /** Optional org heading color (`#rgb` / `#rrggbb`). */
  color: orgColorTokenSchema.optional(),
});
export type AddRepoRequest = z.infer<typeof addRepoRequestSchema>;

export const addRepoResponseSchema = z.object({
  /** The org name (final path segment of the added root). */
  org: z.string().min(1),
});
export type AddRepoResponse = z.infer<typeof addRepoResponseSchema>;

/**
 * How a would-be org path classifies (`GET /api/fs/validate`). The same
 * classification drives `POST /api/repos/add`, so the modal can preview inline
 * exactly why an add would succeed or fail. `ok` mirrors a successful add; the
 * failure values reuse the add endpoint's stable error `code`s (localized by the
 * UI via `addOrg.error.*`).
 */
export const addPathStatusSchema = z.enum([
  "ok",
  "path_unresolved",
  "not_a_directory",
  "no_dir_name",
  "duplicate",
]);
export type AddPathStatus = z.infer<typeof addPathStatusSchema>;

export const fsValidateResponseSchema = z.object({
  status: addPathStatusSchema,
  /** The org name (final path segment), present only when `status === "ok"`. */
  org: z.string().min(1).optional(),
});
export type FsValidateResponse = z.infer<typeof fsValidateResponseSchema>;

/** A registered org root (`GET /api/repos/list`): its name (root basename) and absolute path. */
export const orgRootSchema = z.object({
  org: z.string().min(1),
  path: z.string().min(1),
});
export type OrgRoot = z.infer<typeof orgRootSchema>;

export const reposListResponseSchema = z.object({
  orgs: z.array(orgRootSchema),
});
export type ReposListResponse = z.infer<typeof reposListResponseSchema>;

/** Whether a string is an accepted repos.conf color token (pure guard for the UI before submit). */
export function isOrgColorToken(value: string): boolean {
  return orgColorTokenSchema.safeParse(value).success;
}
