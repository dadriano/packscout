import type { Client } from "pg";
import { activationSummary, cutoverId, digest, refuse, validateProof,
  type CutoverPlan, type DatabaseProof, type RoutePin, type RouteRequest } from "./neon-routing-cutover-plan.mts";

export async function readRouteAuthority(client: Client, organizationId: string, requests: RouteRequest[]) {
  const rows = (await client.query(`select p.id::text provider_id,p.provider_key,p.lifecycle,p.row_version::text provider_version,
    p.topology_version::text,c.id::text config_id,c.version_number::text config_version,c.expires_at,
    c.source_credential_version_id::text source_credential_id,n.id::text node_id,n.row_version::text node_version,
    n.host,n.port,n.database_name,n.ssl_mode,n.region,n.credential_version_id::text database_credential_id,
    dc.ciphertext,dc.nonce,dc.auth_tag,dc.key_version,
    dc.lifecycle database_credential_lifecycle,sc.lifecycle source_credential_lifecycle,
    t.id::text prior_activation_id,t.tested_at prior_tested_at,t.response_status,
    encode(digest(t.result_summary::text,'sha256'),'hex') prior_summary_hash,
    encode(digest(concat_ws(':',to_jsonb(p)::text,to_jsonb(c)::text,to_jsonb(n)::text,
      to_jsonb(dc)::text,coalesce(to_jsonb(sc)::text,'null'),to_jsonb(t)::text),'sha256'),'hex') authority_hash,
    t.result_summary->>'sourceCheckPerformed' prior_source_check_performed,
    exists(select 1 from provider_connection_tests failed where failed.provider_id=p.id and failed.config_version_id=c.id
      and failed.source_credential_version_id is not distinct from c.source_credential_version_id
      and (failed.test_kind='source' or (failed.test_kind='activation'
        and failed.database_credential_version_id=t.database_credential_version_id and failed.topology_version=t.topology_version
        and failed.database_node_id=t.database_node_id and failed.database_node_row_version=t.database_node_row_version
        and failed.target_digest=t.target_digest))
      and failed.outcome<>'succeeded' and failed.tested_at>=t.tested_at) source_evidence_invalidated
    from providers p join provider_config_versions c on c.id=p.active_config_version_id and c.provider_id=p.id
    join provider_database_nodes n on n.provider_id=p.id and n.enabled and n.node_role='primary'
    join provider_credential_versions dc on dc.id=n.credential_version_id and dc.provider_id=p.id and dc.credential_kind='database'
    left join provider_credential_versions sc on sc.id=c.source_credential_version_id and sc.provider_id=p.id and sc.credential_kind='source'
    left join lateral (select * from provider_connection_tests t where t.provider_id=p.id and t.config_version_id=c.id
      and t.source_credential_version_id is not distinct from c.source_credential_version_id
      and t.database_credential_version_id=n.credential_version_id and t.topology_version=p.topology_version
      and t.database_node_id=n.id and t.database_node_row_version=n.row_version
      and t.target_digest=packscout_activation_target_digest_nullable_source(p.id,c.id,c.source_credential_version_id,
        n.credential_version_id,p.topology_version,n.id,n.row_version)
      and t.test_kind='activation' and t.outcome='succeeded' order by tested_at desc,id limit 1) t on true
    where p.organization_id=$1::uuid and p.provider_key=any($2) order by p.provider_key`,
  [organizationId, requests.map(p => p.providerKey)])).rows;
  if (rows.length !== requests.length || new Set(rows.map(row => row.provider_key)).size !== requests.length) refuse("NEON_CUTOVER_AUTHORITY_MISSING");
  return rows;
}
export function pinRoute(row: Awaited<ReturnType<typeof readRouteAuthority>>[number], request: RouteRequest): RoutePin {
  if (row.provider_key !== request.providerKey || row.lifecycle !== "active" || row.host !== "127.0.0.1" || row.ssl_mode !== "disable" ||
    row.region !== "local" || row.database_name !== `packscout_${request.providerKey}` ||
    (row.expires_at !== null && row.expires_at <= new Date()) || row.database_credential_lifecycle !== "active" ||
    (row.source_credential_id !== null && row.source_credential_lifecycle !== "active")) refuse("NEON_CUTOVER_AUTHORITY_CHANGED");
  if (!row.prior_activation_id || row.prior_source_check_performed === "false" || row.source_evidence_invalidated ||
    !Number.isInteger(row.response_status) || row.response_status < 200 || row.response_status > 299) refuse("NEON_CUTOVER_SOURCE_EVIDENCE_REQUIRED");
  return { providerKey: request.providerKey, targetHost: request.targetHost, targetRegion: request.targetRegion,
    providerId: row.provider_id, configId: row.config_id, configVersion: row.config_version,
    nodeId: row.node_id, databaseName: row.database_name, databaseCredentialId: row.database_credential_id,
    sourceCredentialId: row.source_credential_id, providerVersion: row.provider_version, topologyVersion: row.topology_version,
    nodeVersion: row.node_version, sourcePort: row.port, authorityHash: row.authority_hash,
    priorActivationId: row.prior_activation_id, priorTestedAt: row.prior_tested_at.toISOString(), priorSummaryHash: row.prior_summary_hash };
}
export async function assertOperator(client: Client, plan: Pick<CutoverPlan, "organizationId" | "operatorId">, lock = false) {
  const rows = (await client.query(`select m.id from operator_memberships m join operators o on o.id=m.operator_id
    where m.organization_id=$1::uuid and m.operator_id=$2::uuid and m.role='admin' and o.state='active'
    ${lock ? "for share of m,o" : ""}`, [plan.organizationId, plan.operatorId])).rows;
  if (rows.length !== 1) refuse("NEON_CUTOVER_OPERATOR_UNAVAILABLE");
}
export async function assertCentralIdentity(client: Client) {
  const rows = (await client.query(`select current_database() database_name,current_user app_role,d.* from database_identity d`)).rows;
  if (rows.length !== 1 || rows[0].database_name !== "packscout" || rows[0].app_role !== "packscout_control_app" ||
    rows[0].database_role !== "central" || rows[0].schema_version !== "distributed-central-v1" ||
    rows[0].provider_id !== null || rows[0].provider_key !== null || !rows[0].singleton_key) refuse("NEON_CUTOVER_CENTRAL_IDENTITY_MISMATCH");
}

