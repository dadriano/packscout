import { createHash } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import {
  DATAFORREST_EVENTS_V1_ENDPOINT,
  dataforrestClutchpacksDistributedSourceAdapterManifest,
  dataforrestLaunchDistributedSourceAdapterManifest,
} from "@packscout/contracts";
import { AesGcmProviderCredentialCipher } from
  "../../packages/services/src/provider-credential-cipher.ts";
import {
  ADDITIONAL_PROVIDER_REVIEW_DATABASES,
  ProviderReviewProvisionError,
  type AdditionalProviderKey,
  type ProviderReviewProvisionEnvironment,
  type ReviewProviderDescriptor,
} from "./provider-review-database-plan.mts";
import {
  runBoundedProviderReviewSourceLiveCheck,
  type ProviderReviewSourceLiveCheckResult,
} from "./provider-review-source-live-check.mts";

export interface ProviderReviewCentralBaseline {
  readonly organizationId: string;
  readonly operatorId: string;
  readonly clutchpacksProviderId: string;
  readonly clutchpacksDatabaseNodeId: string;
  readonly clutchpacksDatabaseCredentialVersionId: string;
}

export interface ProviderReviewRegistrationIds {
  readonly providerId: string;
  readonly publicProfileVersionId: string;
  readonly configVersionId: string;
  readonly databaseCredentialVersionId: string;
  readonly sourceCredentialVersionId: string;
  readonly databaseNodeId: string;
  readonly activationTestId: string;
  readonly databaseOnlyActivationTestId: string;
  readonly auditEventId: string;
}

interface EncryptedCredential {
  readonly ciphertext: Uint8Array;
  readonly nonce: Uint8Array;
  readonly authTag: Uint8Array;
  readonly keyVersion: number;
}

export interface ProviderReviewDatabaseIdentityProof {
  readonly clusterKey: string;
  readonly databaseName: string;
  readonly databaseRole: "central" | "provider";
  readonly port: number;
  readonly schemaVersion: string;
  readonly systemIdentifier: string;
}

export interface ProviderReviewRegistration {
  readonly descriptor: Readonly<ReviewProviderDescriptor>;
  readonly ids: Readonly<ProviderReviewRegistrationIds>;
  readonly databasePassword: string;
  readonly databaseProof: Readonly<ProviderReviewDatabaseIdentityProof>;
}

export interface ProviderReviewRegistrationDependencies {
  readonly runSourceLiveCheck?: typeof runBoundedProviderReviewSourceLiveCheck;
  readonly beforeCommit?: () => Promise<void>;
}

const REGISTRATION_ACTOR = "system:local-provider-review-provisioner";
const REGISTRATION_ACTION = "provider.local_provision";

function refuse(code: string): never {
  throw new ProviderReviewProvisionError(code);
}

