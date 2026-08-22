import assert from "node:assert/strict";
import { test } from "node:test";
import { providerIdentityNamespaceByLaunchProvider } from "@packscout/contracts";
import type { Prisma } from "@prisma/client";
import {
  createAcceptanceProviderSource,
  createProviderSourceAcceptanceFixture,
} from "./provider-source-acceptance-test-support.ts";

const sourceDefinition = {
  platformKey: "courtyard",
  displayName: "Courtyard",
  mapperKey: "courtyard-provider-observation",
  identityNamespaceKey: providerIdentityNamespaceByLaunchProvider.courtyard,
  intervalSeconds: 60,
  hashCharacter: "b",
} as const;

test("connection referents and source revisions cannot be rewritten", async () => {
  const fixture = await createProviderSourceAcceptanceFixture(
    "referent-immutability",
  );
  try {
    const source = await createAcceptanceProviderSource(
      fixture,
      sourceDefinition,
    );

    for (const data of [
      { source_adapter_version: "different-adapter-v2" },
      { configuration_ciphertext: new Uint8Array(32).fill(9) },
      { configuration_fingerprint: "9".repeat(64) },
    ] satisfies Prisma.source_connection_revisionsUncheckedUpdateInput[]) {
      await assert.rejects(
        fixture.database.source_connection_revisions.update({
          where: { id: fixture.connectionRevisionId },
          data,
        }),
        /source connection revision referents are immutable/u,
      );
    }

    const activatedAt = new Date("2026-08-20T12:00:01.000Z");
    const active = await fixture.database.source_connection_revisions.update({
      where: { id: fixture.connectionRevisionId },
      data: {
        state: "active",
        health_generation: { increment: 1 },
        activated_at: activatedAt,
      },
    });
    assert.equal(active.state, "active");
    assert.equal(active.health_generation, 1n);
    assert.deepEqual(active.activated_at, activatedAt);

    const revokedAt = new Date("2026-08-20T12:00:02.000Z");
    const revoked = await fixture.database.source_connection_revisions.update({
      where: { id: fixture.connectionRevisionId },
      data: {
        state: "revoked",
        revoked_at: revokedAt,
        revoked_by_actor_key: "operator-admin",
      },
    });
    assert.equal(revoked.state, "revoked");
    assert.deepEqual(revoked.revoked_at, revokedAt);

    for (const data of [
      { mapper_version: "2" },
      { configuration_json: { provider: "courtyard", rewritten: true } },
      { record_id_scopes_json: ["catalog-pack-v1"] },
    ] satisfies Prisma.provider_source_revisionsUncheckedUpdateInput[]) {
      await assert.rejects(
        fixture.database.provider_source_revisions.update({
          where: { id: source.sourceRevisionId },
          data,
        }),
        /provider source revisions are insert-only/u,
      );
    }

    const connectionGuard = await fixture.database.$queryRaw<
      Array<{ definition: string }>
    >`
      select pg_get_functiondef(oid) as definition
      from pg_proc
      where proname = 'enforce_source_connection_revision_referent_immutability'
    `;
    for (const field of [
      "id",
      "organization_id",
      "connection_profile_id",
      "revision_number",
      "source_type_key",
      "source_adapter_version",
      "configuration_ciphertext",
      "configuration_nonce",
      "configuration_auth_tag",
      "encryption_key_version",
      "configuration_fingerprint",
      "created_by_actor_key",
      "created_at",
    ]) {
      assert.match(
        connectionGuard[0]?.definition ?? "",
        new RegExp(`"${field}"`, "u"),
      );
    }
  } finally {
    await fixture.close();
  }
});
