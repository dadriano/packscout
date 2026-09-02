import assert from "node:assert/strict";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { fixtureId,fixtureOrganization,fixtureOperator,seedSyntheticRoute,syntheticCutoverDatabase,syntheticProof } from "./neon-routing-cutover-test-fixture.mjs";

const { commitRoutingTransaction,pinRoute,readRouteAuthority }=await tsImport("./neon-routing-cutover-central.mts",import.meta.url);
const { digest }=await tsImport("./neon-routing-cutover-plan.mts",import.meta.url);
async function createPlan(db,keys=["alpha"]) {
  const providers=keys.map(providerKey=>({providerKey,targetHost:`ep-${providerKey}-test.us-west-2.aws.neon.tech`,targetRegion:"aws-us-west-2"}));
  const rows=await readRouteAuthority(db,fixtureOrganization,providers);
  return {version:1,operationId:fixtureId(20),organizationId:fixtureOrganization,operatorId:fixtureOperator,
    centralHost:"ep-control-test.us-west-2.aws.neon.tech",preparedAt:new Date().toISOString(),
    providers:providers.map(request=>pinRoute(rows.find(row=>row.provider_key===request.providerKey),request))};
}
async function state(db) {
  const result={};
  for(const relation of ["providers","provider_database_nodes","provider_config_versions","provider_credential_versions","provider_connection_tests","audit_events"])
    result[relation]=(await db.query(`select to_jsonb(t) row from ${relation} t order by id`)).rows;
  return result;
}
test("routing cutover commits exact fresh DB evidence plus historical source evidence without altering identity/config/ciphertext",async()=>{
  const fixture=await syntheticCutoverDatabase();
  try {
    const ids=await seedSyntheticRoute(fixture.db); const plan=await createPlan(fixture.db);const before=await state(fixture.db);
    let probes=0;
    const result=await commitRoutingTransaction({client:fixture.db,plan,probe:async pin=>{probes++;return syntheticProof(pin);}});
    assert.equal(probes,2);assert.equal(result.committed,true);assert.equal(result.normalGatewaySmokeRequired,true);
    assert.equal(result.continuationStatus,"new_continuation_required");
    const after=await state(fixture.db);
    for(const name of ["provider_config_versions","provider_credential_versions"]) assert.deepEqual(after[name],before[name]);
    const provider=after.providers[0].row,node=after.provider_database_nodes[0].row;
    assert.equal(provider.id,ids.provider);assert.equal(provider.lifecycle,"active");assert.equal(provider.active_config_version_id,ids.config);
    assert.equal(BigInt(provider.row_version),BigInt(plan.providers[0].providerVersion)+1n);
    assert.equal(BigInt(provider.topology_version),BigInt(plan.providers[0].topologyVersion)+1n);
    assert.equal(node.id,ids.node);assert.equal(node.credential_version_id,ids.databaseCredential);assert.equal(node.host,plan.providers[0].targetHost);
    assert.equal(node.ssl_mode,"verify-full");assert.equal(node.port,5432);
    assert.equal(after.provider_connection_tests.length,2);assert.equal(after.audit_events.length,before.audit_events.length+1);
    const receipt=after.provider_connection_tests.find(row=>row.row.id!==ids.activation).row;
    assert.equal(receipt.test_kind,"activation");assert.equal(receipt.outcome,"succeeded");assert.equal(receipt.response_status,null);
    assert.equal(receipt.record_counts,null);assert.equal(receipt.result_summary.sourceCheckPerformed,false);
    assert.equal(receipt.result_summary.sourceEvidence.activationTestId,ids.activation);
    assert.equal(receipt.result_summary.sourceEvidence.originalTestedAt,plan.providers[0].priorTestedAt);
    assert.equal(receipt.result_summary.previousCentralRouteAuthorityHash,plan.providers[0].authorityHash);
    assert.equal(receipt.result_summary.priorOperationReceiptsRewritten,false);
    const audit=after.audit_events.find(row=>row.row.action==="provider.database.neon_route_cutover").row;
    assert.equal(audit.actor_key,"system:local-neon-route-cutover");
    assert.equal(audit.actor_key.includes(fixtureOperator),false);
    assert.equal(audit.metadata_json.previousCentralRouteAuthorityHash,plan.providers[0].authorityHash);
    assert.equal(audit.metadata_json.priorOperationReceiptsRewritten,false);
    assert.equal(digest(after.provider_connection_tests.find(row=>row.row.id===ids.activation)),digest(before.provider_connection_tests[0]));
    await fixture.db.query("select packscout_assert_provider_activation($1::uuid)",[ids.provider]);
    const committed=await state(fixture.db);
    await assert.rejects(commitRoutingTransaction({client:fixture.db,plan,probe:async p=>syntheticProof(p)}));
    assert.deepEqual(await state(fixture.db),committed,"replay must not create another receipt or increment topology");
  }finally{await fixture.stop();}
});
test("ordinary deferred guard rejects a route update without an exact new activation receipt",async()=>{
  const fixture=await syntheticCutoverDatabase();
  try {
    const ids=await seedSyntheticRoute(fixture.db);const before=await state(fixture.db);
    await fixture.db.query("begin");
    await fixture.db.query("update provider_database_nodes set host='ep-untested.us-west-2.aws.neon.tech',row_version=row_version+1,updated_at=clock_timestamp() where id=$1",[ids.node]);
    await assert.rejects(fixture.db.query("commit"),error=>error.code==="23514");await fixture.db.query("rollback");
    assert.deepEqual(await state(fixture.db),before);
  }finally{await fixture.stop();}
});
test("provider drift during repeated proof rolls back every route, new receipt and audit in an atomic batch",async()=>{
  const fixture=await syntheticCutoverDatabase();
  try {
    await seedSyntheticRoute(fixture.db,"alpha",100);await seedSyntheticRoute(fixture.db,"beta",200);
    const plan=await createPlan(fixture.db,["alpha","beta"]),before=await state(fixture.db);let probes=0;
    await assert.rejects(commitRoutingTransaction({client:fixture.db,plan,probe:async pin=>{
      probes++;return {...syntheticProof(pin),runtimeVersion:probes===4?"6":"5"};
    }}),error=>error.code==="NEON_CUTOVER_PROVIDER_CHANGED");
    assert.equal(probes,4);assert.deepEqual(await state(fixture.db),before);
  }finally{await fixture.stop();}
});
test("stale central authority and a newer failed source test refuse cutover before route mutation",async()=>{
  const fixture=await syntheticCutoverDatabase();
  try {
    const ids=await seedSyntheticRoute(fixture.db);const plan=await createPlan(fixture.db);let probes=0;
    await assert.rejects(commitRoutingTransaction({client:fixture.db,plan:{...plan,providers:[{...plan.providers[0],authorityHash:"0".repeat(64)}]},
      probe:async pin=>{probes++;return syntheticProof(pin);}}),error=>error.code==="NEON_CUTOVER_CAS_FAILED");
    assert.equal(probes,0);
    await fixture.db.query(`insert into provider_connection_tests(id,provider_id,config_version_id,source_credential_version_id,
      topology_version,target_digest,test_kind,outcome,tested_by_operator_id,tested_at,result_summary)
      select $1,provider_id,config_version_id,source_credential_version_id,topology_version,target_digest,'source','failed',
        tested_by_operator_id,clock_timestamp(),'{}' from provider_connection_tests where id=$2`,[fixtureId(300),ids.activation]);
    const before=await state(fixture.db);
    await assert.rejects(commitRoutingTransaction({client:fixture.db,plan,probe:async p=>syntheticProof(p)}),error=>error.code==="NEON_CUTOVER_SOURCE_EVIDENCE_REQUIRED");
    assert.deepEqual(await state(fixture.db),before);
  }finally{await fixture.stop();}
});
test("failed activation invalidates historical evidence only for the exact current database tuple",async()=>{
  const fixture=await syntheticCutoverDatabase();
  try {
    const ids=await seedSyntheticRoute(fixture.db);const plan=await createPlan(fixture.db);
    async function failure(id,topologyOffset) {
      await fixture.db.query(`insert into provider_connection_tests(id,provider_id,config_version_id,source_credential_version_id,
        database_credential_version_id,topology_version,database_node_id,database_node_row_version,target_digest,
        test_kind,outcome,tested_by_operator_id,tested_at,result_summary)
        select $1,provider_id,config_version_id,source_credential_version_id,database_credential_version_id,
          topology_version+$3,database_node_id,database_node_row_version,target_digest,'activation','failed',
          tested_by_operator_id,clock_timestamp(),'{}' from provider_connection_tests where id=$2`,[id,ids.activation,topologyOffset]);
    }
    await failure(fixtureId(301),1);
    const unaffected=(await readRouteAuthority(fixture.db,fixtureOrganization,plan.providers))[0];
    assert.equal(unaffected.source_evidence_invalidated,false);
    assert.deepEqual(pinRoute(unaffected,plan.providers[0]),plan.providers[0]);
    await failure(fixtureId(302),0);
    const before=await state(fixture.db);let probes=0;
    await assert.rejects(commitRoutingTransaction({client:fixture.db,plan,probe:async p=>{probes++;return syntheticProof(p);}}),
      error=>error.code==="NEON_CUTOVER_SOURCE_EVIDENCE_REQUIRED");
    assert.equal(probes,0);assert.deepEqual(await state(fixture.db),before);
  }finally{await fixture.stop();}
});
