import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { tsImport } from "tsx/esm/api";

const planModule = await tsImport("./neon-routing-cutover-plan.mts",import.meta.url);
const io = await tsImport("./neon-routing-cutover.mts",import.meta.url);
const { activationSummary,cutoverId,digest,validatePlan,validateProof,validateRequests } = planModule;
const id = n => `72000000-0000-5000-8000-${String(n).padStart(12,"0")}`;
function pin() { return { providerKey:"alpha",targetHost:"ep-alpha-example.us-west-2.aws.neon.tech",targetRegion:"aws-us-west-2",
  providerId:id(1),configId:id(2),configVersion:"4",nodeId:id(3),databaseName:"packscout_alpha",databaseCredentialId:id(4),
  sourceCredentialId:id(5),providerVersion:"5",topologyVersion:"2",nodeVersion:"1",sourcePort:55432,
  authorityHash:"a".repeat(64),priorActivationId:id(6),priorTestedAt:"2026-08-29T01:00:00.000Z",priorSummaryHash:"b".repeat(64) }; }
function plan() { return { version:1,operationId:id(7),organizationId:id(8),operatorId:id(9),
  centralHost:"ep-control-example.us-west-2.aws.neon.tech",preparedAt:new Date().toISOString(),providers:[pin()] }; }
function proof() { const p=pin(); return { checkKind:"fresh_tls_provider_identity_and_paused_state",checkedAt:new Date().toISOString(),
  host:p.targetHost,databaseName:p.databaseName,appRole:"packscout_alpha_app",providerId:p.providerId,providerKey:p.providerKey,
  configId:p.configId,configVersion:p.configVersion,databaseRole:"provider",schemaVersion:"distributed-provider-v1",
  runtimeProviderId:p.providerId,runtimeProviderKey:p.providerKey,runtimeState:"paused",runtimeVersion:"100",generation:"7",
  activeRuns:0,actionableCommands:0,ownedLeases:0,encrypted:true,authorized:true,tlsVersion:"TLSv1.3" }; }
const hasCode = code => error => error.code===code;

