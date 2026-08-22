-- Durable worker presence: one row per running worker instance, keyed by the same
-- identity the instance stamps as provider_schedules.claim_owner and
-- import_runs.lease_owner. Consumers join on that identity and derive
-- stale/presumed-dead from heartbeat age; no foreign keys are declared so
-- presence reporting can never fail on tenant data and pruning stays unblocked.

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', 'public', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: worker_activity_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.worker_activity_kind AS ENUM (
    'idle',
    'scheduling',
    'importing',
    'estimated_ev',
    'retention'
);


--
-- Name: worker_instance_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.worker_instance_state AS ENUM (
    'running',
    'stopped'
);


--
-- Name: worker_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.worker_instances (
    instance_id text NOT NULL,
    state public.worker_instance_state DEFAULT 'running'::public.worker_instance_state NOT NULL,
    version text NOT NULL,
    host text NOT NULL,
    runtime_version text NOT NULL,
    started_at timestamp with time zone NOT NULL,
    last_heartbeat_at timestamp with time zone NOT NULL,
    stopped_at timestamp with time zone,
    activity_kind public.worker_activity_kind DEFAULT 'idle'::public.worker_activity_kind NOT NULL,
    activity_organization_id uuid,
    activity_provider_id uuid,
    activity_run_id uuid,
    activity_started_at timestamp with time zone,
    heartbeat_interval_ms integer NOT NULL,
    presence_stale_after_ms integer NOT NULL,
    run_heartbeat_stale_after_ms integer NOT NULL,
    schedule_claim_lease_ms integer NOT NULL,
    import_run_lease_ms integer NOT NULL,
    protected_payload_retention_days integer NOT NULL,
    presence_retention_days integer NOT NULL,
    CONSTRAINT worker_instances_activity_bounded CHECK ((((activity_kind = 'idle'::public.worker_activity_kind) AND (activity_organization_id IS NULL) AND (activity_provider_id IS NULL) AND (activity_run_id IS NULL) AND (activity_started_at IS NULL)) OR ((activity_kind <> 'idle'::public.worker_activity_kind) AND (activity_started_at IS NOT NULL)))),
    CONSTRAINT worker_instances_activity_import_scoped CHECK (((activity_kind <> 'importing'::public.worker_activity_kind) OR ((activity_organization_id IS NOT NULL) AND (activity_provider_id IS NOT NULL) AND (activity_run_id IS NOT NULL)))),
    CONSTRAINT worker_instances_descriptor_bounded CHECK ((((length(instance_id) >= 1) AND (length(instance_id) <= 256)) AND ((length(version) >= 1) AND (length(version) <= 128)) AND ((length(host) >= 1) AND (length(host) <= 128)) AND ((length(runtime_version) >= 1) AND (length(runtime_version) <= 64)))),
    CONSTRAINT worker_instances_heartbeat_ordered CHECK ((last_heartbeat_at >= started_at)),
    CONSTRAINT worker_instances_retention_bounded CHECK ((((protected_payload_retention_days >= 1) AND (protected_payload_retention_days <= 3650)) AND ((presence_retention_days >= 1) AND (presence_retention_days <= 3650)))),
    CONSTRAINT worker_instances_settings_bounded CHECK ((((heartbeat_interval_ms >= 1000) AND (heartbeat_interval_ms <= 300000)) AND (presence_stale_after_ms > heartbeat_interval_ms) AND (presence_stale_after_ms <= 86400000) AND ((run_heartbeat_stale_after_ms >= 1000) AND (run_heartbeat_stale_after_ms <= 86400000)) AND ((schedule_claim_lease_ms >= 1000) AND (schedule_claim_lease_ms <= 3600000)) AND ((import_run_lease_ms >= 1000) AND (import_run_lease_ms <= 3600000)))),
    CONSTRAINT worker_instances_stopped_consistent CHECK ((((state = 'stopped'::public.worker_instance_state) AND (stopped_at IS NOT NULL) AND (stopped_at >= started_at)) OR ((state = 'running'::public.worker_instance_state) AND (stopped_at IS NULL))))
);


--
-- Name: worker_instances worker_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.worker_instances
    ADD CONSTRAINT worker_instances_pkey PRIMARY KEY (instance_id);


--
-- Name: worker_instances_heartbeat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_instances_heartbeat_idx ON public.worker_instances USING btree (last_heartbeat_at);


--
-- Name: worker_instances_state_heartbeat_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX worker_instances_state_heartbeat_idx ON public.worker_instances USING btree (state, last_heartbeat_at);