/** Only central metadata changes. The caller's production probe is always a real read-only TLS connection. */
export async function commitRoutingTransaction(input: {
  client: Client; plan: CutoverPlan;
  probe: (pin: RoutePin, authority: Awaited<ReturnType<typeof readRouteAuthority>>[number]) => Promise<DatabaseProof>;
}) {
  const { client, plan } = input;
  await client.query("begin isolation level serializable");
  try {
    await client.query("set local statement_timeout='30s'");
    await client.query("set local lock_timeout='5s'");
    await assertOperator(client, plan, true);
    const ids = plan.providers.map(p => p.providerId).sort();
    await client.query("select id from providers where id=any($1::uuid[]) order by id for update", [ids]);
    await client.query("select id from provider_database_nodes where provider_id=any($1::uuid[]) order by id for update", [ids]);
    await client.query("select id from provider_credential_versions where provider_id=any($1::uuid[]) order by id for update", [ids]);
    const authorities = await readRouteAuthority(client, plan.organizationId, plan.providers);
    const proofs: DatabaseProof[] = [];
    for (const pin of plan.providers) {
      const authority = authorities.find(row => row.provider_id === pin.providerId);
      if (!authority || digest(pinRoute(authority, pin)) !== digest(pin)) refuse("NEON_CUTOVER_CAS_FAILED");
      const proof = await input.probe(pin, authority);
      validateProof(proof, pin); proofs.push(proof);
    }
    for (const [index, pin] of plan.providers.entries()) {
      const proof = proofs[index]!;
      const changed = await client.query(`update provider_database_nodes set host=$1,port=5432,ssl_mode='verify-full',region=$2,
        row_version=row_version+1,updated_at=greatest(clock_timestamp(),updated_at+interval '1 microsecond')
        where id=$3::uuid and provider_id=$4::uuid and row_version=$5::bigint and host='127.0.0.1' and port=$6
          and database_name=$7 and credential_version_id=$8::uuid and ssl_mode='disable' and region='local' and enabled and node_role='primary'`,
      [pin.targetHost,pin.targetRegion,pin.nodeId,pin.providerId,pin.nodeVersion,pin.sourcePort,pin.databaseName,pin.databaseCredentialId]);
      if (changed.rowCount !== 1) refuse("NEON_CUTOVER_CAS_FAILED");
      const topology = (await client.query(`select p.row_version::text provider_version,p.topology_version::text,n.row_version::text node_version
        from providers p join provider_database_nodes n on n.provider_id=p.id where p.id=$1::uuid and n.id=$2::uuid`, [pin.providerId,pin.nodeId])).rows[0];
      if (!topology || BigInt(topology.provider_version) !== BigInt(pin.providerVersion)+1n ||
        BigInt(topology.topology_version) !== BigInt(pin.topologyVersion)+1n || BigInt(topology.node_version) !== BigInt(pin.nodeVersion)+1n) refuse("NEON_CUTOVER_TOPOLOGY_MISMATCH");
      const summary = activationSummary(pin, proof, plan.operationId);
      await client.query(`insert into provider_connection_tests(id,provider_id,config_version_id,source_credential_version_id,
        database_credential_version_id,topology_version,database_node_id,database_node_row_version,target_digest,test_kind,outcome,
        latency_ms,response_status,result_summary,record_counts,has_more,next_cursor_present,tested_by_operator_id,tested_at)
        values($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::uuid,$8::bigint,
          packscout_activation_target_digest_nullable_source($2::uuid,$3::uuid,$4::uuid,$5::uuid,$6::bigint,$7::uuid,$8::bigint),
          'activation','succeeded',null,null,$9::jsonb,null,null,null,$10::uuid,clock_timestamp())`,
      [cutoverId(plan.operationId,pin.providerId,"activation"),pin.providerId,pin.configId,pin.sourceCredentialId,
        pin.databaseCredentialId,topology.topology_version,pin.nodeId,topology.node_version,JSON.stringify(summary),plan.operatorId]);
      await client.query(`insert into audit_events(id,organization_id,actor_key,action,subject_type,subject_id,outcome,metadata_json)
        values($1::uuid,$2::uuid,$3,'provider.database.neon_route_cutover','provider',$4::uuid,'success',$5::jsonb)`,
      [cutoverId(plan.operationId,pin.providerId,"audit"),plan.organizationId,"system:local-neon-route-cutover",pin.providerId,
        JSON.stringify({ operationId:plan.operationId,planDigest:digest(plan),previousHost:"127.0.0.1",previousPort:pin.sourcePort,
          targetHost:pin.targetHost,targetPort:5432,sslMode:"verify-full",sourceCheckPerformed:false,importsResumed:false,
          previousCentralRouteAuthorityHash:pin.authorityHash,priorOperationReceiptsRewritten:false,
          continuationStatus:"new_continuation_required",
          priorActivationId:pin.priorActivationId,activationTestId:cutoverId(plan.operationId,pin.providerId,"activation") })]);
    }
    // Re-observe paused runtime authority after the central writes, before commit. No cached proof is accepted.
    for (const [index,pin] of plan.providers.entries()) {
      const repeated = await input.probe(pin,authorities.find(row => row.provider_id===pin.providerId)!);
      validateProof(repeated,pin);
      if (digest({ ...repeated,checkedAt:undefined }) !== digest({ ...proofs[index]!,checkedAt:undefined })) refuse("NEON_CUTOVER_PROVIDER_CHANGED");
    }
    await client.query("set constraints all immediate");
    for (const pin of plan.providers) await client.query("select packscout_assert_provider_activation($1::uuid)",[pin.providerId]);
    await client.query("commit");
    return { operationId:plan.operationId,planDigest:digest(plan),committed:true,normalGatewaySmokeRequired:true,
      continuationStatus:"new_continuation_required",providers:plan.providers.map(pin=>({
      providerKey:pin.providerKey,providerId:pin.providerId,activationTestId:cutoverId(plan.operationId,pin.providerId,"activation"),
      priorActivationId:pin.priorActivationId,sourceCheckPerformed:false,importsResumed:false })) };
  } catch (error) {
    await client.query("rollback").catch(()=>undefined);
    throw error;
  }
}