function deterministicProvisionUuid(seed: string, label: string): string {
  const bytes = createHash("sha256")
    .update("packscout-additional-provider-review-provisioning-v1\0", "utf8")
    .update(seed, "utf8")
    .update("\0", "utf8")
    .update(label, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hexadecimal = bytes.toString("hex");
  return [
    hexadecimal.slice(0, 8),
    hexadecimal.slice(8, 12),
    hexadecimal.slice(12, 16),
    hexadecimal.slice(16, 20),
    hexadecimal.slice(20),
  ].join("-");
}

export function createProviderReviewRegistrationIds(input: {
  readonly centralSystemIdentifier: string;
  readonly providerSystemIdentifier: string;
  readonly providerKey: AdditionalProviderKey;
}): Readonly<ProviderReviewRegistrationIds> {
  const seed = [
    input.centralSystemIdentifier,
    input.providerSystemIdentifier,
    input.providerKey,
  ].join(":");
  const id = (label: string): string => deterministicProvisionUuid(seed, label);
  return Object.freeze({
    providerId: id("provider"),
    publicProfileVersionId: id("public-profile"),
    configVersionId: id("provider-config"),
    databaseCredentialVersionId: id("database-credential"),
    sourceCredentialVersionId: id("source-credential"),
    databaseNodeId: id("database-node"),
    activationTestId: id("activation-test"),
    databaseOnlyActivationTestId: id("database-only-activation-test"),
    auditEventId: id("audit-event"),
  });
}

export function classifyProviderReviewRegistration(input: {
  readonly counts: readonly number[];
  readonly sourceCredentialExpected: boolean;
  readonly databaseOnlyActivationExpected: boolean;
}): "absent" | "present" {
  if (input.counts.length !== 9 || input.counts.some((count) =>
    !Number.isSafeInteger(count) || count < 0
  )) {
    refuse("CENTRAL_REGISTRATION_STATE_UNEXPECTED");
  }
  if (input.counts.every((count) => count === 0)) return "absent";
  const expected = [1, 1, 1, 1, input.sourceCredentialExpected ? 1 : 0,
    1, 1, input.databaseOnlyActivationExpected ? 1 : 0, 1];
  if (input.counts.every((count, index) => count === expected[index])) {
    return "present";
  }
  refuse("CENTRAL_REGISTRATION_STATE_UNEXPECTED");
}

export async function readProviderReviewCentralBaseline(input: {
  readonly centralUrl: string;
  readonly organizationSlug: string;
  readonly adminEmail: string;
}): Promise<Readonly<ProviderReviewCentralBaseline>> {
  const pool = new Pool({ connectionString: input.centralUrl, max: 1 });
  try {
    const identity = await pool.query<{
      database_role: string;
      schema_version: string;
    }>(`
      select database_role, schema_version from database_identity
      where singleton_key = true
    `);
    const admin = await pool.query<{
      organization_id: string;
      operator_id: string;
    }>(`
      select organization.id::text as organization_id,
             operator.id::text as operator_id
      from organizations organization
      join operator_memberships membership
        on membership.organization_id = organization.id and membership.role = 'admin'
      join operators operator
        on operator.id = membership.operator_id and operator.state = 'active'
      where organization.slug = $1 and operator.email_normalized = $2
    `, [input.organizationSlug, input.adminEmail]);
    const baseline = admin.rows[0];
    if (identity.rows.length !== 1 ||
        identity.rows[0]?.database_role !== "central" ||
        identity.rows[0].schema_version !== "distributed-central-v1" ||
        admin.rows.length !== 1 || baseline === undefined) {
      refuse("CENTRAL_BASELINE_STATE_UNEXPECTED");
    }
    const clutchpacks = await pool.query<{
      provider_id: string;
      database_node_id: string;
      database_credential_version_id: string;
    }>(`
      select provider.id::text as provider_id,
             node.id::text as database_node_id,
             credential.id::text as database_credential_version_id
      from providers provider
      join provider_database_nodes node
        on node.provider_id = provider.id and node.node_key = 'primary'
      join provider_credential_versions credential
        on credential.id = node.credential_version_id
       and credential.provider_id = provider.id
      where provider.organization_id = $1::uuid
        and provider.provider_key = 'clutchpacks'
        and provider.lifecycle = 'active'
        and provider.active_config_version_id is not null
        and node.node_role = 'primary' and node.host = '127.0.0.1'
        and node.port = 55432 and node.database_name = 'packscout_clutchpacks'
        and node.ssl_mode = 'disable' and node.enabled = true
        and credential.credential_kind = 'database'
        and credential.lifecycle = 'active'
        and credential.activated_at is not null
        and credential.retired_at is null and credential.revoked_at is null
    `, [baseline.organization_id]);
    if (clutchpacks.rows.length !== 1 || clutchpacks.rows[0] === undefined) {
      refuse("CLUTCHPACKS_BASELINE_STATE_UNEXPECTED");
    }
    return Object.freeze({
      organizationId: baseline.organization_id,
      operatorId: baseline.operator_id,
      clutchpacksProviderId: clutchpacks.rows[0].provider_id,
      clutchpacksDatabaseNodeId: clutchpacks.rows[0].database_node_id,
      clutchpacksDatabaseCredentialVersionId:
        clutchpacks.rows[0].database_credential_version_id,
    });
  } catch (error) {
    if (error instanceof ProviderReviewProvisionError) throw error;
    refuse("CENTRAL_BASELINE_STATE_UNEXPECTED");
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function registrationPresence(
  client: PoolClient,
  descriptor: Readonly<ReviewProviderDescriptor>,
  ids: Readonly<ProviderReviewRegistrationIds>,
): Promise<"absent" | "present"> {
  const result = await client.query<Record<string, string>>(`
    select
      (select count(*)::text from providers
        where id = $1::uuid or provider_key = $2) as provider_count,
      (select count(*)::text from provider_public_profile_versions
        where id = $3::uuid) as profile_count,
      (select count(*)::text from provider_config_versions
        where id = $4::uuid) as config_count,
      (select count(*)::text from provider_credential_versions
        where id = $5::uuid) as database_credential_count,
      (select count(*)::text from provider_credential_versions
        where id = $6::uuid) as source_credential_count,
      (select count(*)::text from provider_database_nodes
        where id = $7::uuid) as node_count,
      (select count(*)::text from provider_connection_tests
        where id = $8::uuid) as test_count,
      (select count(*)::text from provider_connection_tests
        where id = $9::uuid) as database_only_activation_test_count,
      (select count(*)::text from audit_events
        where id = $10::uuid) as audit_count
  `, [
    ids.providerId,
    descriptor.providerKey,
    ids.publicProfileVersionId,
    ids.configVersionId,
    ids.databaseCredentialVersionId,
    ids.sourceCredentialVersionId,
    ids.databaseNodeId,
    ids.activationTestId,
    ids.databaseOnlyActivationTestId,
    ids.auditEventId,
  ]);
  const row = result.rows[0];
  if (row === undefined) refuse("CENTRAL_REGISTRATION_STATE_UNEXPECTED");
  return classifyProviderReviewRegistration({
    counts: [
      row.provider_count,
      row.profile_count,
      row.config_count,
      row.database_credential_count,
      row.source_credential_count,
      row.node_count,
      row.test_count,
      row.database_only_activation_test_count,
      row.audit_count,
    ].map((value) => Number(value)),
    sourceCredentialExpected:
      descriptor.cloneExistingSourceCredentialFromProviderKey !== null,
    databaseOnlyActivationExpected:
      descriptor.connectionTestKind === "database",
  });
}

function credentialScope(
  baseline: Readonly<ProviderReviewCentralBaseline>,
  providerId: string,
  revisionId: string,
) {
  return Object.freeze({
    organizationId: baseline.organizationId,
    providerId,
    revisionId,
  });
}

function decryptMatches(input: {
  readonly cipher: AesGcmProviderCredentialCipher;
  readonly encrypted: EncryptedCredential | null;
  readonly expected: string | null;
  readonly scope: ReturnType<typeof credentialScope>;
}): boolean {
  if (input.expected === null) return input.encrypted === null;
  if (input.encrypted === null) return false;
  try {
    return input.cipher.decrypt(input.encrypted, input.scope) === input.expected;
  } catch {
    return false;
  }
}

function decryptsAsBoundedSourceCredential(input: {
  readonly cipher: AesGcmProviderCredentialCipher;
  readonly encrypted: EncryptedCredential | null;
  readonly scope: ReturnType<typeof credentialScope>;
}): boolean {
  if (input.encrypted === null) return false;
  let plaintext = "";
  try {
    plaintext = input.cipher.decrypt(input.encrypted, input.scope);
    return plaintext.length >= 16 && plaintext.length <= 4_096 &&
      plaintext.trim() === plaintext && !/[\r\n\0]/u.test(plaintext);
  } catch {
    return false;
  } finally {
    plaintext = "";
  }
}

function assertDatabaseIdentityProof(input: {
  readonly descriptor: Readonly<ReviewProviderDescriptor>;
  readonly proof: Readonly<ProviderReviewDatabaseIdentityProof>;
}): void {
  if (
    input.proof.clusterKey !== input.descriptor.providerKey ||
    input.proof.databaseName !== input.descriptor.databaseName ||
    input.proof.databaseRole !== "provider" ||
    input.proof.port !== input.descriptor.port ||
    input.proof.schemaVersion !== input.descriptor.schemaVersion ||
    !/^[1-9][0-9]*$/u.test(input.proof.systemIdentifier)
  ) {
    refuse("PROVIDER_DATABASE_IDENTITY_PROOF_INVALID");
  }
}

function databaseConnectionSummary(input: {
  readonly proof: Readonly<ProviderReviewDatabaseIdentityProof>;
}) {
  return Object.freeze({
    checkKind: "provider_database_identity",
    databaseRole: input.proof.databaseRole,
    schemaVersion: input.proof.schemaVersion,
  });
}

function sourceActivationSummary(input: {
  readonly descriptor: Readonly<ReviewProviderDescriptor>;
  readonly proof: Readonly<ProviderReviewDatabaseIdentityProof>;
}) {
  return Object.freeze({
    adapterVersion:
      dataforrestLaunchDistributedSourceAdapterManifest.adapterVersion,
    checkKind: "bounded_source_and_database_contract",
    platform: input.descriptor.providerKey,
    databaseRole: input.proof.databaseRole,
    schemaVersion: input.proof.schemaVersion,
  });
}

function databaseOnlyActivationSummary(input: {
  readonly descriptor: Readonly<ReviewProviderDescriptor>;
  readonly proof: Readonly<ProviderReviewDatabaseIdentityProof>;
}) {
  return Object.freeze({
    activationScope: "database_reachability_only",
    checkKind: "database_only_provider_activation",
    databaseRole: input.proof.databaseRole,
    executionCapability: input.descriptor.executionCapability,
    schemaVersion: input.proof.schemaVersion,
    sourceCheckPerformed: false,
    sourceCredentialPresent: false,
  });
}

async function readSourceCredentialClone(input: {
  readonly client: PoolClient;
  readonly cipher: AesGcmProviderCredentialCipher;
  readonly baseline: Readonly<ProviderReviewCentralBaseline>;
  readonly providerKey: "clutchpacks";
}): Promise<string> {
  const result = await input.client.query<{
    provider_id: string;
    organization_id: string;
    credential_id: string;
    ciphertext: Buffer;
    nonce: Buffer;
    auth_tag: Buffer;
    key_version: number;
  }>(`
    select provider.id::text as provider_id,
           provider.organization_id::text as organization_id,
           credential.id::text as credential_id,
           credential.ciphertext, credential.nonce, credential.auth_tag,
           credential.key_version
    from providers provider
    join provider_config_versions config
      on config.id = provider.active_config_version_id
     and config.provider_id = provider.id
    join provider_credential_versions credential
      on credential.id = config.source_credential_version_id
     and credential.provider_id = provider.id
    where provider.provider_key = $1 and provider.lifecycle = 'active'
      and config.adapter_key = $2 and config.endpoint_url = $3
      and config.configuration = $4::jsonb and config.expires_at is null
      and credential.credential_kind = 'source'
      and credential.lifecycle = 'active'
      and credential.activated_at is not null
      and credential.retired_at is null and credential.revoked_at is null
  `, [
    input.providerKey,
    dataforrestClutchpacksDistributedSourceAdapterManifest.adapterVersion,
    DATAFORREST_EVENTS_V1_ENDPOINT,
    JSON.stringify({ platform: input.providerKey }),
  ]);
  const row = result.rows[0];
  if (
    result.rows.length !== 1 || row === undefined ||
    row.provider_id !== input.baseline.clutchpacksProviderId ||
    row.organization_id !== input.baseline.organizationId
  ) {
    refuse("SOURCE_CREDENTIAL_CLONE_UNAVAILABLE");
  }
  try {
    const plaintext = input.cipher.decrypt({
      ciphertext: new Uint8Array(row.ciphertext),
      nonce: new Uint8Array(row.nonce),
      authTag: new Uint8Array(row.auth_tag),
      keyVersion: row.key_version,
    }, credentialScope(
      input.baseline,
      row.provider_id,
      row.credential_id,
    ));
    if (
      plaintext.length < 16 || plaintext.length > 4_096 ||
      plaintext.trim() !== plaintext || /[\r\n\0]/u.test(plaintext)
    ) {
      refuse("SOURCE_CREDENTIAL_CLONE_INVALID");
    }
    return plaintext;
  } catch (error) {
    if (error instanceof ProviderReviewProvisionError) throw error;
    refuse("SOURCE_CREDENTIAL_CLONE_INVALID");
  }
}

async function assertExistingRegistration(input: {
  readonly client: PoolClient;
  readonly descriptor: Readonly<ReviewProviderDescriptor>;
  readonly ids: Readonly<ProviderReviewRegistrationIds>;
  readonly baseline: Readonly<ProviderReviewCentralBaseline>;
  readonly databasePassword: string;
  readonly databaseProof: Readonly<ProviderReviewDatabaseIdentityProof>;
  readonly cipher: AesGcmProviderCredentialCipher;
}): Promise<void> {
  assertDatabaseIdentityProof({
    descriptor: input.descriptor,
    proof: input.databaseProof,
  });
  const metadata = JSON.stringify({
    adapterKey: input.descriptor.adapterKey,
    databaseName: input.descriptor.databaseName,
    clusterPort: input.descriptor.port,
    executionCapability: input.descriptor.executionCapability,
    connectionTestKind: input.descriptor.connectionTestKind,
  });
  const connectionSummary = input.descriptor.connectionTestKind === "activation"
    ? sourceActivationSummary({
        descriptor: input.descriptor,
        proof: input.databaseProof,
      })
    : databaseConnectionSummary({ proof: input.databaseProof });
  const databaseActivationSummary = databaseOnlyActivationSummary({
    descriptor: input.descriptor,
    proof: input.databaseProof,
  });
  const result = await input.client.query<{
    registration_matches: boolean;
    database_ciphertext: Buffer;
    database_nonce: Buffer;
    database_auth_tag: Buffer;
    database_key_version: number;
    source_ciphertext: Buffer | null;
    source_nonce: Buffer | null;
    source_auth_tag: Buffer | null;
    source_key_version: number | null;
  }>(`
    select
      exists(select 1 from providers provider
        where provider.id = $1::uuid and provider.organization_id = $2::uuid
          and provider.provider_key = $3 and provider.display_name = $4
          and provider.lifecycle = 'active'
          and provider.active_config_version_id = $5::uuid
          and $22::boolean = ($11::uuid is not null)
          and provider.active_public_profile_version_id is null)
      and exists(select 1 from provider_public_profile_versions profile
        where profile.id = $6::uuid and profile.provider_id = $1::uuid
          and profile.version_number = 1 and profile.display_name = $4
          and profile.logo_url is null and profile.website_url is null
          and profile.listing_hosts = '{}'::text[]
          and profile.image_origins = '{}'::text[]
          and profile.referral_parameters = '[]'::jsonb
          and profile.promo_code is null and profile.promo_label is null
          and profile.content_hash = $7
          and profile.created_by_operator_id = $8::uuid)
      and exists(select 1 from provider_config_versions config
        where config.id = $5::uuid and config.provider_id = $1::uuid
          and config.version_number = 1 and config.adapter_key = $9
          and config.endpoint_url = $10
          and config.source_credential_version_id is not distinct from $11::uuid
          and config.schedule_seconds = 3600 and config.stale_after_seconds = 86400
          and config.configuration = $12::jsonb and config.expires_at is null
          and config.created_by_operator_id = $8::uuid)
      and exists(select 1 from provider_credential_versions credential
        where credential.id = $13::uuid and credential.provider_id = $1::uuid
          and credential.credential_kind = 'database'
          and credential.version_number = 1 and credential.lifecycle = 'active'
          and credential.activated_at is not null
          and credential.retired_at is null and credential.revoked_at is null)
      and ($11::uuid is null or exists(
        select 1 from provider_credential_versions credential
        where credential.id = $11::uuid and credential.provider_id = $1::uuid
          and credential.credential_kind = 'source'
          and credential.version_number = 1 and credential.lifecycle = 'active'
          and credential.activated_at is not null
          and credential.retired_at is null and credential.revoked_at is null))
      and ($22::boolean or not exists(
        select 1 from provider_credential_versions credential
        where credential.provider_id = $1::uuid
          and credential.credential_kind = 'source'))
      and exists(select 1 from provider_database_nodes node
        where node.id = $14::uuid and node.provider_id = $1::uuid
          and node.node_key = 'primary' and node.node_role = 'primary'
          and node.host = '127.0.0.1' and node.port = $15
          and node.database_name = $16 and node.ssl_mode = 'disable'
          and node.credential_version_id = $13::uuid
          and node.region = 'local' and node.enabled = true)
      and exists(select 1 from provider_connection_tests test
        join providers provider on provider.id = test.provider_id
        join provider_database_nodes node on node.id = test.database_node_id
        where test.id = $17::uuid and test.provider_id = $1::uuid
          and test.config_version_id = $5::uuid
          and test.source_credential_version_id is not distinct from $11::uuid
          and test.database_credential_version_id = $13::uuid
          and test.topology_version = provider.topology_version
          and test.database_node_id = $14::uuid
          and test.database_node_row_version = node.row_version
          and test.target_digest = packscout_activation_target_digest_nullable_source(
            $1::uuid, $5::uuid, $11::uuid, $13::uuid,
            provider.topology_version, $14::uuid, node.row_version)
          and test.test_kind = $23::connection_test_kind
          and test.outcome = 'succeeded'
          and test.tested_by_operator_id = $8::uuid
          and test.sanitized_code is null
          and test.has_more is null and test.next_cursor_present is null
          and (($23 = 'activation' and test.latency_ms is not null
                and test.response_status between 200 and 299
                and test.result_summary @> $24::jsonb
                and jsonb_typeof(test.result_summary -> 'responseBytes') = 'number'
                and test.record_counts = '{"records":1}'::jsonb)
            or ($23 = 'database' and test.latency_ms is null
                and test.response_status is null
                and test.result_summary = $24::jsonb
                and test.record_counts is null)))
      and ($22::boolean or exists(
        select 1 from provider_connection_tests test
        join providers provider on provider.id = test.provider_id
        join provider_database_nodes node on node.id = test.database_node_id
        where test.id = $25::uuid and test.provider_id = $1::uuid
          and test.config_version_id = $5::uuid
          and test.source_credential_version_id is null
          and test.database_credential_version_id = $13::uuid
          and test.topology_version = provider.topology_version
          and test.database_node_id = $14::uuid
          and test.database_node_row_version = node.row_version
          and test.target_digest = packscout_activation_target_digest_nullable_source(
            $1::uuid, $5::uuid, null, $13::uuid,
            provider.topology_version, $14::uuid, node.row_version)
          and test.test_kind = 'activation' and test.outcome = 'succeeded'
          and test.tested_by_operator_id = $8::uuid
          and test.latency_ms is null and test.response_status is null
          and test.sanitized_code is null
          and test.result_summary = $26::jsonb
          and test.record_counts is null
          and test.has_more is null and test.next_cursor_present is null))
      and exists(select 1 from audit_events audit
        where audit.id = $18::uuid and audit.organization_id = $2::uuid
          and audit.actor_key = $19 and audit.action = $20
          and audit.subject_type = 'provider' and audit.subject_id = $1::uuid
          and audit.outcome = 'success' and audit.metadata_json = $21::jsonb)
        as registration_matches,
      database_credential.ciphertext as database_ciphertext,
      database_credential.nonce as database_nonce,
      database_credential.auth_tag as database_auth_tag,
      database_credential.key_version as database_key_version,
      source_credential.ciphertext as source_ciphertext,
      source_credential.nonce as source_nonce,
      source_credential.auth_tag as source_auth_tag,
      source_credential.key_version as source_key_version
    from provider_credential_versions database_credential
    left join provider_credential_versions source_credential
      on source_credential.id = $11::uuid
    where database_credential.id = $13::uuid
  `, [
    input.ids.providerId,
    input.baseline.organizationId,
    input.descriptor.providerKey,
    input.descriptor.displayName,
    input.ids.configVersionId,
    input.ids.publicProfileVersionId,
    input.descriptor.publicProfile.contentHash,
    input.baseline.operatorId,
    input.descriptor.adapterKey,
    input.descriptor.endpointUrl,
    input.descriptor.cloneExistingSourceCredentialFromProviderKey === null
      ? null
      : input.ids.sourceCredentialVersionId,
    JSON.stringify(input.descriptor.sourceConfiguration),
    input.ids.databaseCredentialVersionId,
    input.ids.databaseNodeId,
    input.descriptor.port,
    input.descriptor.databaseName,
    input.ids.activationTestId,
    input.ids.auditEventId,
    REGISTRATION_ACTOR,
    REGISTRATION_ACTION,
    metadata,
    input.descriptor.connectionTestKind === "activation",
    input.descriptor.connectionTestKind,
    JSON.stringify(connectionSummary),
    input.ids.databaseOnlyActivationTestId,
    JSON.stringify(databaseActivationSummary),
  ]);
  const row = result.rows[0];
  const sourceEncrypted = row?.source_ciphertext === null ||
      row?.source_nonce === null || row?.source_auth_tag === null ||
      row?.source_key_version === null || row === undefined
    ? null
    : {
        ciphertext: new Uint8Array(row.source_ciphertext),
        nonce: new Uint8Array(row.source_nonce),
        authTag: new Uint8Array(row.source_auth_tag),
        keyVersion: row.source_key_version,
      };
  if (
    result.rows.length !== 1 || row === undefined || !row.registration_matches ||
    !decryptMatches({
      cipher: input.cipher,
      encrypted: {
        ciphertext: new Uint8Array(row.database_ciphertext),
        nonce: new Uint8Array(row.database_nonce),
        authTag: new Uint8Array(row.database_auth_tag),
        keyVersion: row.database_key_version,
      },
      expected: JSON.stringify({
        username: input.descriptor.appRoleName,
        password: input.databasePassword,
      }),
      scope: credentialScope(
        input.baseline,
        input.ids.providerId,
        input.ids.databaseCredentialVersionId,
      ),
    }) ||
    (input.descriptor.connectionTestKind === "activation"
      ? !decryptsAsBoundedSourceCredential({
          cipher: input.cipher,
          encrypted: sourceEncrypted,
          scope: credentialScope(
            input.baseline,
            input.ids.providerId,
            input.ids.sourceCredentialVersionId,
          ),
        })
      : sourceEncrypted !== null)
  ) {
    refuse("CENTRAL_REGISTRATION_STATE_UNEXPECTED");
  }
}

async function insertCredential(input: {
  readonly client: PoolClient;
  readonly id: string;
  readonly providerId: string;
  readonly kind: "database" | "source";
  readonly encrypted: EncryptedCredential;
  readonly now: Date;
}): Promise<void> {
  await input.client.query(`
    insert into provider_credential_versions (
      id, provider_id, credential_kind, version_number, ciphertext,
      nonce, auth_tag, key_version, lifecycle, activated_at, created_at
    ) values (
      $1::uuid, $2::uuid, $3::credential_kind, 1, $4, $5, $6, $7,
      'active', $8, $8
    )
  `, [
    input.id,
    input.providerId,
    input.kind,
    Buffer.from(input.encrypted.ciphertext),
    Buffer.from(input.encrypted.nonce),
    Buffer.from(input.encrypted.authTag),
    input.encrypted.keyVersion,
    input.now,
  ]);
}

async function insertRegistration(input: {
  readonly client: PoolClient;
  readonly descriptor: Readonly<ReviewProviderDescriptor>;
  readonly ids: Readonly<ProviderReviewRegistrationIds>;
  readonly baseline: Readonly<ProviderReviewCentralBaseline>;
  readonly databaseCredential: EncryptedCredential;
  readonly sourceCredential: EncryptedCredential | null;
  readonly databaseProof: Readonly<ProviderReviewDatabaseIdentityProof>;
  readonly sourceLiveCheck: Readonly<ProviderReviewSourceLiveCheckResult> | null;
}): Promise<void> {
  assertDatabaseIdentityProof({
    descriptor: input.descriptor,
    proof: input.databaseProof,
  });
  const expectsSourceActivation =
    input.descriptor.connectionTestKind === "activation";
  const liveCheckValid = input.sourceLiveCheck === null || (
    Number.isFinite(input.sourceLiveCheck.durationMilliseconds) &&
    input.sourceLiveCheck.durationMilliseconds >= 0 &&
    Number.isSafeInteger(input.sourceLiveCheck.recordCount) &&
    input.sourceLiveCheck.recordCount === 1 &&
    Number.isSafeInteger(input.sourceLiveCheck.responseBytes) &&
    input.sourceLiveCheck.responseBytes >= 1 &&
    input.sourceLiveCheck.responseBytes <=
      dataforrestLaunchDistributedSourceAdapterManifest.requestBounds
        .maximumResponseBytes &&
    Number.isSafeInteger(input.sourceLiveCheck.responseStatus) &&
    input.sourceLiveCheck.responseStatus >= 200 &&
    input.sourceLiveCheck.responseStatus <= 299
  );
  if (
    expectsSourceActivation !== (input.sourceCredential !== null) ||
    expectsSourceActivation !== (input.sourceLiveCheck !== null) ||
    !liveCheckValid
  ) {
    refuse("CENTRAL_REGISTRATION_EVIDENCE_INVALID");
  }
  const now = new Date();
  const sourceCredentialId = input.sourceCredential === null
    ? null
    : input.ids.sourceCredentialVersionId;
  await input.client.query(`
    insert into providers (
      id, organization_id, provider_key, display_name, lifecycle,
      topology_version, row_version, created_at, updated_at
    ) values ($1::uuid, $2::uuid, $3, $4, 'draft', 1, 1, $5, $5)
  `, [
    input.ids.providerId,
    input.baseline.organizationId,
    input.descriptor.providerKey,
    input.descriptor.displayName,
    now,
  ]);
  await input.client.query(`
    insert into provider_public_profile_versions (
      id, provider_id, version_number, display_name, logo_url, website_url,
      listing_hosts, image_origins, referral_parameters, promo_code,
      promo_label, content_hash, created_by_operator_id, created_at
    ) values (
      $1::uuid, $2::uuid, 1, $3, null, null, '{}'::text[], '{}'::text[],
      '[]'::jsonb, null, null, $4, $5::uuid, $6
    )
  `, [
    input.ids.publicProfileVersionId,
    input.ids.providerId,
    input.descriptor.publicProfile.displayName,
    input.descriptor.publicProfile.contentHash,
    input.baseline.operatorId,
    now,
  ]);
  await insertCredential({
    client: input.client,
    id: input.ids.databaseCredentialVersionId,
    providerId: input.ids.providerId,
    kind: "database",
    encrypted: input.databaseCredential,
    now,
  });
  if (input.sourceCredential !== null) {
    await insertCredential({
      client: input.client,
      id: input.ids.sourceCredentialVersionId,
      providerId: input.ids.providerId,
      kind: "source",
      encrypted: input.sourceCredential,
      now,
    });
  }
  await input.client.query(`
    insert into provider_config_versions (
      id, provider_id, version_number, adapter_key, endpoint_url,
      source_credential_version_id, schedule_seconds, stale_after_seconds,
      configuration, expires_at, created_by_operator_id, created_at
    ) values (
      $1::uuid, $2::uuid, 1, $3, $4, $5::uuid, 3600, 86400,
      $6::jsonb, null, $7::uuid, $8
    )
  `, [
    input.ids.configVersionId,
    input.ids.providerId,
    input.descriptor.adapterKey,
    input.descriptor.endpointUrl,
    sourceCredentialId,
    JSON.stringify(input.descriptor.sourceConfiguration),
    input.baseline.operatorId,
    now,
  ]);
  await input.client.query(`
    insert into provider_database_nodes (
      id, provider_id, node_key, node_role, host, port, database_name,
      ssl_mode, credential_version_id, region, enabled, row_version,
      created_at, updated_at
    ) values (
      $1::uuid, $2::uuid, 'primary', 'primary', '127.0.0.1', $3, $4,
      'disable', $5::uuid, 'local', true, 1, $6, $6
    )
  `, [
    input.ids.databaseNodeId,
    input.ids.providerId,
    input.descriptor.port,
    input.descriptor.databaseName,
    input.ids.databaseCredentialVersionId,
    now,
  ]);
  const topology = await input.client.query<{
    topology_version: string;
    node_row_version: string;
  }>(`
    select provider.topology_version::text,
           node.row_version::text as node_row_version
    from providers provider
    join provider_database_nodes node on node.provider_id = provider.id
    where provider.id = $1::uuid and node.id = $2::uuid
  `, [input.ids.providerId, input.ids.databaseNodeId]);
  const topologyRow = topology.rows[0];
  if (topology.rows.length !== 1 || topologyRow === undefined) {
    refuse("CENTRAL_REGISTRATION_FAILED");
  }
  const connectionSummary = input.sourceLiveCheck === null
    ? databaseConnectionSummary({ proof: input.databaseProof })
    : {
        ...sourceActivationSummary({
          descriptor: input.descriptor,
          proof: input.databaseProof,
        }),
        responseBytes: input.sourceLiveCheck.responseBytes,
      };
  await input.client.query(`
    insert into provider_connection_tests (
      id, provider_id, config_version_id, source_credential_version_id,
      database_credential_version_id, topology_version, database_node_id,
      database_node_row_version, target_digest, test_kind, outcome,
      latency_ms, response_status, sanitized_code, result_summary,
      record_counts, has_more, next_cursor_present, tested_by_operator_id,
      tested_at, created_at
    ) values (
      $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint,
      $7::uuid, $8::bigint,
      packscout_activation_target_digest_nullable_source(
        $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::bigint, $7::uuid,
        $8::bigint),
      $9::connection_test_kind, 'succeeded', $10, $11, null, $12::jsonb,
      $13::jsonb, null, null, $14::uuid, $15, $15
    )
  `, [
    input.ids.activationTestId,
    input.ids.providerId,
    input.ids.configVersionId,
    sourceCredentialId,
    input.ids.databaseCredentialVersionId,
    topologyRow.topology_version,
    input.ids.databaseNodeId,
    topologyRow.node_row_version,
    input.descriptor.connectionTestKind,
    input.sourceLiveCheck === null
      ? null
      : Math.round(input.sourceLiveCheck.durationMilliseconds),
    input.sourceLiveCheck?.responseStatus ?? null,
    JSON.stringify(connectionSummary),
    input.sourceLiveCheck === null
      ? null
      : JSON.stringify({ records: input.sourceLiveCheck.recordCount }),
    input.baseline.operatorId,
    now,
  ]);
  if (!expectsSourceActivation) {
    await input.client.query(`
      insert into provider_connection_tests (
        id, provider_id, config_version_id, source_credential_version_id,
        database_credential_version_id, topology_version, database_node_id,
        database_node_row_version, target_digest, test_kind, outcome,
        latency_ms, response_status, sanitized_code, result_summary,
        record_counts, has_more, next_cursor_present, tested_by_operator_id,
        tested_at, created_at
      ) values (
        $1::uuid, $2::uuid, $3::uuid, null, $4::uuid, $5::bigint,
        $6::uuid, $7::bigint,
        packscout_activation_target_digest_nullable_source(
          $2::uuid, $3::uuid, null, $4::uuid, $5::bigint, $6::uuid,
          $7::bigint),
        'activation', 'succeeded', null, null, null, $8::jsonb,
        null, null, null, $9::uuid, $10, $10
      )
    `, [
      input.ids.databaseOnlyActivationTestId,
      input.ids.providerId,
      input.ids.configVersionId,
      input.ids.databaseCredentialVersionId,
      topologyRow.topology_version,
      input.ids.databaseNodeId,
      topologyRow.node_row_version,
      JSON.stringify(databaseOnlyActivationSummary({
        descriptor: input.descriptor,
        proof: input.databaseProof,
      })),
      input.baseline.operatorId,
      now,
    ]);
  }
  await input.client.query(`
    update providers
    set lifecycle = 'active', active_config_version_id = $2::uuid,
        row_version = row_version + 1,
        updated_at = greatest($3, updated_at + interval '1 microsecond')
    where id = $1::uuid
  `, [
    input.ids.providerId,
    input.ids.configVersionId,
    now,
  ]);
  await input.client.query(`
    insert into audit_events (
      id, organization_id, actor_key, action, subject_type, subject_id,
      outcome, metadata_json, occurred_at
    ) values (
      $1::uuid, $2::uuid, $3, $4, 'provider', $5::uuid, 'success',
      $6::jsonb, $7
    )
  `, [
    input.ids.auditEventId,
    input.baseline.organizationId,
    REGISTRATION_ACTOR,
    REGISTRATION_ACTION,
    input.ids.providerId,
    JSON.stringify({
      adapterKey: input.descriptor.adapterKey,
      databaseName: input.descriptor.databaseName,
      clusterPort: input.descriptor.port,
      executionCapability: input.descriptor.executionCapability,
      connectionTestKind: input.descriptor.connectionTestKind,
    }),
    now,
  ]);
}

function assertProviderReviewRegistrationBatch(
  registrations: readonly Readonly<ProviderReviewRegistration>[],
): void {
  const expectedProviderKeys = ADDITIONAL_PROVIDER_REVIEW_DATABASES
    .map(({ providerKey }) => providerKey)
    .toSorted();
  const actualProviderKeys = registrations
    .map(({ descriptor }) => descriptor.providerKey)
    .toSorted();
  if (
    registrations.length !== ADDITIONAL_PROVIDER_REVIEW_DATABASES.length ||
    JSON.stringify(actualProviderKeys) !== JSON.stringify(expectedProviderKeys)
  ) {
    refuse("CENTRAL_REGISTRATION_BATCH_INVALID");
  }
  for (const registration of registrations) {
    assertDatabaseIdentityProof({
      descriptor: registration.descriptor,
      proof: registration.databaseProof,
    });
  }
  const distinctGroups: readonly (readonly (string | number)[])[] = [
    registrations.map(({ descriptor }) => descriptor.providerKey),
    registrations.map(({ descriptor }) => descriptor.port),
    registrations.map(({ descriptor }) => descriptor.databaseName),
    registrations.map(({ databaseProof }) => databaseProof.systemIdentifier),
    registrations.flatMap(({ ids }) => Object.values(ids)),
  ];
  if (distinctGroups.some((values) => new Set(values).size !== values.length)) {
    refuse("CENTRAL_REGISTRATION_BATCH_INVALID");
  }
}

export async function registerProviderReviewMetadataBatch(input: {
  readonly centralUrl: string;
  readonly registrations: readonly Readonly<ProviderReviewRegistration>[];
  readonly baseline: Readonly<ProviderReviewCentralBaseline>;
  readonly credentialKey: ProviderReviewProvisionEnvironment["credentialKey"];
  readonly dependencies?: Readonly<ProviderReviewRegistrationDependencies>;
}): Promise<void> {
  assertProviderReviewRegistrationBatch(input.registrations);
  const cipher = new AesGcmProviderCredentialCipher({
    primaryVersion: input.credentialKey.version,
    keys: new Map([[input.credentialKey.version, input.credentialKey.bytes]]),
  });
  const prepared = input.registrations.map((registration) => {
    let databasePlaintext = JSON.stringify({
      username: registration.descriptor.appRoleName,
      password: registration.databasePassword,
    });
    try {
      return Object.freeze({
        registration,
        databaseCredential: cipher.encrypt(
          databasePlaintext,
          credentialScope(
            input.baseline,
            registration.ids.providerId,
            registration.ids.databaseCredentialVersionId,
          ),
        ),
      });
    } catch {
      return refuse("CENTRAL_REGISTRATION_FAILED");
    } finally {
      databasePlaintext = "";
    }
  });
  const pool = new Pool({ connectionString: input.centralUrl, max: 1 });
  const client = await pool.connect().catch(async () => {
    await pool.end().catch(() => undefined);
    return refuse("CENTRAL_REGISTRATION_FAILED");
  });
  let sourceCredentialPlaintext: string | null = null;
  try {
    await client.query("begin isolation level serializable");
    await client.query("set local statement_timeout = '30s'");
    await client.query("set local lock_timeout = '5s'");
    const lockProviderKeys = input.registrations
      .map(({ descriptor }) => descriptor.providerKey)
      .toSorted();
    for (const providerKey of lockProviderKeys) {
      await client.query(
        "select pg_advisory_xact_lock(hashtextextended($1, 0))",
        [`packscout-local-provider-review:${providerKey}`],
      );
    }
    const states = [];
    for (const { registration } of prepared) {
      states.push(await registrationPresence(
        client,
        registration.descriptor,
        registration.ids,
      ));
    }
    const state = states[0];
    if (state === undefined || states.some((candidate) => candidate !== state)) {
      refuse("CENTRAL_REGISTRATION_BATCH_STATE_UNEXPECTED");
    }
    if (state === "absent") {
      for (const { registration, databaseCredential } of prepared) {
        const cloneProviderKey =
          registration.descriptor.cloneExistingSourceCredentialFromProviderKey;
        sourceCredentialPlaintext = cloneProviderKey === null
          ? null
          : await readSourceCredentialClone({
              client,
              cipher,
              baseline: input.baseline,
              providerKey: cloneProviderKey,
            });
        const sourceLiveCheck = sourceCredentialPlaintext === null
          ? null
          : await (input.dependencies?.runSourceLiveCheck ??
            runBoundedProviderReviewSourceLiveCheck)({
              providerKey: registration.descriptor.providerKey,
              token: sourceCredentialPlaintext,
            });
        const sourceCredential = sourceCredentialPlaintext === null
          ? null
          : cipher.encrypt(
              sourceCredentialPlaintext,
              credentialScope(
                input.baseline,
                registration.ids.providerId,
                registration.ids.sourceCredentialVersionId,
              ),
            );
        sourceCredentialPlaintext = null;
        await insertRegistration({
          client,
          descriptor: registration.descriptor,
          ids: registration.ids,
          baseline: input.baseline,
          databaseCredential,
          sourceCredential,
          databaseProof: registration.databaseProof,
          sourceLiveCheck,
        });
      }
    } else {
      for (const { registration } of prepared) {
        await assertExistingRegistration({
          client,
          descriptor: registration.descriptor,
          ids: registration.ids,
          baseline: input.baseline,
          databasePassword: registration.databasePassword,
          databaseProof: registration.databaseProof,
          cipher,
        });
      }
    }
    await input.dependencies?.beforeCommit?.();
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if (error instanceof ProviderReviewProvisionError) throw error;
    refuse("CENTRAL_REGISTRATION_FAILED");
  } finally {
    sourceCredentialPlaintext = null;
    client.release();
    await pool.end().catch(() => undefined);
  }
}