test("reviewed route plan pins isolated direct Neon hosts and rejects local, pooled, aliased or foreign input",()=>{
  const p=plan(); validatePlan(p,digest(p));
  for(const host of ["127.0.0.1","ep-alpha-pooler.us-west-2.aws.neon.tech","ep-alpha.neon.tech.evil.test",p.centralHost]) {
    assert.throws(()=>validateRequests({...p,providers:[{...pin(),targetHost:host}]}));
  }
  assert.throws(()=>validateRequests({...p,providers:[pin(),pin()]}),hasCode("NEON_CUTOVER_ISOLATION_INVALID"));
  assert.throws(()=>validatePlan({...p,operatorId:id(10)},digest(p)),hasCode("NEON_CUTOVER_PLAN_CHANGED"));
  const extra={...p,unexpectedSecret:"never-persist-this"};
  assert.throws(()=>validatePlan(extra,digest(extra)),hasCode("NEON_CUTOVER_PLAN_CHANGED"));
  const foreign={...p,providers:[{...pin(),databaseName:"packscout_beta"}]};
  assert.throws(()=>validatePlan(foreign,digest(foreign)),hasCode("NEON_CUTOVER_PIN_INVALID"));
});
test("fresh database proof rejects TLS, identity, scope, active import, credential role and authority drift",()=>{
  validateProof(proof(),pin());
  for(const change of [{encrypted:false},{authorized:false},{tlsVersion:"TLSv1.1"},{providerId:id(20)},
    {runtimeProviderId:id(20)},{providerKey:"beta"},{databaseName:"neondb"},{appRole:"neondb_owner"},
    {configId:id(20)},{configVersion:"5"},{runtimeState:"running"},{activeRuns:1},{actionableCommands:1},{ownedLeases:1},
    {checkedAt:"2020-01-01T00:00:00.000Z"},{checkedAt:new Date(Date.now()+100_000).toISOString()},
    {password:"never-persist-this"}]) assert.throws(()=>validateProof({...proof(),...change},pin()),hasCode("NEON_CUTOVER_DATABASE_PROOF_FAILED"));
});
test("activation receipt explicitly retains historical source evidence without inventing fresh source liveness",()=>{
  const summary=activationSummary(pin(),proof(),id(7));
  assert.equal(summary.sourceCheckPerformed,false); assert.equal(summary.sourceLivenessRechecked,false);
  assert.equal(summary.importsResumed,false); assert.equal(summary.continuationStatus,"new_continuation_required");
  assert.equal(summary.sourceEvidence.originalTestedAt,pin().priorTestedAt);
  assert.equal(summary.sourceEvidence.activationTestId,pin().priorActivationId);
  assert.equal(summary.previousCentralRouteAuthorityHash,pin().authorityHash);
  assert.equal(summary.priorOperationReceiptsRewritten,false);
  assert.equal("previousAuthorityDigest" in summary,false);
  assert.equal(summary.sourceEvidence.configVersionId,pin().configId);
  assert.notEqual(summary.databaseProof.checkedAt,summary.sourceEvidence.originalTestedAt);
  assert.equal(cutoverId(id(7),id(1),"activation"),cutoverId(id(7),id(1),"activation"));
  assert.notEqual(cutoverId(id(7),id(1),"activation"),cutoverId(id(7),id(1),"audit"));
});
test("CLI and connector guards refuse production, implicit local mode, admin DSNs and target substitution",()=>{
  io.assertCutoverEnvironment({NODE_ENV:"development",PACKSCOUT_DATABASE_MODE:"remote"});
  for(const env of [{},{NODE_ENV:"production",PACKSCOUT_DATABASE_MODE:"remote"},{NODE_ENV:"development"}]) {
    assert.throws(()=>io.assertCutoverEnvironment(env),hasCode("NEON_CUTOVER_ENVIRONMENT_REFUSED"));
  }
  for(const user of ["neondb_owner","packscout_alpha_app"]) assert.throws(()=>io.centralConnection({
    centralUrl:`postgresql://${user}:synthetic-password@${plan().centralHost}/packscout`},plan().centralHost,true),hasCode("NEON_CUTOVER_CENTRAL_TARGET_REFUSED"));
  assert.throws(()=>io.centralConnection({centralUrl:"postgresql://packscout_control_app:synthetic@127.0.0.1/packscout"},plan().centralHost,true));
});
test("actual proof reader requires TLS before querying and validates database-returned paused identity",async()=>{
  let calls=0;
  await assert.rejects(io.readProviderProof({connection:{stream:{encrypted:false,authorized:false}},query:()=>{calls++;}},pin()),hasCode("NEON_CUTOVER_TLS_REQUIRED"));
  assert.equal(calls,0);
  const p=pin(); const row={database_name:p.databaseName,app_role:"packscout_alpha_app",database_role:"provider",
    schema_version:"distributed-provider-v1",provider_id:p.providerId,provider_key:p.providerKey,runtime_provider_id:p.providerId,
    runtime_provider_key:p.providerKey,operating_state:"paused",state_generation:"7",row_version:"100",
    cached_config_version_id:p.configId,cached_config_version_number:p.configVersion,active_runs:0,actionable_commands:0,
    owned_leases:0,restricted_role:true,isolated_role:true};
  const client={connection:{stream:{encrypted:true,authorized:true,getProtocol:()=>"TLSv1.3"}},query:async sql=>{
    assert.match(sql,/^select /); calls++; return {rows:[row]};}};
  validateProof(await io.readProviderProof(client,p),p);
  row.isolated_role=false;
  await assert.rejects(io.readProviderProof(client,p),hasCode("NEON_CUTOVER_DATABASE_PROOF_FAILED"));
});
test("private recovery records are exclusive mode600 files outside the worktree and reject symlinks",()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),"packscout-neon-cutover-")); chmodSync(directory,0o700);
  try {
    const file=path.join(directory,"receipt.json"); io.writePrivateJson(file,{operationId:id(7)});
    assert.equal(statSync(file).mode&0o777,0o600); assert.deepEqual(io.readPrivateJson(file),{operationId:id(7)});
    assert.throws(()=>io.writePrivateJson(file,{overwritten:true}));
    assert.equal(readFileSync(file,"utf8").includes("overwritten"),false);
    const link=path.join(directory,"link.json"); symlinkSync(file,link); assert.throws(()=>io.readPrivateJson(link));
    chmodSync(file,0o644); assert.throws(()=>io.readPrivateJson(file),hasCode("NEON_CUTOVER_PRIVATE_FILE_REQUIRED"));
    const bad=path.join(directory,"bad.json"); writeFileSync(bad,"not-json",{mode:0o600}); assert.throws(()=>io.readPrivateJson(bad));
    assert.throws(()=>io.writePrivateJson("receipt.json",{}),hasCode("NEON_CUTOVER_PRIVATE_PATH_REQUIRED"));
  } finally { rmSync(directory,{recursive:true,force:true}); }
});
