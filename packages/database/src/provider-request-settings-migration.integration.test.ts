import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool } from "pg";
import { createRequestSettingsHarness } from "./provider-request-settings.test-support.ts";

test("migration validation works before app grants and cannot be bypassed with temporary table shadowing", async () => {
  const h = await createRequestSettingsHarness();
  const suffix = randomBytes(8).toString("hex");
  const appRole = `request_size_app_${suffix}`; const ownerRole = `request_size_owner_${suffix}`;
  const appPassword = randomBytes(32).toString("hex");
  const admin = new Pool({ connectionString: process.env.PACKSCOUT_TEST_ADMIN_DATABASE_URL, max: 1 });
  const appUrl = new URL(h.databaseUrl); appUrl.username = appRole; appUrl.password = appPassword;
  const app = new Pool({ connectionString: appUrl.toString(), max: 1 });
  try {
    // These exact generated identifiers exist only in this disposable cluster.
    await admin.query(`create role "${ownerRole}" nologin nosuperuser`);
    await admin.query(`create role "${appRole}" login nosuperuser password '${appPassword}'`);
    await h.client.$executeRawUnsafe(`grant usage on schema public to "${ownerRole}", "${appRole}"`);
    await h.client.$executeRawUnsafe(`grant select on public.provider_request_settings, public.provider_runs to "${ownerRole}"`);
    await h.client.$executeRawUnsafe(`alter function public.packscout_guard_run_request_settings() owner to "${ownerRole}"`);
    await h.client.$executeRawUnsafe(`grant select, insert on public.provider_runs to "${appRole}"`);
    await h.client.$executeRawUnsafe(`grant select on public.provider_run_pages to "${appRole}"`);
    const authority = await app.query<{ can_read_settings: boolean; can_execute_guard: boolean; owner_is_app: boolean;
      owner_superuser: boolean; owner_login: boolean; security_definer: boolean; configuration: string[] }>(`
      select has_table_privilege(current_user,'public.provider_request_settings','select') as can_read_settings,
        has_function_privilege(current_user,'public.packscout_guard_run_request_settings()','execute') as can_execute_guard,
        owner.rolname=current_user as owner_is_app, owner.rolsuper as owner_superuser, owner.rolcanlogin as owner_login,
        proc.prosecdef as security_definer, proc.proconfig as configuration
      from pg_proc proc join pg_roles owner on owner.oid=proc.proowner
      where proc.oid='public.packscout_guard_run_request_settings()'::regprocedure`);
    assert.deepEqual(authority.rows, [{ can_read_settings: false, can_execute_guard: false, owner_is_app: false,
      owner_superuser: false, owner_login: false, security_definer: true, configuration: ["search_path=pg_catalog, pg_temp"] }]);
    const insertOldRun = () => app.query(`insert into public.provider_runs
      (id,idempotency_key,trigger,state,config_version_id,config_version_number,worker_fence,requested_at,
       started_at,finished_at,failure_code,failure_class,failure_summary)
      values($1,$2,'scheduled','failed',$3,1,1,now(),now(),now(),'HISTORICAL_FAILURE','source','Synthetic fixture.')`,
    [randomUUID(), `old-worker/${randomUUID()}`, h.configId]);
    await insertOldRun();
    assert.equal(await h.client.provider_runs.count(), 1);
    const initialized = await h.settings.revise(h.reviseInput);
    assert.equal(initialized.kind, "updated");
    await assert.rejects(insertOldRun(), { code: "23514", message: "provider_run_request_settings_required" });
    await app.query("create temporary table provider_request_settings(active_revision_id uuid)");
    await app.query("set search_path=pg_temp,public");
    await assert.rejects(insertOldRun(), { code: "23514", message: "provider_run_request_settings_required" });
    assert.equal(await h.client.provider_runs.count(), 1);
    assert.equal(await h.client.provider_request_settings_revisions.count(), 1);
  } finally {
    await app.end(); await h.close();
    await admin.query(`drop role if exists "${appRole}", "${ownerRole}"`);
    await admin.end();
  }
});
