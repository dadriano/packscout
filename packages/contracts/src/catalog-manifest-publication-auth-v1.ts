import { z } from "zod";
import { canonicalJson } from "./data-release-v2-canonical.ts";
import { productionAuthKeyIdSchema } from "./data-release-v2-publication-auth.ts";

export const MAX_CATALOG_MANIFEST_AUTH_KEY_IDS = 16;
export const CATALOG_MANIFEST_AUTH_ROLES = [
  "publish",
  "rollback",
  "clear",
] as const;

export const catalogManifestAuthRoleSchema = z.enum(
  CATALOG_MANIFEST_AUTH_ROLES,
);

const canonicalRolesSchema = z.array(catalogManifestAuthRoleSchema)
  .min(1)
  .max(CATALOG_MANIFEST_AUTH_ROLES.length)
  .refine(
    (roles) => roles.every(
      (role, index) => index === 0 || roles[index - 1]! < role,
    ),
    { message: "catalog_manifest_publication.auth_roles_not_canonical" },
  );

export const catalogManifestAuthKeyRolesSchema = z.record(
  productionAuthKeyIdSchema,
  canonicalRolesSchema,
).superRefine((rolesByKeyId, context) => {
  const keyIds = Object.keys(rolesByKeyId);
  if (
    keyIds.length === 0 ||
    keyIds.length > MAX_CATALOG_MANIFEST_AUTH_KEY_IDS ||
    !keyIds.every((keyId, index) =>
      index === 0 || keyIds[index - 1]! < keyId
    )
  ) {
    context.addIssue({
      code: "custom",
      message: "catalog_manifest_publication.auth_key_roles_not_canonical",
    });
  }
});

export type CatalogManifestAuthRole = z.infer<
  typeof catalogManifestAuthRoleSchema
>;
export type CatalogManifestAuthKeyRoles = z.infer<
  typeof catalogManifestAuthKeyRolesSchema
>;

export function parseCatalogManifestAuthKeyRolesJson(
  bodyJson: string,
): CatalogManifestAuthKeyRoles | null {
  try {
    const parsed = catalogManifestAuthKeyRolesSchema.parse(
      JSON.parse(bodyJson) as unknown,
    );
    return bodyJson === canonicalJson(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function catalogManifestKeyHasRole(
  rolesByKeyId: CatalogManifestAuthKeyRoles,
  keyId: string,
  role: CatalogManifestAuthRole,
): boolean {
  return rolesByKeyId[keyId]?.includes(role) ?? false;
}
