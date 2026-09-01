import { closeSync, constants, fstatSync, openSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TLSSocket } from "node:tls";
import { Client } from "pg";
import { AesGcmProviderCredentialCipher, CipherProviderDatabaseCredentialResolver } from "@packscout/services";
import { NeonRoutingCutoverError, digest, neonHost, refuse, validatePlan, validateProof, validateRequests,
  type CutoverPlan, type DatabaseProof, type RoutePin, type RouteRequest } from "./neon-routing-cutover-plan.mts";
import { assertCentralIdentity, assertOperator, commitRoutingTransaction, pinRoute, readRouteAuthority } from "./neon-routing-cutover-central.mts";

const workspace = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
type Secrets = { centralUrl: string; credentialKeyBase64: string; credentialKeyVersion: number };
type Request = { operationId: string; organizationId: string; operatorId: string; centralHost: string; providers: RouteRequest[] };
export function assertCutoverEnvironment(environment: NodeJS.ProcessEnv): void {
  if (environment.NODE_ENV !== "development" || environment.PACKSCOUT_DATABASE_MODE !== "remote") refuse("NEON_CUTOVER_ENVIRONMENT_REFUSED");
}
function externalPath(file: string): string {
  if (typeof file !== "string" || !path.isAbsolute(file)) refuse("NEON_CUTOVER_PRIVATE_PATH_REQUIRED");
  const parent = realpathSync(path.dirname(file));
  const relative = path.relative(workspace, parent);
  if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) refuse("NEON_CUTOVER_PRIVATE_PATH_REQUIRED");
  const status = statSync(parent);
  if ((status.mode & 0o077) !== 0 || status.uid !== process.getuid?.()) refuse("NEON_CUTOVER_PRIVATE_PATH_REQUIRED");
  return path.join(parent, path.basename(file));
}
export function readPrivateJson(file: string): unknown {
  const descriptor = openSync(externalPath(file), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const status = fstatSync(descriptor);
    if (!status.isFile() || (status.mode & 0o777) !== 0o600 || status.uid !== process.getuid?.() || status.size > 1_048_576) refuse("NEON_CUTOVER_PRIVATE_FILE_REQUIRED");
    return JSON.parse(readFileSync(descriptor, "utf8"));
  } finally { closeSync(descriptor); }
}
export function writePrivateJson(file: string, value: unknown): void {
  writeFileSync(externalPath(file), `${JSON.stringify(value, null, 2)}\n`, { mode:0o600,flag:"wx" });
}
export function centralConnection(secrets: Secrets, expectedHost: string, readOnly: boolean): Client {
  const url = new URL(secrets.centralUrl);
  if (!/^postgresql?:$/u.test(url.protocol) || url.hostname !== expectedHost || !neonHost(url.hostname) ||
    (url.port && url.port !== "5432") || url.pathname !== "/packscout" || decodeURIComponent(url.username) !== "packscout_control_app" ||
    !url.password || url.hash || [...url.searchParams.keys()].some(key => !["sslmode","channel_binding"].includes(key))) refuse("NEON_CUTOVER_CENTRAL_TARGET_REFUSED");
  return databaseClient(expectedHost,"packscout","packscout_control_app",decodeURIComponent(url.password),readOnly);
}
function databaseClient(host: string, database: string, user: string, password: string, readOnly = true): Client {
  return new Client({ host,port:5432,database,user,password,
    ssl:{ rejectUnauthorized:true,servername:host },enableChannelBinding:true,
    application_name:"packscout-neon-routing-cutover",connectionTimeoutMillis:5000,query_timeout:15000,
    options:`-c default_transaction_read_only=${readOnly ? "on" : "off"} -c statement_timeout=15000 -c timezone=UTC` });
}
export function clientTls(client: Client): Pick<DatabaseProof,"encrypted"|"authorized"|"tlsVersion"> {
  const stream = (client as unknown as { connection:{ stream:TLSSocket } }).connection.stream;
  if (!stream.encrypted || !stream.authorized) refuse("NEON_CUTOVER_TLS_REQUIRED");
  return { encrypted:stream.encrypted,authorized:stream.authorized,tlsVersion:stream.getProtocol() ?? "" };
}
export async function readProviderProof(client: Client, pin: RoutePin): Promise<DatabaseProof> {
  const tls = clientTls(client);
  const rows = (await client.query(`select current_database() database_name,current_user app_role,
    d.database_role,d.schema_version,d.provider_id::text,d.provider_key,r.central_provider_id::text runtime_provider_id,
    r.provider_key runtime_provider_key,r.operating_state,r.state_generation::text,r.row_version::text,
    r.cached_config_version_id::text,r.cached_config_version_number::text,
    (select count(*)::integer from provider_runs where state in ('queued','running')) active_runs,
    (select count(*)::integer from control_commands where state in ('pending','accepted')) actionable_commands,
    (select count(*)::integer from provider_worker_states where lease_owner is not null) owned_leases,
    not (a.rolsuper or a.rolinherit or a.rolcreaterole or a.rolcreatedb or a.rolreplication or a.rolbypassrls) restricted_role,
    not exists(select 1 from pg_roles other where other.oid<>a.oid and pg_has_role(a.oid,other.oid,'MEMBER')) isolated_role
    from database_identity d cross join provider_runtime r join pg_roles a on a.rolname=current_user`)).rows;
  if (rows.length !== 1 || !rows[0].restricted_role || !rows[0].isolated_role) refuse("NEON_CUTOVER_DATABASE_PROOF_FAILED");
  const row = rows[0];
  const proof: DatabaseProof = { checkKind:"fresh_tls_provider_identity_and_paused_state",checkedAt:new Date().toISOString(),
    host:pin.targetHost,databaseName:row.database_name,appRole:row.app_role,providerId:row.provider_id,providerKey:row.provider_key,
    configId:row.cached_config_version_id,configVersion:row.cached_config_version_number,databaseRole:row.database_role,
    schemaVersion:row.schema_version,runtimeProviderId:row.runtime_provider_id,runtimeProviderKey:row.runtime_provider_key,
    runtimeState:row.operating_state,runtimeVersion:row.row_version,generation:row.state_generation,
    activeRuns:row.active_runs,actionableCommands:row.actionable_commands,ownedLeases:row.owned_leases,...tls };
  validateProof(proof,pin); return proof;
}
function credentialResolver(secrets: Secrets) {
  const key = Buffer.from(secrets.credentialKeyBase64,"base64");
  if (key.length !== 32 || key.toString("base64") !== secrets.credentialKeyBase64 ||
    !Number.isInteger(secrets.credentialKeyVersion) || secrets.credentialKeyVersion < 1) refuse("NEON_CUTOVER_KEY_INVALID");
  const cipher = new AesGcmProviderCredentialCipher({ primaryVersion:secrets.credentialKeyVersion,
    keys:new Map([[secrets.credentialKeyVersion,key]]) });
  const resolver = new CipherProviderDatabaseCredentialResolver(cipher);
  return { key,resolver };
}
async function probeProvider(resolver: CipherProviderDatabaseCredentialResolver, organizationId: string,
  pin: RoutePin, authority: Awaited<ReturnType<typeof readRouteAuthority>>[number]) {
  const credential = await resolver.resolve({ organizationId,providerId:pin.providerId,credentialVersionId:pin.databaseCredentialId,
    encryptedCredential:{ ciphertext:authority.ciphertext,nonce:authority.nonce,authTag:authority.auth_tag,keyVersion:authority.key_version } });
  if (credential.username !== `packscout_${pin.providerKey}_app`) refuse("NEON_CUTOVER_DATABASE_ROLE_REFUSED");
  const client = databaseClient(pin.targetHost,pin.databaseName,credential.username,credential.password);
  try { await client.connect(); return await readProviderProof(client,pin); }
  finally { await client.end().catch(()=>undefined); }
}
function safeFailure(error: unknown): never {
  if (error instanceof NeonRoutingCutoverError) throw error;
  return refuse("NEON_CUTOVER_FAILED");
}
export async function prepareNeonRoutingCutover(secrets: Secrets, request: Request) {
  assertCutoverEnvironment(process.env); validateRequests(request);
  const client = centralConnection(secrets,request.centralHost,true);
  const { key,resolver } = credentialResolver(secrets);
  try {
    await client.connect(); clientTls(client); await assertCentralIdentity(client); await assertOperator(client,request);
    const authorities = await readRouteAuthority(client,request.organizationId,request.providers);
    const providers = request.providers.map(route=>pinRoute(authorities.find(row=>row.provider_key===route.providerKey)!,route));
    const plan: CutoverPlan = { version:1,operationId:request.operationId,organizationId:request.organizationId,
      operatorId:request.operatorId,centralHost:request.centralHost,preparedAt:new Date().toISOString(),providers };
    validatePlan(plan,digest(plan));
    const proofs = [];
    for (const pin of providers) proofs.push(await probeProvider(resolver,plan.organizationId,pin,authorities.find(row=>row.provider_id===pin.providerId)!));
    const after = await readRouteAuthority(client,request.organizationId,request.providers);
    if (digest(after.map(row=>row.authority_hash)) !== digest(authorities.map(row=>row.authority_hash))) refuse("NEON_CUTOVER_AUTHORITY_CHANGED");
    return { plan,planDigest:digest(plan),proofs,sourceCheckPerformed:false,continuationStatus:"new_continuation_required" };
  } catch (error) { return safeFailure(error); }
  finally { key.fill(0); await client.end().catch(()=>undefined); }
}
export async function applyNeonRoutingCutover(secrets: Secrets, plan: CutoverPlan, approvedDigest: string, recoveryFile: string) {
  assertCutoverEnvironment(process.env); validatePlan(plan,approvedDigest);
  const client = centralConnection(secrets,plan.centralHost,false);
  const { key,resolver } = credentialResolver(secrets);
  try {
    // A fresh private receipt is mandatory BEFORE the first write. Old operations/receipts are never rewritten.
    writePrivateJson(recoveryFile,{ phase:"prepared",plan,planDigest:approvedDigest,preparedAt:new Date().toISOString(),
      continuationStatus:"new_continuation_required",warning:"Do not resume imports; ambiguous commit requires readback, not blind retry." });
    await client.connect(); clientTls(client); await assertCentralIdentity(client);
    const result = await commitRoutingTransaction({ client,plan,
      probe:(pin,authority)=>probeProvider(resolver,plan.organizationId,pin,authority) });
    writePrivateJson(`${recoveryFile}.committed.json`,{ ...result,committedAt:new Date().toISOString() });
    return result;
  } catch (error) { return safeFailure(error); }
  finally { key.fill(0); await client.end().catch(()=>undefined); }
}

