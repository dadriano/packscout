import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { Client } from "pg";

export const fixtureId=n=>`73000000-0000-5000-8000-${String(n).padStart(12,"0")}`;
export const fixtureOrganization=fixtureId(1),fixtureOperator=fixtureId(2);
export async function syntheticCutoverDatabase() {
  const adminUrl=new URL(process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL ?? `postgresql://${encodeURIComponent(userInfo().username)}@127.0.0.1:5432/postgres`);
  if (!/^postgresql?:$/u.test(adminUrl.protocol) || !["127.0.0.1","localhost","[::1]"].includes(adminUrl.hostname) ||
    adminUrl.pathname!=="/postgres" || !["","5432"].includes(adminUrl.port) || /^packscout_/u.test(decodeURIComponent(adminUrl.username))) throw new Error("Disposable local test admin required");
  const name=`packscout_neon_cutover_test_${process.pid}_${randomBytes(6).toString("hex")}`;
  if (!/^packscout_neon_cutover_test_[0-9]+_[a-f0-9]{12}$/u.test(name)) throw new Error("Unsafe test database name");
  const admin=new Client({connectionString:adminUrl.toString()}); await admin.connect();
  let db,created=false;
  try {
    await admin.query(`create database "${name}"`); created=true;
    const url=new URL(adminUrl); url.pathname=`/${name}`;
    db=new Client({connectionString:url.toString()}); await db.connect();
    await db.query(await readFile(new URL("../../packages/database/prisma/central/migrations/20260829000000_distributed_central_baseline/migration.sql",import.meta.url),"utf8"));
    await db.query("insert into organizations(id,slug,name) values($1,'neon-cutover-test','Synthetic')",[fixtureOrganization]);
    await db.query("insert into operators(id,email_normalized,display_name,password_hash) values($1,'synthetic@example.test','Synthetic','not-a-real-password-hash')",[fixtureOperator]);
    await db.query("insert into operator_memberships(id,organization_id,operator_id,role) values($1,$2,$3,'admin')",[fixtureId(3),fixtureOrganization,fixtureOperator]);
    return { db,stop:async()=>{await db.end();await admin.query(`drop database "${name}"`);created=false;await admin.end();} };
  } catch(error) { if(db)await db.end().catch(()=>{});if(created)await admin.query(`drop database "${name}"`);await admin.end();throw error; }
}
export async function seedSyntheticRoute(db,key="alpha",offset=100) {
  const ids={provider:fixtureId(offset),config:fixtureId(offset+1),databaseCredential:fixtureId(offset+2),
    sourceCredential:fixtureId(offset+3),node:fixtureId(offset+4),activation:fixtureId(offset+5)};
  await db.query("begin");
  try {
    await db.query("insert into providers(id,organization_id,provider_key,display_name) values($1,$2,$3,'Synthetic')",[ids.provider,fixtureOrganization,key]);
    for(const [credential,kind] of [[ids.databaseCredential,"database"],[ids.sourceCredential,"source"]]) {
      await db.query(`insert into provider_credential_versions(id,provider_id,credential_kind,version_number,ciphertext,nonce,auth_tag,key_version,lifecycle,activated_at)
        values($1,$2,$3,1,$4,$5,$6,1,'active',clock_timestamp())`,[credential,ids.provider,kind,Buffer.alloc(32,1),Buffer.alloc(12,2),Buffer.alloc(16,3)]);
    }
    await db.query(`insert into provider_config_versions(id,provider_id,version_number,adapter_key,endpoint_url,source_credential_version_id,
      schedule_seconds,stale_after_seconds,configuration,created_by_operator_id)
      values($1,$2,1,'synthetic-adapter-v1','https://source.example.test/events',$3,3600,86400,'{}',$4)`,[ids.config,ids.provider,ids.sourceCredential,fixtureOperator]);
    await db.query(`insert into provider_database_nodes(id,provider_id,node_key,node_role,host,port,database_name,ssl_mode,credential_version_id,region,enabled)
      values($1,$2,'primary','primary','127.0.0.1',55432,$3,'disable',$4,'local',true)`,[ids.node,ids.provider,`packscout_${key}`,ids.databaseCredential]);
    await db.query(`insert into provider_connection_tests(id,provider_id,config_version_id,source_credential_version_id,database_credential_version_id,
      topology_version,database_node_id,database_node_row_version,target_digest,test_kind,outcome,response_status,result_summary,tested_by_operator_id,tested_at)
      select $1,p.id,$3,$4,$5,p.topology_version,n.id,n.row_version,
        packscout_activation_target_digest_nullable_source(p.id,$3,$4,$5,p.topology_version,n.id,n.row_version),
        'activation','succeeded',200,'{"checkKind":"synthetic_prior_source_evidence"}',$6,clock_timestamp()
      from providers p join provider_database_nodes n on n.provider_id=p.id where p.id=$2`,
    [ids.activation,ids.provider,ids.config,ids.sourceCredential,ids.databaseCredential,fixtureOperator]);
    await db.query("update providers set lifecycle='active',active_config_version_id=$2,row_version=row_version+1,updated_at=clock_timestamp() where id=$1",[ids.provider,ids.config]);
    await db.query("commit"); return ids;
  } catch(error){await db.query("rollback");throw error;}
}
export function syntheticProof(pin) {
  return {checkKind:"fresh_tls_provider_identity_and_paused_state",checkedAt:new Date().toISOString(),host:pin.targetHost,
    databaseName:pin.databaseName,appRole:`packscout_${pin.providerKey}_app`,providerId:pin.providerId,providerKey:pin.providerKey,
    configId:pin.configId,configVersion:pin.configVersion,databaseRole:"provider",schemaVersion:"distributed-provider-v1",
    runtimeProviderId:pin.providerId,runtimeProviderKey:pin.providerKey,runtimeState:"paused",runtimeVersion:"5",generation:"3",
    activeRuns:0,actionableCommands:0,ownedLeases:0,encrypted:true,authorized:true,tlsVersion:"TLSv1.3"};
}
