import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { tsImport } from "tsx/esm/api";

const planModule = await tsImport(
  "./provider-review-database-plan.mts",
  import.meta.url,
);
const registrationModule = await tsImport(
  "./provider-review-central-registration.mts",
  import.meta.url,
);
const contracts = await tsImport("@packscout/contracts", import.meta.url);
const services = await tsImport("@packscout/services", import.meta.url);

const {
  ADDITIONAL_PROVIDER_REVIEW_DATABASES,
} = planModule;
const {
  createProviderReviewRegistrationIds,
  readProviderReviewCentralBaseline,
  registerProviderReviewMetadataBatch,
} = registrationModule;
const { AesGcmProviderCredentialCipher } = services;

const migrationPath = fileURLToPath(new URL(
  "../../packages/database/prisma/central/migrations/20260829000000_distributed_central_baseline/migration.sql",
  import.meta.url,
));
const adminDatabaseUrl = process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL ??
  `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`;

const fixtureIds = Object.freeze({
  organization: "51000000-0000-5000-8000-000000000001",
  operator: "51000000-0000-5000-8000-000000000002",
  membership: "51000000-0000-5000-8000-000000000003",
  clutchpacksProvider: "51000000-0000-5000-8000-000000000004",
  clutchpacksProfile: "51000000-0000-5000-8000-000000000005",
  clutchpacksConfig: "51000000-0000-5000-8000-000000000006",
  clutchpacksSourceCredential: "51000000-0000-5000-8000-000000000007",
  clutchpacksDatabaseCredential: "51000000-0000-5000-8000-000000000008",
  clutchpacksNode: "51000000-0000-5000-8000-000000000009",
  clutchpacksTest: "51000000-0000-5000-8000-000000000010",
});
const credentialKey = Object.freeze({
  bytes: new Uint8Array(Buffer.alloc(32, 41)),
  version: 1,
});
const sourceToken = "integration-source-token-never-logged";

function descriptor(providerKey) {
  return ADDITIONAL_PROVIDER_REVIEW_DATABASES.find(
    (provider) => provider.providerKey === providerKey,
  );
}

function registrationIds(providerKey, offset) {
  return createProviderReviewRegistrationIds({
    centralSystemIdentifier: "7532189705087112001",
    providerSystemIdentifier: String(7_532_189_705_087_114_000n + BigInt(offset)),
    providerKey,
  });
}

function databaseProof(provider, offset) {
  return {
    clusterKey: provider.providerKey,
    databaseName: provider.databaseName,
    databaseRole: "provider",
    port: provider.port,
    schemaVersion: provider.schemaVersion,
    systemIdentifier: String(7_532_189_705_087_114_000n + BigInt(offset)),
  };
}

async function createMigratedCentralDatabase() {
  const adminUrl = new URL(adminDatabaseUrl);
  if (!/^postgresql?:$/u.test(adminUrl.protocol)) {
    throw new Error("PACKSCOUT_TEST_ADMIN_DATABASE_URL must be PostgreSQL");
  }
  const databaseName =
    `packscout_provider_registration_${process.pid}_${randomBytes(6).toString("hex")}`;
  if (!/^packscout_provider_registration_[0-9]+_[0-9a-f]{12}$/u.test(databaseName)) {
    throw new Error("refusing unscoped integration database");
  }
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  let created = false;
  try {
    await admin.query(`create database "${databaseName}"`);
    created = true;
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    const db = new Client({ connectionString: databaseUrl.toString() });
    await db.connect();
    await db.query(await readFile(migrationPath, "utf8"));
    return {
      db,
      databaseUrl: databaseUrl.toString(),
      stop: async () => {
        await db.end();
        if (created) {
          await admin.query(`drop database "${databaseName}"`);
          created = false;
        }
        await admin.end();
      },
    };
  } catch (error) {
    if (created) await admin.query(`drop database "${databaseName}"`);
    await admin.end();
    throw error;
  }
}