/** CLI inputs and outputs are private JSON, never credentials in command arguments. */
async function main() {
  const [mode,inputFile,planFile,approvedDigest,recoveryFile] = process.argv.slice(2);
  assertCutoverEnvironment(process.env);
  if (!inputFile || !planFile || !["prepare","apply"].includes(mode ?? "")) refuse("NEON_CUTOVER_ARGUMENTS_INVALID");
  const input = readPrivateJson(inputFile) as Secrets & { request:Request };
  if (mode === "prepare") {
    if (approvedDigest || recoveryFile) refuse("NEON_CUTOVER_ARGUMENTS_INVALID");
    const prepared = await prepareNeonRoutingCutover(input,input.request);
    writePrivateJson(planFile,prepared);
    console.log(JSON.stringify({ phase:"prepared",operationId:prepared.plan.operationId,planDigest:prepared.planDigest,
      providerKeys:prepared.plan.providers.map(pin=>pin.providerKey),sourceCheckPerformed:false }));
  } else {
    if (!approvedDigest || !recoveryFile || process.argv.length !== 7) refuse("NEON_CUTOVER_ARGUMENTS_INVALID");
    const prepared = readPrivateJson(planFile) as { plan:CutoverPlan };
    console.log(JSON.stringify(await applyNeonRoutingCutover(input,prepared.plan,approvedDigest,recoveryFile)));
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error=>{ console.error(JSON.stringify({ code:error instanceof NeonRoutingCutoverError ? error.code : "NEON_CUTOVER_FAILED" }));process.exitCode=1; });
}
