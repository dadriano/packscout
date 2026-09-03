import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { tsImport } from "tsx/esm/api";
export const db = await tsImport("@packscout/database", import.meta.url);
export const contracts = await tsImport("@packscout/contracts", import.meta.url);
export const policy = await tsImport("./clutchpacks-production-source-policy.mts", import.meta.url);
const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtureEnvironment = { PATH: process.env.PATH, HOME: process.env.HOME, LC_ALL: "C", LANG: "C" };
const manifest = contracts.dataforrestClutchpacksDistributedSourceAdapterManifest;

export function optionsFixture() {
  return { centralDatabaseUrl: "postgresql://fixture:fixture@central.neon.tech/packscout?sslmode=require&sslaccept=strict",
    centralHost: "central.neon.tech", providerHost: "provider.neon.tech", credentialResolver: { resolve: async () => { throw new Error("Fixture credentials must never resolve"); } },
    scope: { organizationId: randomUUID(), providerId: randomUUID(), providerKey: "clutchpacks", operatorId: randomUUID(), configVersionId: randomUUID(), configVersionNumber: 4n },
    expected: { routeDigest: "a".repeat(64), latestSucceededRunId: randomUUID(), checkpointHash: "b".repeat(64), stateGeneration: 2n, runtimeRowVersion: 4n },
    approvedPublicAssetOrigins: ["https://cdn.example.test"] };
}
export async function sourcePostgresFixture() {
  const configured = process.env.PACKSCOUT_TEST_POSTGRES_BIN_DIRECTORY;
  const candidates = configured ? [configured] : [await exec("pg_config", ["--bindir"], { env: fixtureEnvironment })
    .then(({ stdout }) => stdout.trim()).catch(() => ""), "/opt/homebrew/opt/postgresql@16/bin", "/usr/lib/postgresql/16/bin"];
  let bin;
  for (const candidate of candidates.filter(Boolean)) {
    try { await access(join(candidate, "initdb")); await access(join(candidate, "pg_ctl")); bin = candidate; break; } catch { /* Try installed PG16 locations. */ }
  }
  assert.ok(bin, "PostgreSQL16 is required for the isolated source-reader regression");
  const directory = await mkdtemp("/tmp/packscout-production-source-");
  const data = join(directory, "data"), user = "source_reader_fixture", port = 5432;
  let started = false;
  const lifecycles = [];
  async function close() {
    await Promise.allSettled(lifecycles.map(lifecycle => lifecycle.close()));
    if (started) await exec(join(bin, "pg_ctl"), ["stop", "-D", data, "-m", "fast", "-w", "-t", "15"], { env: fixtureEnvironment });
    await rm(directory, { recursive: true, force: true });
  }
  try {
    // Socket-only, unique private directory; never opens or falls back to TCP5432.
    await exec(join(bin, "initdb"), ["-D", data, "-A", "trust", "-U", user, "--no-locale", "-E", "UTF8"], { env: fixtureEnvironment });
    await exec(join(bin, "pg_ctl"), ["start", "-D", data, "-l", join(directory, "postgres.log"), "-w", "-t", "15",
      "-o", `-F -p ${port} -k ${directory} -c listen_addresses='' -c unix_socket_permissions=0700`], { env: fixtureEnvironment });
    started = true;
    const urls = {};
    for (const [role, name] of [["central", "packscout"], ["provider", "packscout_clutchpacks"]]) {
      await exec(join(bin, "psql"), ["-h", directory, "-p", String(port), "-U", user, "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-c", `CREATE DATABASE "${name}"`], { env: fixtureEnvironment });
      const url = new URL(`postgresql://${user}@localhost:${port}/${name}`);
      url.searchParams.set("host", directory); url.searchParams.set("connection_limit", "2");
      urls[role] = url.toString();
      await exec(process.execPath, [join(root, "node_modules/prisma/build/index.js"), "migrate", "deploy", "--schema", join(root, `packages/database/prisma/${role}/schema.prisma`)],
        { env: { ...fixtureEnvironment, [role === "central" ? "PACKSCOUT_CENTRAL_DATABASE_URL" : "PACKSCOUT_PROVIDER_DATABASE_URL"]: url.toString() }, timeout: 120_000, maxBuffer: 2_000_000 });
    }
    const options = optionsFixture(), p = options.scope;
    const centralLifecycle = db.createCentralDatabaseLifecycle({ databaseUrl: urls.central });
    const providerLifecycle = db.createProviderDatabaseLifecycle({ databaseUrl: urls.provider, providerId: p.providerId, providerKey: p.providerKey });
    lifecycles.push(centralLifecycle, providerLifecycle);
    const central = centralLifecycle.client, provider = providerLifecycle.client;
    await db.initializeProviderDatabaseIdentity({ client: provider, providerId: p.providerId, providerKey: p.providerKey });
    await central.organizations.create({ data: { id: p.organizationId, slug: `fixture-${randomUUID()}`, name: "Source fixture" } });
    await central.operators.create({ data: { id: p.operatorId, email_normalized: `${randomUUID()}@example.test`, display_name: "Fixture operator", password_hash: "fixture-only-not-a-login-hash" } });
    await central.operator_memberships.create({ data: { organization_id: p.organizationId, operator_id: p.operatorId, role: "admin" } });
    await central.providers.create({ data: { id: p.providerId, organization_id: p.organizationId, provider_key: p.providerKey, display_name: "ClutchPacks" } });
    await central.provider_config_versions.create({ data: { id: p.configVersionId, provider_id: p.providerId, version_number: p.configVersionNumber,
      adapter_key: manifest.adapterVersion, endpoint_url: "https://source.example.test/events", schedule_seconds: 300, stale_after_seconds: 3_600,
      configuration: {}, created_by_operator_id: p.operatorId } });
    const credential = await central.provider_credential_versions.create({ data: { provider_id: p.providerId, credential_kind: "database", version_number: 1n,
      ciphertext: Buffer.from("fixture"), nonce: Buffer.alloc(12, 1), auth_tag: Buffer.alloc(16, 1), key_version: 1 } });
    const node = await central.provider_database_nodes.create({ data: { provider_id: p.providerId, node_key: "primary", node_role: "primary", host: options.providerHost, port, enabled: true,
      database_name: "packscout_clutchpacks", ssl_mode: "verify-full", credential_version_id: credential.id } });
    const topology = (await central.providers.findUniqueOrThrow({ where: { id: p.providerId } })).topology_version;
    const [target] = await central.$queryRaw`select packscout_activation_target_digest_nullable_source(${p.providerId}::uuid,
      ${p.configVersionId}::uuid, null::uuid, ${credential.id}::uuid, ${topology}::bigint, ${node.id}::uuid, ${node.row_version}::bigint) as digest`;
    // Synthetic activation receipt exists only in this newly created fixture; no source test is sent.
    await central.provider_connection_tests.create({ data: { provider_id: p.providerId, config_version_id: p.configVersionId,
      database_credential_version_id: credential.id, topology_version: topology, database_node_id: node.id, database_node_row_version: node.row_version,
      target_digest: target.digest, test_kind: "activation", outcome: "succeeded", result_summary: { fixture: true },
      tested_by_operator_id: p.operatorId, tested_at: new Date() } });
    await central.providers.update({ where: { id: p.providerId }, data: { lifecycle: "active", active_config_version_id: p.configVersionId,
      row_version: { increment: 1n }, updated_at: new Date() } });
    const located = await db.locateProviderDatabase(central, p); assert.equal(located.state, "ready"); options.expected.routeDigest = policy.sourceDigest(located.route);
    const cursor = { sourceInstanceId: p.providerId, sourceRevisionId: p.configVersionId, sourceTypeKey: manifest.sourceTypeKey,
      adapterVersion: manifest.adapterVersion, cursorCodecKey: manifest.cursorCodecKey, cursorGeneration: 1, value: "fixture-no-upstream" };
    options.expected.checkpointHash = db.providerMixedCursorFingerprint(cursor);
    await provider.provider_runtime.update({ where: { singleton_key: true }, data: { cached_config_version_id: p.configVersionId,
      cached_config_version_number: p.configVersionNumber, cached_configuration: { adapterKey: manifest.adapterVersion, settings: {} },
      schedule_seconds: 300, last_control_sync_at: new Date(), source_cursor: cursor, source_cursor_hash: options.expected.checkpointHash,
      row_version: { increment: 1n }, updated_at: new Date() } });
    const at = new Date();
    const { category, pack, cards, alias } = await provider.$transaction(async tx => {
    const category = await tx.categories.create({ data: { category_key: "pokemon", display_name: "Pokemon" } });
    const pack = await tx.packs.create({ data: { pack_key: "pack:fixture", category_id: category.id, display_name: "Fixture Pack", pack_format: "repack",
      availability: "available", content_evidence: "unknown", price_amount: "25", price_currency: "USD", price_usd_amount: "25",
      packscout_ev_model_version: "not_calculated", packscout_ev_confidence_policy_version: "not_calculated", primary_image_url: "https://cdn.example.test/pack.png", primary_image_alt: "Fixture Pack", source_updated_at: at } });
    const cards = [];
    for (let index = 0; index < 3; index++) cards.push(await tx.collectibles.create({ data: { collectible_key: `card:${index}`, category_id: category.id,
      collectible_type: "card", display_name: `Card ${index}`, normalized_name: `card ${index}`, data_as_of: at,
      primary_image_url: `https://cdn.example.test/card-${index}.png`, primary_image_alt: `Card ${index}` } }));
    const alias = await tx.collectible_name_aliases.create({ data: { collectible_id: cards[2].id, display_name: "Outside Membership Alias", normalized_name: "outside membership alias" } });
    await db.appendPromotionRange(tx, [
      { entityType: "category", entityId: category.id, entityVersion: category.row_version, operation: "upsert" },
      { entityType: "pack", entityId: pack.id, entityVersion: pack.row_version, operation: "upsert" },
      ...cards.map(card => ({ entityType: "collectible", entityId: card.id, entityVersion: card.row_version, operation: "upsert" })),
      { entityType: "collectible_name_alias", entityId: alias.id, entityVersion: alias.row_version, operation: "upsert" },
    ]);
    return { category, pack, cards, alias };
    });
    const leases = new db.PrismaProviderWorkerLeaseRepository(provider), runs = new db.PrismaProviderRunRepository(provider);
    const acquired = await leases.acquire({ role: "import", owner: "fixture:import", leaseMilliseconds: 120_000 }); assert.equal(acquired.kind, "acquired");
    const runId = options.expected.latestSucceededRunId, pageId = randomUUID();
    assert.equal((await runs.start({ runId, idempotencyKey: `fixture/${runId}`, trigger: "manual", requestedByOperatorId: p.operatorId,
      configVersionId: p.configVersionId, configVersionNumber: p.configVersionNumber, workerId: acquired.lease.owner,
      workerFence: acquired.lease.fence, correlationId: randomUUID(), requestedAt: new Date() })).kind, "started");
    assert.equal((await runs.commitPage({ pageId, runId, workerId: acquired.lease.owner, workerFence: acquired.lease.fence,
      contractVersion: "provider_mixed_page_v1", requestedCursor: cursor, requestedCursorHash: options.expected.checkpointHash,
      nextCursor: cursor, nextCursorHash: options.expected.checkpointHash, continuation: "head", responseDigest: "c".repeat(64),
      counts: { records: 0, catalog: 0, pulls: 0, marketEvents: 0, accepted: 0, duplicate: 0, quarantined: 0, materialChanges: 0 }, committedAt: new Date() })).kind, "committed");
    await provider.local_audit_events.create({ data: { correlation_id: randomUUID(), action: "provider.run.head_reconciliation", target_type: "provider_run", target_id: runId,
      outcome: "success", occurred_at: new Date(), details: { schemaVersion: 1, headPageId: pageId, configVersionId: p.configVersionId,
        checkpointHash: options.expected.checkpointHash, leaseFence: acquired.lease.fence.toString(), batchNumber: 1, phase: "complete",
        packAfterId: null, collectibleAfterId: null, packScanDone: true, collectibleScanDone: true, quarantineAfterId: null, quarantineAfterAt: null } } });
    assert.equal((await runs.finish({ runId, workerId: acquired.lease.owner, workerFence: acquired.lease.fence, state: "succeeded", failureCode: null,
      failureClass: null, failureSummary: null, correlationId: randomUUID(), finishedAt: new Date() })).kind, "finished");
    assert.equal(await leases.release(acquired.lease), true);
    const runtime = await provider.provider_runtime.findUniqueOrThrow({ where: { singleton_key: true } });
    options.expected.stateGeneration = runtime.state_generation; options.expected.runtimeRowVersion = runtime.row_version;
    return { options, central, provider, leases, cards, pack, category, alias, close };
  } catch (error) { await close(); throw error; }
}