async function seedExactClutchpacksBaseline(db) {
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: credentialKey.version,
    keys: new Map([[credentialKey.version, credentialKey.bytes]]),
  });
  const sourceEncrypted = cipher.encrypt(sourceToken, {
    organizationId: fixtureIds.organization,
    providerId: fixtureIds.clutchpacksProvider,
    revisionId: fixtureIds.clutchpacksSourceCredential,
  });
  const databaseEncrypted = cipher.encrypt(JSON.stringify({
    username: "packscout_clutchpacks_app",
    password: "clutchpacks-integration-password",
  }), {
    organizationId: fixtureIds.organization,
    providerId: fixtureIds.clutchpacksProvider,
    revisionId: fixtureIds.clutchpacksDatabaseCredential,
  });
  await db.query("begin");
  try {
    await db.query(`insert into organizations (id, slug, name)
      values ($1::uuid, 'packscout-local-review', 'PackScout Review')`,
    [fixtureIds.organization]);
    await db.query(`insert into operators
      (id, email_normalized, display_name, password_hash)
      values ($1::uuid, 'admin@example.test', 'Admin', 'integration-hash')`,
    [fixtureIds.operator]);
    await db.query(`insert into operator_memberships
      (id, organization_id, operator_id, role)
      values ($1::uuid, $2::uuid, $3::uuid, 'admin')`, [
      fixtureIds.membership,
      fixtureIds.organization,
      fixtureIds.operator,
    ]);
    await db.query(`insert into providers
      (id, organization_id, provider_key, display_name)
      values ($1::uuid, $2::uuid, 'clutchpacks', 'ClutchPacks')`, [
      fixtureIds.clutchpacksProvider,
      fixtureIds.organization,
    ]);
    await db.query(`
      insert into provider_public_profile_versions (
        id, provider_id, version_number, display_name, listing_hosts,
        image_origins, referral_parameters, content_hash,
        created_by_operator_id
      ) values (
        $1::uuid, $2::uuid, 1, 'ClutchPacks', '{}'::text[], '{}'::text[],
        '[]'::jsonb, $3, $4::uuid
      )
    `, [
      fixtureIds.clutchpacksProfile,
      fixtureIds.clutchpacksProvider,
      "a".repeat(64),
      fixtureIds.operator,
    ]);
    for (const credential of [
      [fixtureIds.clutchpacksSourceCredential, "source", sourceEncrypted],
      [fixtureIds.clutchpacksDatabaseCredential, "database", databaseEncrypted],
    ]) {
      await db.query(`
        insert into provider_credential_versions (
          id, provider_id, credential_kind, version_number, ciphertext,
          nonce, auth_tag, key_version, lifecycle, activated_at
        ) values ($1::uuid, $2::uuid, $3::credential_kind, 1, $4, $5, $6,
          $7, 'active', now())
      `, [
        credential[0],
        fixtureIds.clutchpacksProvider,
        credential[1],
        Buffer.from(credential[2].ciphertext),
        Buffer.from(credential[2].nonce),
        Buffer.from(credential[2].authTag),
        credential[2].keyVersion,
      ]);
    }
    await db.query(`
      insert into provider_config_versions (
        id, provider_id, version_number, adapter_key, endpoint_url,
        source_credential_version_id, schedule_seconds, stale_after_seconds,
        configuration, expires_at, created_by_operator_id
      ) values (
        $1::uuid, $2::uuid, 1, $3, $4, $5::uuid, 3600, 86400,
        '{"platform":"clutchpacks"}'::jsonb, null, $6::uuid
      )
    `, [
      fixtureIds.clutchpacksConfig,
      fixtureIds.clutchpacksProvider,
      contracts.dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
      contracts.DATAFORREST_EVENTS_V1_ENDPOINT,
      fixtureIds.clutchpacksSourceCredential,
      fixtureIds.operator,
    ]);
    await db.query(`
      insert into provider_database_nodes (
        id, provider_id, node_key, node_role, host, port, database_name,
        ssl_mode, credential_version_id, region, enabled
      ) values (
        $1::uuid, $2::uuid, 'primary', 'primary', '127.0.0.1', 55432,
        'packscout_clutchpacks', 'disable', $3::uuid, 'local', true
      )
    `, [
      fixtureIds.clutchpacksNode,
      fixtureIds.clutchpacksProvider,
      fixtureIds.clutchpacksDatabaseCredential,
    ]);
    await db.query(`
      insert into provider_connection_tests (
        id, provider_id, config_version_id, source_credential_version_id,
        database_credential_version_id, topology_version, database_node_id,
        database_node_row_version, target_digest, test_kind, outcome,
        result_summary, tested_by_operator_id, tested_at
      )
      select $1::uuid, provider.id, $2::uuid, $3::uuid, $4::uuid,
        provider.topology_version, node.id, node.row_version,
        packscout_activation_target_digest_nullable_source(
          provider.id, $2::uuid, $3::uuid, $4::uuid,
          provider.topology_version, node.id, node.row_version),
        'activation', 'succeeded', '{}'::jsonb, $5::uuid, now()
      from providers provider
      join provider_database_nodes node on node.provider_id = provider.id
      where provider.id = $6::uuid and node.id = $7::uuid
    `, [
      fixtureIds.clutchpacksTest,
      fixtureIds.clutchpacksConfig,
      fixtureIds.clutchpacksSourceCredential,
      fixtureIds.clutchpacksDatabaseCredential,
      fixtureIds.operator,
      fixtureIds.clutchpacksProvider,
      fixtureIds.clutchpacksNode,
    ]);
    await db.query(`
      update providers set lifecycle = 'active',
        active_config_version_id = $1::uuid,
        row_version = row_version + 1,
        updated_at = updated_at + interval '1 microsecond'
      where id = $2::uuid
    `, [
      fixtureIds.clutchpacksConfig,
      fixtureIds.clutchpacksProvider,
    ]);
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

test("three-provider registration is atomic, resumable, AAD-bound, and keeps source-free providers admin-routable", {
  concurrency: false,
}, async (context) => {
  let harness;
  try {
    harness = await createMigratedCentralDatabase();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error &&
        ["ECONNREFUSED", "ENOENT"].includes(error.code)) {
      context.skip("local PostgreSQL integration target is unavailable");
      return;
    }
    throw error;
  }
  const { db, databaseUrl } = harness;
  try {
    await seedExactClutchpacksBaseline(db);
    const baseline = await readProviderReviewCentralBaseline({
      centralUrl: databaseUrl,
      organizationSlug: "packscout-local-review",
      adminEmail: "admin@example.test",
    });
    const providers = [
      [descriptor("courtyard"), registrationIds("courtyard", 1), 1],
      [descriptor("collector_crypt"), registrationIds("collector_crypt", 2), 2],
      [descriptor("phygitals"), registrationIds("phygitals", 3), 3],
    ];
    const registrations = providers.map(([provider, ids, offset]) => ({
      descriptor: provider,
      ids,
      databasePassword: `${provider.providerKey}-database-password`,
      databaseProof: databaseProof(provider, offset),
    }));
    const checkedTokens = [];
    const runSourceLiveCheck = async ({ providerKey, token }) => {
      assert.equal(providerKey, "courtyard");
      checkedTokens.push(token);
      return {
        durationMilliseconds: 12,
        recordCount: 1,
        responseBytes: 512,
        responseStatus: 200,
      };
    };
    const batchInput = {
      centralUrl: databaseUrl,
      registrations,
      baseline,
      credentialKey,
    };

    await assert.rejects(registerProviderReviewMetadataBatch({
      ...batchInput,
      dependencies: {
        runSourceLiveCheck,
        beforeCommit: async () => {
          const externallyVisible = await db.query(`
            select count(*)::int as count from providers
            where provider_key = any($1::text[])
          `, [providers.map(([provider]) => provider.providerKey)]);
          assert.equal(externallyVisible.rows[0].count, 0);
          throw new Error("injected-before-commit-failure");
        },
      },
    }), (error) => error?.code === "CENTRAL_REGISTRATION_FAILED");
    const rolledBack = await db.query(`
      select count(*)::int as count from providers
      where provider_key = any($1::text[])
    `, [providers.map(([provider]) => provider.providerKey)]);
    assert.equal(rolledBack.rows[0].count, 0);

    await registerProviderReviewMetadataBatch({
      ...batchInput,
      dependencies: { runSourceLiveCheck },
    });
    assert.deepEqual(checkedTokens, [sourceToken, sourceToken]);

    const dormantProviders = await db.query(`
      select provider.lifecycle, provider.active_config_version_id,
             provider.active_public_profile_version_id, provider.provider_key,
             config.source_credential_version_id,
             (select count(*)::int from provider_credential_versions credential
               where credential.provider_id = provider.id
                 and credential.credential_kind = 'source') as source_count,
             (select count(*)::int from provider_connection_tests counted
               where counted.provider_id = provider.id) as test_count
      from providers provider
      join provider_config_versions config
        on config.id = provider.active_config_version_id
      where provider.provider_key = any($1::text[])
      order by provider.provider_key
    `, [["collector_crypt", "phygitals"]]);
    const dormantExpected = new Map(providers.slice(1).map(
      ([provider, ids]) => [provider.providerKey, ids],
    ));
    assert.deepEqual(dormantProviders.rows, [
      "collector_crypt",
      "phygitals",
    ].map((providerKey) => ({
      lifecycle: "active",
      active_config_version_id:
        dormantExpected.get(providerKey).configVersionId,
      active_public_profile_version_id: null,
      provider_key: providerKey,
      source_credential_version_id: null,
      source_count: 0,
      test_count: 2,
    }),
    ));
    for (const [provider, ids] of providers.slice(1)) {
      const evidence = await db.query(`
        select test.id::text, test.test_kind, test.outcome,
               test.source_credential_version_id,
               test.latency_ms, test.response_status, test.sanitized_code,
               test.result_summary, test.record_counts, test.has_more,
               test.next_cursor_present,
               test.target_digest =
                 packscout_activation_target_digest_nullable_source(
                   provider.id, config.id, null, node.credential_version_id,
                   provider.topology_version, node.id, node.row_version
                 ) as target_matches
        from provider_connection_tests test
        join providers provider on provider.id = test.provider_id
        join provider_config_versions config
          on config.id = provider.active_config_version_id
        join provider_database_nodes node
          on node.id = test.database_node_id
        where provider.id = $1::uuid
        order by test.id
      `, [ids.providerId]);
      assert.equal(evidence.rows.length, 2);
      const byId = new Map(evidence.rows.map((row) => [row.id, row]));
      assert.deepEqual(byId.get(ids.activationTestId), {
        id: ids.activationTestId,
        test_kind: "database",
        outcome: "succeeded",
        source_credential_version_id: null,
        latency_ms: null,
        response_status: null,
        sanitized_code: null,
        result_summary: {
          checkKind: "provider_database_identity",
          databaseRole: "provider",
          schemaVersion: "distributed-provider-v1",
        },
        record_counts: null,
        has_more: null,
        next_cursor_present: null,
        target_matches: true,
      });
      assert.deepEqual(byId.get(ids.databaseOnlyActivationTestId), {
        id: ids.databaseOnlyActivationTestId,
        test_kind: "activation",
        outcome: "succeeded",
        source_credential_version_id: null,
        latency_ms: null,
        response_status: null,
        sanitized_code: null,
        result_summary: {
          activationScope: "database_reachability_only",
          checkKind: "database_only_provider_activation",
          databaseRole: "provider",
          executionCapability: provider.executionCapability,
          schemaVersion: "distributed-provider-v1",
          sourceCheckPerformed: false,
          sourceCredentialPresent: false,
        },
        record_counts: null,
        has_more: null,
        next_cursor_present: null,
        target_matches: true,
      });
    }

    const courtyardIds = providers[0][1];
    const active = await db.query(`
      select provider.lifecycle, provider.active_config_version_id,
             test.test_kind, test.response_status,
             credential.ciphertext, credential.nonce, credential.auth_tag,
             credential.key_version
      from providers provider
      join provider_connection_tests test on test.provider_id = provider.id
      join provider_credential_versions credential
        on credential.id = test.source_credential_version_id
      where provider.id = $1::uuid
    `, [courtyardIds.providerId]);
    assert.equal(active.rows[0].lifecycle, "active");
    assert.equal(
      active.rows[0].active_config_version_id,
      courtyardIds.configVersionId,
    );
    assert.equal(active.rows[0].test_kind, "activation");
    assert.equal(active.rows[0].response_status, 200);
    const cipher = new AesGcmProviderCredentialCipher({
      primaryVersion: credentialKey.version,
      keys: new Map([[credentialKey.version, credentialKey.bytes]]),
    });
    const encrypted = {
      ciphertext: new Uint8Array(active.rows[0].ciphertext),
      nonce: new Uint8Array(active.rows[0].nonce),
      authTag: new Uint8Array(active.rows[0].auth_tag),
      keyVersion: active.rows[0].key_version,
    };
    assert.equal(cipher.decrypt(encrypted, {
      organizationId: fixtureIds.organization,
      providerId: courtyardIds.providerId,
      revisionId: courtyardIds.sourceCredentialVersionId,
    }), sourceToken);
    assert.throws(() => cipher.decrypt(encrypted, {
      organizationId: fixtureIds.organization,
      providerId: fixtureIds.clutchpacksProvider,
      revisionId: fixtureIds.clutchpacksSourceCredential,
    }));
    await registerProviderReviewMetadataBatch({
      ...batchInput,
      dependencies: {
        runSourceLiveCheck: async () => {
          throw new Error("an exact resume must not repeat the source request");
        },
      },
    });
    const resumed = await db.query(`
      select provider_key,
             (select count(*)::int from provider_connection_tests test
              where test.provider_id = provider.id) as test_count,
             (select count(*)::int from audit_events audit
              where audit.subject_id = provider.id) as audit_count
      from providers provider
      where provider.provider_key = any($1::text[])
      order by provider.provider_key
    `, [providers.map(([provider]) => provider.providerKey)]);
    assert.equal(resumed.rows.length, 3);
    assert.deepEqual(resumed.rows.map((row) => ({
      providerKey: row.provider_key,
      testCount: row.test_count,
      auditCount: row.audit_count,
    })), [
      { providerKey: "collector_crypt", testCount: 2, auditCount: 1 },
      { providerKey: "courtyard", testCount: 1, auditCount: 1 },
      { providerKey: "phygitals", testCount: 2, auditCount: 1 },
    ]);
  } finally {
    await harness.stop();
  }
});
