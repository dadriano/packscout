-- Clean empty-database baseline. Existing PackScout schemas are intentionally unsupported.

-- Dumped from database version 16.14 (Homebrew)
-- Dumped by pg_dump version 16.14 (Homebrew)

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
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--



--
-- Name: admin_alert_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.admin_alert_state AS ENUM (
    'active',
    'acknowledged',
    'resolved'
);


--
-- Name: audit_outcome; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.audit_outcome AS ENUM (
    'success',
    'failure',
    'blocked'
);


--
-- Name: canonical_record_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.canonical_record_kind AS ENUM (
    'platform',
    'pack',
    'catalog_asset',
    'ev_input',
    'pull',
    'sale',
    'estimated_ev'
);


--
-- Name: estimated_ev_recomputation_result; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estimated_ev_recomputation_result AS ENUM (
    'estimated',
    'unavailable'
);


--
-- Name: estimated_ev_recomputation_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.estimated_ev_recomputation_state AS ENUM (
    'queued',
    'running',
    'completed',
    'failed'
);


--
-- Name: import_run_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.import_run_state AS ENUM (
    'queued',
    'running',
    'succeeded',
    'incomplete',
    'failed'
);


--
-- Name: import_trigger; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.import_trigger AS ENUM (
    'scheduled',
    'manual',
    'recovery'
);


--
-- Name: operational_event_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operational_event_kind AS ENUM (
    'run_failed',
    'run_incomplete',
    'provider_stale',
    'provider_recovered',
    'quarantine_resolved',
    'quarantine_expired',
    'retention_failed',
    'retention_recovered'
);


--
-- Name: operational_severity; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operational_severity AS ENUM (
    'info',
    'warning',
    'critical'
);


--
-- Name: operator_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operator_role AS ENUM (
    'admin',
    'data_operator'
);


--
-- Name: operator_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.operator_state AS ENUM (
    'active',
    'disabled'
);


--
-- Name: provider_auth_mode; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provider_auth_mode AS ENUM (
    'none',
    'bearer'
);


--
-- Name: provider_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.provider_state AS ENUM (
    'draft',
    'active',
    'disabled',
    'archived'
);


--
-- Name: quarantine_attempt_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.quarantine_attempt_state AS ENUM (
    'running',
    'succeeded',
    'failed'
);


--
-- Name: quarantine_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.quarantine_state AS ENUM (
    'open',
    'resolved',
    'expired'
);


--
-- Name: retention_execution_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.retention_execution_state AS ENUM (
    'running',
    'succeeded',
    'failed'
);


--
-- Name: source_record_kind; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.source_record_kind AS ENUM (
    'catalog',
    'pull',
    'sale'
);


--
-- Name: source_record_outcome; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.source_record_outcome AS ENUM (
    'accepted',
    'duplicate',
    'quarantined'
);


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: admin_alerts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_alerts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    latest_event_id uuid NOT NULL,
    kind public.operational_event_kind NOT NULL,
    severity public.operational_severity NOT NULL,
    state public.admin_alert_state DEFAULT 'active'::public.admin_alert_state NOT NULL,
    dedupe_key text NOT NULL,
    recovery_key text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    provider_id uuid,
    run_id uuid,
    quarantine_id uuid,
    first_seen_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    occurrence_count integer DEFAULT 1 NOT NULL,
    reopened_count integer DEFAULT 0 NOT NULL,
    acknowledged_by_actor_key text,
    acknowledged_at timestamp with time zone,
    resolved_by_actor_key text,
    resolved_at timestamp with time zone,
    CONSTRAINT admin_alerts_acknowledgement_pair CHECK (((acknowledged_by_actor_key IS NULL) = (acknowledged_at IS NULL))),
    CONSTRAINT admin_alerts_copy_bounded CHECK ((((length(dedupe_key) >= 1) AND (length(dedupe_key) <= 256)) AND ((length(recovery_key) >= 1) AND (length(recovery_key) <= 256)) AND ((length(title) >= 1) AND (length(title) <= 160)) AND ((length(summary) >= 1) AND (length(summary) <= 500)))),
    CONSTRAINT admin_alerts_counts_positive CHECK (((occurrence_count > 0) AND (reopened_count >= 0))),
    CONSTRAINT admin_alerts_resolution_pair CHECK (((resolved_by_actor_key IS NULL) = (resolved_at IS NULL))),
    CONSTRAINT admin_alerts_run_provider_required CHECK (((run_id IS NULL) OR (provider_id IS NOT NULL)))
);


--
-- Name: audit_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.audit_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid,
    actor_key text NOT NULL,
    action text NOT NULL,
    subject_type text NOT NULL,
    subject_id uuid,
    outcome public.audit_outcome NOT NULL,
    metadata_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: auth_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.auth_rate_limits (
    bucket_key text NOT NULL,
    window_started_at timestamp with time zone NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    blocked_until timestamp with time zone,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT auth_rate_limits_attempt_count_nonnegative CHECK ((attempt_count >= 0))
);


--
-- Name: canonical_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_entities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    platform_key text NOT NULL,
    record_kind public.canonical_record_kind NOT NULL,
    external_id text NOT NULL,
    current_revision_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT canonical_entities_external_not_blank CHECK ((length(TRIM(BOTH FROM external_id)) > 0)),
    CONSTRAINT canonical_entities_platform_not_blank CHECK ((length(TRIM(BOTH FROM platform_key)) > 0))
);


--
-- Name: canonical_relationships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_relationships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    source_entity_id uuid NOT NULL,
    relationship_kind text NOT NULL,
    target_platform_key text NOT NULL,
    target_record_kind public.canonical_record_kind NOT NULL,
    target_external_id text,
    target_entity_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    resolved_at timestamp with time zone
);


--
-- Name: canonical_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.canonical_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    entity_id uuid NOT NULL,
    revision_number integer NOT NULL,
    source_record_id uuid NOT NULL,
    content_json jsonb NOT NULL,
    content_hash text NOT NULL,
    provenance_json jsonb NOT NULL,
    provenance_hash text NOT NULL,
    actor_key text,
    source_updated_at timestamp with time zone NOT NULL,
    source_collected_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT canonical_revisions_revision_positive CHECK ((revision_number > 0))
);


--
-- Name: estimated_ev_recomputation_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.estimated_ev_recomputation_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    request_key text NOT NULL,
    organization_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    configuration_revision_id uuid NOT NULL,
    platform_key text NOT NULL,
    pack_external_id text NOT NULL,
    ev_input_external_id text NOT NULL,
    pack_revision_id uuid,
    ev_input_revision_id uuid,
    state public.estimated_ev_recomputation_state DEFAULT 'queued'::public.estimated_ev_recomputation_state NOT NULL,
    result_status public.estimated_ev_recomputation_result,
    calculation_revision_id uuid,
    attempt_count integer DEFAULT 0 NOT NULL,
    available_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_by text,
    claim_token uuid,
    claim_expires_at timestamp with time zone,
    failure_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT estimated_ev_recomputation_attempt_nonnegative CHECK ((attempt_count >= 0)),
    CONSTRAINT estimated_ev_recomputation_claim_consistent CHECK ((((state = 'running'::public.estimated_ev_recomputation_state) AND (claimed_by IS NOT NULL) AND (claim_token IS NOT NULL) AND (claim_expires_at IS NOT NULL)) OR ((state <> 'running'::public.estimated_ev_recomputation_state) AND (claimed_by IS NULL) AND (claim_token IS NULL) AND (claim_expires_at IS NULL)))),
    CONSTRAINT estimated_ev_recomputation_claimed_by_bounded CHECK (((claimed_by IS NULL) OR (length(claimed_by) <= 256))),
    CONSTRAINT estimated_ev_recomputation_completion_consistent CHECK ((((state = 'completed'::public.estimated_ev_recomputation_state) AND (result_status IS NOT NULL) AND (calculation_revision_id IS NOT NULL) AND (completed_at IS NOT NULL)) OR ((state <> 'completed'::public.estimated_ev_recomputation_state) AND (result_status IS NULL) AND (calculation_revision_id IS NULL) AND (completed_at IS NULL)))),
    CONSTRAINT estimated_ev_recomputation_failure_bounded CHECK (((failure_code IS NULL) OR (length(failure_code) <= 128))),
    CONSTRAINT estimated_ev_recomputation_identity_not_blank CHECK (((length(TRIM(BOTH FROM platform_key)) > 0) AND (length(TRIM(BOTH FROM pack_external_id)) > 0) AND (length(TRIM(BOTH FROM ev_input_external_id)) > 0))),
    CONSTRAINT estimated_ev_recomputation_request_key_sha256 CHECK ((length(request_key) = 64))
);


--
-- Name: import_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    run_id uuid NOT NULL,
    page_number integer NOT NULL,
    requested_cursor text,
    next_cursor text,
    has_more boolean NOT NULL,
    payload_json jsonb,
    payload_hash text NOT NULL,
    record_counts_json jsonb NOT NULL,
    committed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    payload_expired_at timestamp with time zone,
    CONSTRAINT import_pages_cursors_bounded CHECK ((((requested_cursor IS NULL) OR (length(requested_cursor) <= 2048)) AND ((next_cursor IS NULL) OR (length(next_cursor) <= 2048)))),
    CONSTRAINT import_pages_page_number_positive CHECK ((page_number > 0))
);


--
-- Name: import_runs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.import_runs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    config_revision_id uuid NOT NULL,
    trigger public.import_trigger NOT NULL,
    state public.import_run_state DEFAULT 'queued'::public.import_run_state NOT NULL,
    requested_cursor text,
    final_cursor text,
    started_at timestamp with time zone,
    finished_at timestamp with time zone,
    heartbeat_at timestamp with time zone,
    counters_json jsonb DEFAULT '{"pages": 0, "records": 0, "accepted": 0, "duplicate": 0, "quarantined": 0, "requestAttempts": 0, "transientRetries": 0}'::jsonb NOT NULL,
    failure_code text,
    failure_summary text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    requested_by_actor_key text,
    lease_owner text,
    lease_expires_at timestamp with time zone,
    attempt integer DEFAULT 0 NOT NULL,
    reached_provider_head boolean DEFAULT false NOT NULL,
    CONSTRAINT import_runs_attempt_nonnegative CHECK ((attempt >= 0)),
    CONSTRAINT import_runs_failure_bounded CHECK ((((failure_code IS NULL) OR (length(failure_code) <= 128)) AND ((failure_summary IS NULL) OR (length(failure_summary) <= 500)))),
    CONSTRAINT import_runs_final_cursor_bounded CHECK (((final_cursor IS NULL) OR (length(final_cursor) <= 2048))),
    CONSTRAINT import_runs_lease_owner_bounded CHECK (((lease_owner IS NULL) OR (length(lease_owner) <= 256))),
    CONSTRAINT import_runs_manual_actor_required CHECK (((trigger <> 'manual'::public.import_trigger) OR (requested_by_actor_key IS NOT NULL))),
    CONSTRAINT import_runs_requested_cursor_bounded CHECK (((requested_cursor IS NULL) OR (length(requested_cursor) <= 2048)))
);


--
-- Name: operational_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operational_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    kind public.operational_event_kind NOT NULL,
    severity public.operational_severity NOT NULL,
    provider_id uuid,
    run_id uuid,
    quarantine_id uuid,
    dedupe_key text NOT NULL,
    recovery_key text NOT NULL,
    title text NOT NULL,
    summary text NOT NULL,
    evidence_json jsonb DEFAULT '{}'::jsonb NOT NULL,
    occurred_at timestamp with time zone NOT NULL,
    CONSTRAINT operational_events_copy_bounded CHECK ((((length(dedupe_key) >= 1) AND (length(dedupe_key) <= 256)) AND ((length(recovery_key) >= 1) AND (length(recovery_key) <= 256)) AND ((length(title) >= 1) AND (length(title) <= 160)) AND ((length(summary) >= 1) AND (length(summary) <= 500)))),
    CONSTRAINT operational_events_run_provider_required CHECK (((run_id IS NULL) OR (provider_id IS NOT NULL)))
);


--
-- Name: operator_memberships; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_memberships (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    operator_id uuid NOT NULL,
    role public.operator_role NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: operator_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operator_sessions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    operator_id uuid NOT NULL,
    token_hash text NOT NULL,
    csrf_hash text NOT NULL,
    idle_expires_at timestamp with time zone NOT NULL,
    absolute_expires_at timestamp with time zone NOT NULL,
    last_seen_at timestamp with time zone NOT NULL,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL,
    CONSTRAINT operator_sessions_expiry_order CHECK (((idle_expires_at <= absolute_expires_at) AND (created_at <= idle_expires_at)))
);


--
-- Name: operators; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.operators (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email_normalized text NOT NULL,
    display_name text NOT NULL,
    password_hash text NOT NULL,
    state public.operator_state DEFAULT 'active'::public.operator_state NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT operators_display_name_not_blank CHECK ((length(TRIM(BOTH FROM display_name)) > 0)),
    CONSTRAINT operators_email_is_normalized CHECK ((email_normalized = lower(TRIM(BOTH FROM email_normalized))))
);


--
-- Name: organizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.organizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: provider_config_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_config_revisions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    version integer NOT NULL,
    adapter_key text NOT NULL,
    endpoint_url text NOT NULL,
    auth_mode public.provider_auth_mode NOT NULL,
    schedule_seconds integer DEFAULT 300 NOT NULL,
    stale_after_seconds integer DEFAULT 900 NOT NULL,
    tested_at timestamp with time zone,
    tested_by_actor_key text,
    created_by_actor_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_config_revisions_schedule_safe CHECK ((schedule_seconds >= 60)),
    CONSTRAINT provider_config_revisions_stale_positive CHECK ((stale_after_seconds > 0))
);


--
-- Name: provider_connection_tests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_connection_tests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    outcome text NOT NULL,
    latency_ms integer,
    sanitized_code text,
    tested_by_actor_key text NOT NULL,
    tested_at timestamp with time zone DEFAULT now() NOT NULL,
    response_status integer,
    record_counts_json jsonb,
    has_more boolean,
    next_cursor_present boolean,
    CONSTRAINT provider_connection_tests_latency_nonnegative CHECK (((latency_ms IS NULL) OR (latency_ms >= 0))),
    CONSTRAINT provider_connection_tests_response_status_valid CHECK (((response_status IS NULL) OR ((response_status >= 100) AND (response_status <= 599))))
);


--
-- Name: provider_cursor_checkpoints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_cursor_checkpoints (
    config_revision_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    cursor text,
    advanced_by_run_id uuid,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_cursor_checkpoints_cursor_bounded CHECK (((cursor IS NULL) OR (length(cursor) <= 2048)))
);


--
-- Name: provider_health_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_health_states (
    provider_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    last_attempted_at timestamp with time zone,
    last_head_reached_at timestamp with time zone,
    consecutive_failures integer DEFAULT 0 NOT NULL,
    latest_failure_code text,
    recovered_at timestamp with time zone,
    latest_mapping_warning_at timestamp with time zone,
    mapping_warning_severity text,
    mapping_warning_active boolean DEFAULT false NOT NULL,
    latest_calculation_warning_at timestamp with time zone,
    calculation_warning_severity text,
    calculation_warning_active boolean DEFAULT false NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT provider_health_states_calculation_active_complete CHECK (((NOT calculation_warning_active) OR ((latest_calculation_warning_at IS NOT NULL) AND (calculation_warning_severity IS NOT NULL)))),
    CONSTRAINT provider_health_states_calculation_severity_known CHECK (((calculation_warning_severity IS NULL) OR (calculation_warning_severity = ANY (ARRAY['warning'::text, 'degraded'::text])))),
    CONSTRAINT provider_health_states_failure_code_bounded CHECK (((latest_failure_code IS NULL) OR ((length(latest_failure_code) >= 1) AND (length(latest_failure_code) <= 128)))),
    CONSTRAINT provider_health_states_failure_count_nonnegative CHECK ((consecutive_failures >= 0)),
    CONSTRAINT provider_health_states_mapping_active_complete CHECK (((NOT mapping_warning_active) OR ((latest_mapping_warning_at IS NOT NULL) AND (mapping_warning_severity IS NOT NULL)))),
    CONSTRAINT provider_health_states_mapping_severity_known CHECK (((mapping_warning_severity IS NULL) OR (mapping_warning_severity = ANY (ARRAY['warning'::text, 'degraded'::text]))))
);


--
-- Name: provider_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_schedules (
    provider_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    config_revision_id uuid NOT NULL,
    next_due_at timestamp with time zone NOT NULL,
    claim_owner text,
    claim_expires_at timestamp with time zone,
    last_claimed_at timestamp with time zone,
    last_outcome text,
    last_run_id uuid,
    updated_at timestamp with time zone NOT NULL,
    CONSTRAINT provider_schedules_claim_owner_bounded CHECK (((claim_owner IS NULL) OR ((length(claim_owner) >= 1) AND (length(claim_owner) <= 256)))),
    CONSTRAINT provider_schedules_claim_pair CHECK (((claim_owner IS NULL) = (claim_expires_at IS NULL))),
    CONSTRAINT provider_schedules_outcome_known CHECK (((last_outcome IS NULL) OR (last_outcome = ANY (ARRAY['started'::text, 'coalesced'::text, 'not_enabled'::text]))))
);


--
-- Name: provider_secret_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_secret_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    revision_id uuid NOT NULL,
    ciphertext bytea NOT NULL,
    nonce bytea NOT NULL,
    auth_tag bytea NOT NULL,
    key_version integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    retired_at timestamp with time zone,
    CONSTRAINT provider_secret_versions_key_version_positive CHECK ((key_version > 0))
);


--
-- Name: provider_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    platform_key text NOT NULL,
    display_name text NOT NULL,
    state public.provider_state DEFAULT 'draft'::public.provider_state NOT NULL,
    active_revision_id uuid,
    next_run_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT provider_sources_platform_key_not_blank CHECK ((length(TRIM(BOTH FROM platform_key)) > 0))
);


--
-- Name: quarantine_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quarantine_attempts (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    quarantine_id uuid NOT NULL,
    source_record_id uuid,
    state public.quarantine_attempt_state DEFAULT 'running'::public.quarantine_attempt_state NOT NULL,
    requested_by_actor_key text NOT NULL,
    failure_code text,
    field_path text,
    sanitized_summary text,
    canonical_revision_count integer,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT quarantine_attempts_actor_key_bounded CHECK (((length(requested_by_actor_key) >= 1) AND (length(requested_by_actor_key) <= 256))),
    CONSTRAINT quarantine_attempts_failure_bounded CHECK ((((failure_code IS NULL) OR (length(failure_code) <= 128)) AND ((field_path IS NULL) OR (length(field_path) <= 256)) AND ((sanitized_summary IS NULL) OR (length(sanitized_summary) <= 500)))),
    CONSTRAINT quarantine_attempts_revision_count_nonnegative CHECK (((canonical_revision_count IS NULL) OR (canonical_revision_count >= 0)))
);


--
-- Name: quarantine_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.quarantine_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    source_record_id uuid,
    record_kind public.source_record_kind NOT NULL,
    external_id text,
    state public.quarantine_state DEFAULT 'open'::public.quarantine_state NOT NULL,
    reason_code text NOT NULL,
    field_path text,
    sanitized_summary text NOT NULL,
    payload_json jsonb,
    retry_count integer DEFAULT 0 NOT NULL,
    last_retry_at timestamp with time zone,
    resolved_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    payload_expired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    run_id uuid NOT NULL,
    page_id uuid NOT NULL,
    record_index integer NOT NULL,
    CONSTRAINT quarantine_records_record_index_nonnegative CHECK ((record_index >= 0))
);


--
-- Name: retention_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.retention_executions (
    id uuid NOT NULL,
    organization_id uuid NOT NULL,
    state public.retention_execution_state DEFAULT 'running'::public.retention_execution_state NOT NULL,
    cutoff_at timestamp with time zone NOT NULL,
    batch_size integer NOT NULL,
    selected_count integer DEFAULT 0 NOT NULL,
    expired_count integer DEFAULT 0 NOT NULL,
    already_expired_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    remaining_count integer DEFAULT 0 NOT NULL,
    pages_expired_count integer DEFAULT 0 NOT NULL,
    source_records_expired_count integer DEFAULT 0 NOT NULL,
    quarantines_expired_count integer DEFAULT 0 NOT NULL,
    failure_code text,
    sanitized_summary text,
    started_at timestamp with time zone NOT NULL,
    finished_at timestamp with time zone,
    CONSTRAINT retention_executions_batch_size_bounded CHECK (((batch_size >= 1) AND (batch_size <= 10000))),
    CONSTRAINT retention_executions_counts_nonnegative CHECK (((selected_count >= 0) AND (expired_count >= 0) AND (already_expired_count >= 0) AND (failed_count >= 0) AND (remaining_count >= 0) AND (pages_expired_count >= 0) AND (source_records_expired_count >= 0) AND (quarantines_expired_count >= 0))),
    CONSTRAINT retention_executions_failure_bounded CHECK ((((failure_code IS NULL) OR ((length(failure_code) >= 1) AND (length(failure_code) <= 128))) AND ((sanitized_summary IS NULL) OR ((length(sanitized_summary) >= 1) AND (length(sanitized_summary) <= 500)))))
);


--
-- Name: source_record_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_record_observations (
    id bigint NOT NULL,
    source_record_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    run_id uuid NOT NULL,
    page_id uuid NOT NULL,
    observed_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: source_record_observations_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.source_record_observations ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.source_record_observations_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: source_record_outcomes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_record_outcomes (
    id bigint NOT NULL,
    organization_id uuid NOT NULL,
    run_id uuid NOT NULL,
    page_id uuid NOT NULL,
    source_record_id uuid,
    record_kind public.source_record_kind NOT NULL,
    external_id text,
    outcome public.source_record_outcome NOT NULL,
    reason_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    record_index integer NOT NULL,
    CONSTRAINT source_record_outcomes_record_index_nonnegative CHECK ((record_index >= 0))
);


--
-- Name: source_record_outcomes_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.source_record_outcomes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.source_record_outcomes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: source_record_projection_revisions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_record_projection_revisions (
    source_record_id uuid NOT NULL,
    canonical_revision_id uuid NOT NULL,
    organization_id uuid NOT NULL,
    projection_index integer NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_record_projection_revisions_projection_index_nonnegative CHECK ((projection_index >= 0))
);


--
-- Name: source_records; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.source_records (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    organization_id uuid NOT NULL,
    provider_id uuid NOT NULL,
    first_run_id uuid NOT NULL,
    first_page_id uuid NOT NULL,
    record_kind public.source_record_kind NOT NULL,
    external_id text NOT NULL,
    source_time timestamp with time zone NOT NULL,
    collected_at timestamp with time zone NOT NULL,
    payload_json jsonb,
    content_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    payload_expired_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT source_records_external_id_not_blank CHECK ((length(TRIM(BOTH FROM external_id)) > 0))
);


--
-- Name: admin_alerts admin_alerts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_alerts
    ADD CONSTRAINT admin_alerts_pkey PRIMARY KEY (id);


--
-- Name: audit_events audit_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_pkey PRIMARY KEY (id);


--
-- Name: auth_rate_limits auth_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.auth_rate_limits
    ADD CONSTRAINT auth_rate_limits_pkey PRIMARY KEY (bucket_key);


--
-- Name: canonical_entities canonical_entities_id_organization_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_entities
    ADD CONSTRAINT canonical_entities_id_organization_unique UNIQUE (id, organization_id);


--
-- Name: canonical_entities canonical_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_entities
    ADD CONSTRAINT canonical_entities_pkey PRIMARY KEY (id);


--
-- Name: canonical_relationships canonical_relationships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_relationships
    ADD CONSTRAINT canonical_relationships_pkey PRIMARY KEY (id);


--
-- Name: canonical_revisions canonical_revisions_id_entity_organization_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_revisions
    ADD CONSTRAINT canonical_revisions_id_entity_organization_unique UNIQUE (id, entity_id, organization_id);


--
-- Name: canonical_revisions canonical_revisions_id_organization_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_revisions
    ADD CONSTRAINT canonical_revisions_id_organization_unique UNIQUE (id, organization_id);


--
-- Name: canonical_revisions canonical_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_revisions
    ADD CONSTRAINT canonical_revisions_pkey PRIMARY KEY (id);


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_requests_pkey PRIMARY KEY (id);


--
-- Name: import_pages import_pages_id_organization_provider_run_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_pages
    ADD CONSTRAINT import_pages_id_organization_provider_run_unique UNIQUE (id, organization_id, provider_id, run_id);


--
-- Name: import_pages import_pages_id_organization_run_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_pages
    ADD CONSTRAINT import_pages_id_organization_run_unique UNIQUE (id, organization_id, run_id);


--
-- Name: import_pages import_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_pages
    ADD CONSTRAINT import_pages_pkey PRIMARY KEY (id);


--
-- Name: import_pages import_pages_run_cursor_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_pages
    ADD CONSTRAINT import_pages_run_cursor_unique UNIQUE NULLS NOT DISTINCT (run_id, requested_cursor);


--
-- Name: import_runs import_runs_id_organization_provider_config_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_id_organization_provider_config_unique UNIQUE (id, organization_id, provider_id, config_revision_id);


--
-- Name: import_runs import_runs_id_organization_provider_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_id_organization_provider_unique UNIQUE (id, organization_id, provider_id);


--
-- Name: import_runs import_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_pkey PRIMARY KEY (id);


--
-- Name: operational_events operational_events_id_organization_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_events
    ADD CONSTRAINT operational_events_id_organization_unique UNIQUE (id, organization_id);


--
-- Name: operational_events operational_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_events
    ADD CONSTRAINT operational_events_pkey PRIMARY KEY (id);


--
-- Name: operator_memberships operator_memberships_organization_operator_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_memberships
    ADD CONSTRAINT operator_memberships_organization_operator_unique UNIQUE (organization_id, operator_id);


--
-- Name: operator_memberships operator_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_memberships
    ADD CONSTRAINT operator_memberships_pkey PRIMARY KEY (id);


--
-- Name: operator_sessions operator_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_sessions
    ADD CONSTRAINT operator_sessions_pkey PRIMARY KEY (id);


--
-- Name: operators operators_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operators
    ADD CONSTRAINT operators_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_slug_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_slug_unique UNIQUE (slug);


--
-- Name: provider_config_revisions provider_config_revisions_id_provider_organization_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_config_revisions
    ADD CONSTRAINT provider_config_revisions_id_provider_organization_unique UNIQUE (id, provider_id, organization_id);


--
-- Name: provider_config_revisions provider_config_revisions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_config_revisions
    ADD CONSTRAINT provider_config_revisions_pkey PRIMARY KEY (id);


--
-- Name: provider_connection_tests provider_connection_tests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_connection_tests
    ADD CONSTRAINT provider_connection_tests_pkey PRIMARY KEY (id);


--
-- Name: provider_cursor_checkpoints provider_cursor_checkpoints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cursor_checkpoints
    ADD CONSTRAINT provider_cursor_checkpoints_pkey PRIMARY KEY (config_revision_id);


--
-- Name: provider_health_states provider_health_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_states
    ADD CONSTRAINT provider_health_states_pkey PRIMARY KEY (provider_id);


--
-- Name: provider_health_states provider_health_states_provider_tenant_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_states
    ADD CONSTRAINT provider_health_states_provider_tenant_unique UNIQUE (provider_id, organization_id);


--
-- Name: provider_schedules provider_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_schedules
    ADD CONSTRAINT provider_schedules_pkey PRIMARY KEY (provider_id);


--
-- Name: provider_schedules provider_schedules_provider_tenant_revision_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_schedules
    ADD CONSTRAINT provider_schedules_provider_tenant_revision_unique UNIQUE (provider_id, organization_id, config_revision_id);


--
-- Name: provider_secret_versions provider_secret_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_secret_versions
    ADD CONSTRAINT provider_secret_versions_pkey PRIMARY KEY (id);


--
-- Name: provider_secret_versions provider_secret_versions_revision_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_secret_versions
    ADD CONSTRAINT provider_secret_versions_revision_unique UNIQUE (revision_id);


--
-- Name: provider_sources provider_sources_id_organization_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_sources
    ADD CONSTRAINT provider_sources_id_organization_unique UNIQUE (id, organization_id);


--
-- Name: provider_sources provider_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_sources
    ADD CONSTRAINT provider_sources_pkey PRIMARY KEY (id);


--
-- Name: quarantine_attempts quarantine_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_attempts
    ADD CONSTRAINT quarantine_attempts_pkey PRIMARY KEY (id);


--
-- Name: quarantine_records quarantine_records_id_organization_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_records
    ADD CONSTRAINT quarantine_records_id_organization_unique UNIQUE (id, organization_id);


--
-- Name: quarantine_records quarantine_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_records
    ADD CONSTRAINT quarantine_records_pkey PRIMARY KEY (id);


--
-- Name: retention_executions retention_executions_id_organization_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_executions
    ADD CONSTRAINT retention_executions_id_organization_unique UNIQUE (id, organization_id);


--
-- Name: retention_executions retention_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_executions
    ADD CONSTRAINT retention_executions_pkey PRIMARY KEY (id);


--
-- Name: source_record_observations source_record_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_observations
    ADD CONSTRAINT source_record_observations_pkey PRIMARY KEY (id);


--
-- Name: source_record_outcomes source_record_outcomes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes
    ADD CONSTRAINT source_record_outcomes_pkey PRIMARY KEY (id);


--
-- Name: source_records source_records_id_organization_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_id_organization_unique UNIQUE (id, organization_id);


--
-- Name: source_records source_records_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_pkey PRIMARY KEY (id);


--
-- Name: admin_alerts_organization_dedupe_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX admin_alerts_organization_dedupe_unique ON public.admin_alerts USING btree (organization_id, dedupe_key);


--
-- Name: admin_alerts_organization_state_seen_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX admin_alerts_organization_state_seen_idx ON public.admin_alerts USING btree (organization_id, state, last_seen_at);


--
-- Name: audit_events_organization_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX audit_events_organization_occurred_idx ON public.audit_events USING btree (organization_id, occurred_at);


--
-- Name: canonical_entities_current_revision_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_entities_current_revision_idx ON public.canonical_entities USING btree (current_revision_id);


--
-- Name: canonical_entities_stable_identity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX canonical_entities_stable_identity_unique ON public.canonical_entities USING btree (organization_id, platform_key, record_kind, external_id);


--
-- Name: canonical_relationships_source_kind_target_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX canonical_relationships_source_kind_target_unique ON public.canonical_relationships USING btree (source_entity_id, relationship_kind, target_platform_key, target_record_kind, target_external_id);


--
-- Name: canonical_relationships_unresolved_lookup_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_relationships_unresolved_lookup_idx ON public.canonical_relationships USING btree (organization_id, target_platform_key, target_record_kind, target_external_id, resolved_at);


--
-- Name: canonical_revisions_content_provenance_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX canonical_revisions_content_provenance_unique ON public.canonical_revisions USING btree (entity_id, content_hash, provenance_hash);


--
-- Name: canonical_revisions_entity_number_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX canonical_revisions_entity_number_unique ON public.canonical_revisions USING btree (entity_id, revision_number);


--
-- Name: canonical_revisions_organization_accepted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX canonical_revisions_organization_accepted_idx ON public.canonical_revisions USING btree (organization_id, accepted_at);


--
-- Name: estimated_ev_recomputation_claim_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimated_ev_recomputation_claim_idx ON public.estimated_ev_recomputation_requests USING btree (state, available_at, created_at, id);


--
-- Name: estimated_ev_recomputation_request_key_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX estimated_ev_recomputation_request_key_unique ON public.estimated_ev_recomputation_requests USING btree (request_key);


--
-- Name: estimated_ev_recomputation_tenant_pack_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX estimated_ev_recomputation_tenant_pack_idx ON public.estimated_ev_recomputation_requests USING btree (organization_id, platform_key, pack_external_id, created_at);


--
-- Name: import_pages_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_pages_expiry_idx ON public.import_pages USING btree (organization_id, expires_at);


--
-- Name: import_pages_run_number_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX import_pages_run_number_unique ON public.import_pages USING btree (run_id, page_number);


--
-- Name: import_runs_organization_provider_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX import_runs_organization_provider_created_idx ON public.import_runs USING btree (organization_id, provider_id, created_at);


--
-- Name: import_runs_provider_active_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX import_runs_provider_active_unique ON public.import_runs USING btree (organization_id, provider_id) WHERE (state = ANY (ARRAY['queued'::public.import_run_state, 'running'::public.import_run_state]));


--
-- Name: operational_events_organization_dedupe_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operational_events_organization_dedupe_idx ON public.operational_events USING btree (organization_id, dedupe_key, occurred_at);


--
-- Name: operational_events_organization_occurred_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operational_events_organization_occurred_idx ON public.operational_events USING btree (organization_id, occurred_at);


--
-- Name: operator_memberships_operator_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_memberships_operator_idx ON public.operator_memberships USING btree (operator_id);


--
-- Name: operator_sessions_active_token_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_sessions_active_token_idx ON public.operator_sessions USING btree (token_hash) WHERE (revoked_at IS NULL);


--
-- Name: operator_sessions_operator_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX operator_sessions_operator_idx ON public.operator_sessions USING btree (operator_id, created_at);


--
-- Name: operator_sessions_token_hash_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operator_sessions_token_hash_unique ON public.operator_sessions USING btree (token_hash);


--
-- Name: operators_email_normalized_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX operators_email_normalized_unique ON public.operators USING btree (email_normalized);


--
-- Name: provider_config_revisions_provider_version_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_config_revisions_provider_version_unique ON public.provider_config_revisions USING btree (provider_id, version);


--
-- Name: provider_connection_tests_provider_tested_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_connection_tests_provider_tested_idx ON public.provider_connection_tests USING btree (provider_id, tested_at);


--
-- Name: provider_cursor_checkpoints_organization_provider_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_cursor_checkpoints_organization_provider_idx ON public.provider_cursor_checkpoints USING btree (organization_id, provider_id);


--
-- Name: provider_schedules_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_schedules_due_idx ON public.provider_schedules USING btree (organization_id, next_due_at);


--
-- Name: provider_secret_versions_provider_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX provider_secret_versions_provider_created_idx ON public.provider_secret_versions USING btree (organization_id, provider_id, created_at);


--
-- Name: provider_sources_organization_platform_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX provider_sources_organization_platform_unique ON public.provider_sources USING btree (organization_id, platform_key);


--
-- Name: quarantine_attempts_one_running_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quarantine_attempts_one_running_unique ON public.quarantine_attempts USING btree (quarantine_id) WHERE (state = 'running'::public.quarantine_attempt_state);


--
-- Name: quarantine_attempts_organization_quarantine_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quarantine_attempts_organization_quarantine_started_idx ON public.quarantine_attempts USING btree (organization_id, quarantine_id, started_at);


--
-- Name: quarantine_records_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quarantine_records_expiry_idx ON public.quarantine_records USING btree (organization_id, expires_at);


--
-- Name: quarantine_records_organization_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX quarantine_records_organization_state_idx ON public.quarantine_records USING btree (organization_id, state, created_at);


--
-- Name: quarantine_records_page_kind_index_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX quarantine_records_page_kind_index_unique ON public.quarantine_records USING btree (page_id, record_kind, record_index);


--
-- Name: retention_executions_organization_started_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX retention_executions_organization_started_idx ON public.retention_executions USING btree (organization_id, started_at);


--
-- Name: source_record_observations_organization_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_record_observations_organization_run_idx ON public.source_record_observations USING btree (organization_id, run_id);


--
-- Name: source_record_observations_record_run_page_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_record_observations_record_run_page_unique ON public.source_record_observations USING btree (source_record_id, run_id, page_id);


--
-- Name: source_record_outcomes_organization_run_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_record_outcomes_organization_run_idx ON public.source_record_outcomes USING btree (organization_id, run_id);


--
-- Name: source_record_outcomes_page_kind_index_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_record_outcomes_page_kind_index_unique ON public.source_record_outcomes USING btree (page_id, record_kind, record_index);


--
-- Name: source_record_projection_revisions_pair_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_record_projection_revisions_pair_unique ON public.source_record_projection_revisions USING btree (source_record_id, canonical_revision_id);


--
-- Name: source_record_projection_revisions_source_projection_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_record_projection_revisions_source_projection_unique ON public.source_record_projection_revisions USING btree (source_record_id, projection_index);


--
-- Name: source_records_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX source_records_expiry_idx ON public.source_records USING btree (organization_id, expires_at);


--
-- Name: source_records_immutable_identity_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX source_records_immutable_identity_unique ON public.source_records USING btree (organization_id, provider_id, record_kind, external_id, source_time, content_hash);


--
-- Name: admin_alerts admin_alerts_latest_event_id_operational_events_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_alerts
    ADD CONSTRAINT admin_alerts_latest_event_id_operational_events_id_fk FOREIGN KEY (latest_event_id) REFERENCES public.operational_events(id) ON DELETE RESTRICT;


--
-- Name: admin_alerts admin_alerts_latest_event_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_alerts
    ADD CONSTRAINT admin_alerts_latest_event_tenant_fk FOREIGN KEY (latest_event_id, organization_id) REFERENCES public.operational_events(id, organization_id) ON DELETE RESTRICT;


--
-- Name: admin_alerts admin_alerts_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_alerts
    ADD CONSTRAINT admin_alerts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: admin_alerts admin_alerts_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_alerts
    ADD CONSTRAINT admin_alerts_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: admin_alerts admin_alerts_provider_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_alerts
    ADD CONSTRAINT admin_alerts_provider_tenant_fk FOREIGN KEY (provider_id, organization_id) REFERENCES public.provider_sources(id, organization_id) ON DELETE RESTRICT;


--
-- Name: admin_alerts admin_alerts_quarantine_id_quarantine_records_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_alerts
    ADD CONSTRAINT admin_alerts_quarantine_id_quarantine_records_id_fk FOREIGN KEY (quarantine_id) REFERENCES public.quarantine_records(id) ON DELETE RESTRICT;


--
-- Name: admin_alerts admin_alerts_quarantine_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_alerts
    ADD CONSTRAINT admin_alerts_quarantine_tenant_fk FOREIGN KEY (quarantine_id, organization_id) REFERENCES public.quarantine_records(id, organization_id) ON DELETE RESTRICT;


--
-- Name: admin_alerts admin_alerts_run_id_import_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_alerts
    ADD CONSTRAINT admin_alerts_run_id_import_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.import_runs(id) ON DELETE RESTRICT;


--
-- Name: admin_alerts admin_alerts_run_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_alerts
    ADD CONSTRAINT admin_alerts_run_tenant_fk FOREIGN KEY (run_id, organization_id, provider_id) REFERENCES public.import_runs(id, organization_id, provider_id) ON DELETE RESTRICT;


--
-- Name: audit_events audit_events_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.audit_events
    ADD CONSTRAINT audit_events_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: canonical_entities canonical_entities_current_revision_id_canonical_revisions_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_entities
    ADD CONSTRAINT canonical_entities_current_revision_id_canonical_revisions_id_f FOREIGN KEY (current_revision_id) REFERENCES public.canonical_revisions(id) ON DELETE RESTRICT;


--
-- Name: canonical_entities canonical_entities_current_revision_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_entities
    ADD CONSTRAINT canonical_entities_current_revision_scope_fk FOREIGN KEY (current_revision_id, id, organization_id) REFERENCES public.canonical_revisions(id, entity_id, organization_id) ON DELETE RESTRICT;


--
-- Name: canonical_entities canonical_entities_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_entities
    ADD CONSTRAINT canonical_entities_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: canonical_relationships canonical_relationships_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_relationships
    ADD CONSTRAINT canonical_relationships_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: canonical_relationships canonical_relationships_source_entity_id_canonical_entities_id_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_relationships
    ADD CONSTRAINT canonical_relationships_source_entity_id_canonical_entities_id_ FOREIGN KEY (source_entity_id) REFERENCES public.canonical_entities(id) ON DELETE RESTRICT;


--
-- Name: canonical_relationships canonical_relationships_source_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_relationships
    ADD CONSTRAINT canonical_relationships_source_tenant_fk FOREIGN KEY (source_entity_id, organization_id) REFERENCES public.canonical_entities(id, organization_id) ON DELETE RESTRICT;


--
-- Name: canonical_relationships canonical_relationships_target_entity_id_canonical_entities_id_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_relationships
    ADD CONSTRAINT canonical_relationships_target_entity_id_canonical_entities_id_ FOREIGN KEY (target_entity_id) REFERENCES public.canonical_entities(id) ON DELETE RESTRICT;


--
-- Name: canonical_relationships canonical_relationships_target_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_relationships
    ADD CONSTRAINT canonical_relationships_target_tenant_fk FOREIGN KEY (target_entity_id, organization_id) REFERENCES public.canonical_entities(id, organization_id) ON DELETE RESTRICT;


--
-- Name: canonical_revisions canonical_revisions_entity_id_canonical_entities_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_revisions
    ADD CONSTRAINT canonical_revisions_entity_id_canonical_entities_id_fk FOREIGN KEY (entity_id) REFERENCES public.canonical_entities(id) ON DELETE RESTRICT;


--
-- Name: canonical_revisions canonical_revisions_entity_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_revisions
    ADD CONSTRAINT canonical_revisions_entity_tenant_fk FOREIGN KEY (entity_id, organization_id) REFERENCES public.canonical_entities(id, organization_id) ON DELETE RESTRICT;


--
-- Name: canonical_revisions canonical_revisions_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_revisions
    ADD CONSTRAINT canonical_revisions_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: canonical_revisions canonical_revisions_source_record_id_source_records_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_revisions
    ADD CONSTRAINT canonical_revisions_source_record_id_source_records_id_fk FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE RESTRICT;


--
-- Name: canonical_revisions canonical_revisions_source_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.canonical_revisions
    ADD CONSTRAINT canonical_revisions_source_tenant_fk FOREIGN KEY (source_record_id, organization_id) REFERENCES public.source_records(id, organization_id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_calculation_revision_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_calculation_revision_tenant_fk FOREIGN KEY (calculation_revision_id, organization_id) REFERENCES public.canonical_revisions(id, organization_id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_config_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_config_tenant_fk FOREIGN KEY (configuration_revision_id, provider_id, organization_id) REFERENCES public.provider_config_revisions(id, provider_id, organization_id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_input_revision_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_input_revision_tenant_fk FOREIGN KEY (ev_input_revision_id, organization_id) REFERENCES public.canonical_revisions(id, organization_id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_pack_revision_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_pack_revision_tenant_fk FOREIGN KEY (pack_revision_id, organization_id) REFERENCES public.canonical_revisions(id, organization_id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_provider_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_provider_tenant_fk FOREIGN KEY (provider_id, organization_id) REFERENCES public.provider_sources(id, organization_id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_requests_calculation_revision_id_can; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_requests_calculation_revision_id_can FOREIGN KEY (calculation_revision_id) REFERENCES public.canonical_revisions(id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_requests_configuration_revision_id_p; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_requests_configuration_revision_id_p FOREIGN KEY (configuration_revision_id) REFERENCES public.provider_config_revisions(id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_requests_ev_input_revision_id_canoni; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_requests_ev_input_revision_id_canoni FOREIGN KEY (ev_input_revision_id) REFERENCES public.canonical_revisions(id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_requests_organization_id_organizatio; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_requests_organization_id_organizatio FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_requests_pack_revision_id_canonical_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_requests_pack_revision_id_canonical_ FOREIGN KEY (pack_revision_id) REFERENCES public.canonical_revisions(id) ON DELETE RESTRICT;


--
-- Name: estimated_ev_recomputation_requests estimated_ev_recomputation_requests_provider_id_provider_source; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.estimated_ev_recomputation_requests
    ADD CONSTRAINT estimated_ev_recomputation_requests_provider_id_provider_source FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: import_pages import_pages_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_pages
    ADD CONSTRAINT import_pages_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: import_pages import_pages_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_pages
    ADD CONSTRAINT import_pages_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: import_pages import_pages_run_id_import_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_pages
    ADD CONSTRAINT import_pages_run_id_import_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.import_runs(id) ON DELETE RESTRICT;


--
-- Name: import_pages import_pages_run_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_pages
    ADD CONSTRAINT import_pages_run_tenant_fk FOREIGN KEY (run_id, organization_id, provider_id) REFERENCES public.import_runs(id, organization_id, provider_id) ON DELETE RESTRICT;


--
-- Name: import_runs import_runs_config_provider_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_config_provider_tenant_fk FOREIGN KEY (config_revision_id, provider_id, organization_id) REFERENCES public.provider_config_revisions(id, provider_id, organization_id) ON DELETE RESTRICT;


--
-- Name: import_runs import_runs_config_revision_id_provider_config_revisions_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_config_revision_id_provider_config_revisions_id_fk FOREIGN KEY (config_revision_id) REFERENCES public.provider_config_revisions(id) ON DELETE RESTRICT;


--
-- Name: import_runs import_runs_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: import_runs import_runs_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: import_runs import_runs_provider_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.import_runs
    ADD CONSTRAINT import_runs_provider_tenant_fk FOREIGN KEY (provider_id, organization_id) REFERENCES public.provider_sources(id, organization_id) ON DELETE RESTRICT;


--
-- Name: operational_events operational_events_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_events
    ADD CONSTRAINT operational_events_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: operational_events operational_events_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_events
    ADD CONSTRAINT operational_events_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: operational_events operational_events_provider_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_events
    ADD CONSTRAINT operational_events_provider_tenant_fk FOREIGN KEY (provider_id, organization_id) REFERENCES public.provider_sources(id, organization_id) ON DELETE RESTRICT;


--
-- Name: operational_events operational_events_quarantine_id_quarantine_records_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_events
    ADD CONSTRAINT operational_events_quarantine_id_quarantine_records_id_fk FOREIGN KEY (quarantine_id) REFERENCES public.quarantine_records(id) ON DELETE RESTRICT;


--
-- Name: operational_events operational_events_quarantine_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_events
    ADD CONSTRAINT operational_events_quarantine_tenant_fk FOREIGN KEY (quarantine_id, organization_id) REFERENCES public.quarantine_records(id, organization_id) ON DELETE RESTRICT;


--
-- Name: operational_events operational_events_run_id_import_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_events
    ADD CONSTRAINT operational_events_run_id_import_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.import_runs(id) ON DELETE RESTRICT;


--
-- Name: operational_events operational_events_run_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operational_events
    ADD CONSTRAINT operational_events_run_tenant_fk FOREIGN KEY (run_id, organization_id, provider_id) REFERENCES public.import_runs(id, organization_id, provider_id) ON DELETE RESTRICT;


--
-- Name: operator_memberships operator_memberships_operator_id_operators_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_memberships
    ADD CONSTRAINT operator_memberships_operator_id_operators_id_fk FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE RESTRICT;


--
-- Name: operator_memberships operator_memberships_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_memberships
    ADD CONSTRAINT operator_memberships_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: operator_sessions operator_sessions_membership_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_sessions
    ADD CONSTRAINT operator_sessions_membership_fk FOREIGN KEY (organization_id, operator_id) REFERENCES public.operator_memberships(organization_id, operator_id) ON DELETE RESTRICT;


--
-- Name: operator_sessions operator_sessions_operator_id_operators_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_sessions
    ADD CONSTRAINT operator_sessions_operator_id_operators_id_fk FOREIGN KEY (operator_id) REFERENCES public.operators(id) ON DELETE RESTRICT;


--
-- Name: operator_sessions operator_sessions_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.operator_sessions
    ADD CONSTRAINT operator_sessions_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: provider_config_revisions provider_config_revisions_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_config_revisions
    ADD CONSTRAINT provider_config_revisions_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: provider_config_revisions provider_config_revisions_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_config_revisions
    ADD CONSTRAINT provider_config_revisions_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: provider_config_revisions provider_config_revisions_provider_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_config_revisions
    ADD CONSTRAINT provider_config_revisions_provider_tenant_fk FOREIGN KEY (provider_id, organization_id) REFERENCES public.provider_sources(id, organization_id) ON DELETE RESTRICT;


--
-- Name: provider_connection_tests provider_connection_tests_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_connection_tests
    ADD CONSTRAINT provider_connection_tests_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: provider_connection_tests provider_connection_tests_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_connection_tests
    ADD CONSTRAINT provider_connection_tests_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: provider_connection_tests provider_connection_tests_revision_id_provider_config_revisions; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_connection_tests
    ADD CONSTRAINT provider_connection_tests_revision_id_provider_config_revisions FOREIGN KEY (revision_id) REFERENCES public.provider_config_revisions(id) ON DELETE RESTRICT;


--
-- Name: provider_connection_tests provider_connection_tests_revision_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_connection_tests
    ADD CONSTRAINT provider_connection_tests_revision_tenant_fk FOREIGN KEY (revision_id, provider_id, organization_id) REFERENCES public.provider_config_revisions(id, provider_id, organization_id) ON DELETE RESTRICT;


--
-- Name: provider_cursor_checkpoints provider_cursor_checkpoints_advanced_by_run_id_import_runs_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cursor_checkpoints
    ADD CONSTRAINT provider_cursor_checkpoints_advanced_by_run_id_import_runs_id_f FOREIGN KEY (advanced_by_run_id) REFERENCES public.import_runs(id) ON DELETE RESTRICT;


--
-- Name: provider_cursor_checkpoints provider_cursor_checkpoints_config_revision_id_provider_config_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cursor_checkpoints
    ADD CONSTRAINT provider_cursor_checkpoints_config_revision_id_provider_config_ FOREIGN KEY (config_revision_id) REFERENCES public.provider_config_revisions(id) ON DELETE RESTRICT;


--
-- Name: provider_cursor_checkpoints provider_cursor_checkpoints_config_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cursor_checkpoints
    ADD CONSTRAINT provider_cursor_checkpoints_config_tenant_fk FOREIGN KEY (config_revision_id, provider_id, organization_id) REFERENCES public.provider_config_revisions(id, provider_id, organization_id) ON DELETE RESTRICT;


--
-- Name: provider_cursor_checkpoints provider_cursor_checkpoints_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cursor_checkpoints
    ADD CONSTRAINT provider_cursor_checkpoints_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: provider_cursor_checkpoints provider_cursor_checkpoints_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cursor_checkpoints
    ADD CONSTRAINT provider_cursor_checkpoints_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: provider_cursor_checkpoints provider_cursor_checkpoints_run_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_cursor_checkpoints
    ADD CONSTRAINT provider_cursor_checkpoints_run_tenant_fk FOREIGN KEY (advanced_by_run_id, organization_id, provider_id) REFERENCES public.import_runs(id, organization_id, provider_id) ON DELETE RESTRICT;


--
-- Name: provider_health_states provider_health_states_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_states
    ADD CONSTRAINT provider_health_states_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: provider_health_states provider_health_states_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_states
    ADD CONSTRAINT provider_health_states_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: provider_health_states provider_health_states_provider_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_health_states
    ADD CONSTRAINT provider_health_states_provider_tenant_fk FOREIGN KEY (provider_id, organization_id) REFERENCES public.provider_sources(id, organization_id) ON DELETE RESTRICT;


--
-- Name: provider_schedules provider_schedules_config_revision_id_provider_config_revisions; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_schedules
    ADD CONSTRAINT provider_schedules_config_revision_id_provider_config_revisions FOREIGN KEY (config_revision_id) REFERENCES public.provider_config_revisions(id) ON DELETE RESTRICT;


--
-- Name: provider_schedules provider_schedules_last_run_id_import_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_schedules
    ADD CONSTRAINT provider_schedules_last_run_id_import_runs_id_fk FOREIGN KEY (last_run_id) REFERENCES public.import_runs(id) ON DELETE RESTRICT;


--
-- Name: provider_schedules provider_schedules_last_run_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_schedules
    ADD CONSTRAINT provider_schedules_last_run_tenant_fk FOREIGN KEY (last_run_id, organization_id, provider_id) REFERENCES public.import_runs(id, organization_id, provider_id) ON DELETE RESTRICT;


--
-- Name: provider_schedules provider_schedules_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_schedules
    ADD CONSTRAINT provider_schedules_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: provider_schedules provider_schedules_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_schedules
    ADD CONSTRAINT provider_schedules_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: provider_schedules provider_schedules_provider_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_schedules
    ADD CONSTRAINT provider_schedules_provider_tenant_fk FOREIGN KEY (provider_id, organization_id) REFERENCES public.provider_sources(id, organization_id) ON DELETE RESTRICT;


--
-- Name: provider_schedules provider_schedules_revision_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_schedules
    ADD CONSTRAINT provider_schedules_revision_tenant_fk FOREIGN KEY (config_revision_id, provider_id, organization_id) REFERENCES public.provider_config_revisions(id, provider_id, organization_id) ON DELETE RESTRICT;


--
-- Name: provider_secret_versions provider_secret_versions_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_secret_versions
    ADD CONSTRAINT provider_secret_versions_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: provider_secret_versions provider_secret_versions_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_secret_versions
    ADD CONSTRAINT provider_secret_versions_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: provider_secret_versions provider_secret_versions_revision_id_provider_config_revisions_; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_secret_versions
    ADD CONSTRAINT provider_secret_versions_revision_id_provider_config_revisions_ FOREIGN KEY (revision_id) REFERENCES public.provider_config_revisions(id) ON DELETE RESTRICT;


--
-- Name: provider_secret_versions provider_secret_versions_revision_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_secret_versions
    ADD CONSTRAINT provider_secret_versions_revision_tenant_fk FOREIGN KEY (revision_id, provider_id, organization_id) REFERENCES public.provider_config_revisions(id, provider_id, organization_id) ON DELETE RESTRICT;


--
-- Name: provider_sources provider_sources_active_revision_id_provider_config_revisions_i; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_sources
    ADD CONSTRAINT provider_sources_active_revision_id_provider_config_revisions_i FOREIGN KEY (active_revision_id) REFERENCES public.provider_config_revisions(id) ON DELETE RESTRICT;


--
-- Name: provider_sources provider_sources_active_revision_scope_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_sources
    ADD CONSTRAINT provider_sources_active_revision_scope_fk FOREIGN KEY (active_revision_id, id, organization_id) REFERENCES public.provider_config_revisions(id, provider_id, organization_id) ON DELETE RESTRICT;


--
-- Name: provider_sources provider_sources_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_sources
    ADD CONSTRAINT provider_sources_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: quarantine_attempts quarantine_attempts_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_attempts
    ADD CONSTRAINT quarantine_attempts_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: quarantine_attempts quarantine_attempts_quarantine_id_quarantine_records_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_attempts
    ADD CONSTRAINT quarantine_attempts_quarantine_id_quarantine_records_id_fk FOREIGN KEY (quarantine_id) REFERENCES public.quarantine_records(id) ON DELETE RESTRICT;


--
-- Name: quarantine_attempts quarantine_attempts_quarantine_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_attempts
    ADD CONSTRAINT quarantine_attempts_quarantine_tenant_fk FOREIGN KEY (quarantine_id, organization_id) REFERENCES public.quarantine_records(id, organization_id) ON DELETE RESTRICT;


--
-- Name: quarantine_attempts quarantine_attempts_source_record_id_source_records_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_attempts
    ADD CONSTRAINT quarantine_attempts_source_record_id_source_records_id_fk FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE RESTRICT;


--
-- Name: quarantine_attempts quarantine_attempts_source_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_attempts
    ADD CONSTRAINT quarantine_attempts_source_tenant_fk FOREIGN KEY (source_record_id, organization_id) REFERENCES public.source_records(id, organization_id) ON DELETE RESTRICT;


--
-- Name: quarantine_records quarantine_records_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_records
    ADD CONSTRAINT quarantine_records_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: quarantine_records quarantine_records_page_id_import_pages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_records
    ADD CONSTRAINT quarantine_records_page_id_import_pages_id_fk FOREIGN KEY (page_id) REFERENCES public.import_pages(id) ON DELETE RESTRICT;


--
-- Name: quarantine_records quarantine_records_page_run_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_records
    ADD CONSTRAINT quarantine_records_page_run_tenant_fk FOREIGN KEY (page_id, organization_id, run_id) REFERENCES public.import_pages(id, organization_id, run_id) ON DELETE RESTRICT;


--
-- Name: quarantine_records quarantine_records_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_records
    ADD CONSTRAINT quarantine_records_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- Name: quarantine_records quarantine_records_provider_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_records
    ADD CONSTRAINT quarantine_records_provider_tenant_fk FOREIGN KEY (provider_id, organization_id) REFERENCES public.provider_sources(id, organization_id) ON DELETE RESTRICT;


--
-- Name: quarantine_records quarantine_records_run_id_import_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_records
    ADD CONSTRAINT quarantine_records_run_id_import_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.import_runs(id) ON DELETE RESTRICT;


--
-- Name: quarantine_records quarantine_records_source_record_id_source_records_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_records
    ADD CONSTRAINT quarantine_records_source_record_id_source_records_id_fk FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE RESTRICT;


--
-- Name: quarantine_records quarantine_records_source_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.quarantine_records
    ADD CONSTRAINT quarantine_records_source_tenant_fk FOREIGN KEY (source_record_id, organization_id) REFERENCES public.source_records(id, organization_id) ON DELETE RESTRICT;


--
-- Name: retention_executions retention_executions_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.retention_executions
    ADD CONSTRAINT retention_executions_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: source_record_observations source_record_observations_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_observations
    ADD CONSTRAINT source_record_observations_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: source_record_observations source_record_observations_page_id_import_pages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_observations
    ADD CONSTRAINT source_record_observations_page_id_import_pages_id_fk FOREIGN KEY (page_id) REFERENCES public.import_pages(id) ON DELETE RESTRICT;


--
-- Name: source_record_observations source_record_observations_page_run_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_observations
    ADD CONSTRAINT source_record_observations_page_run_tenant_fk FOREIGN KEY (page_id, organization_id, run_id) REFERENCES public.import_pages(id, organization_id, run_id) ON DELETE RESTRICT;


--
-- Name: source_record_observations source_record_observations_run_id_import_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_observations
    ADD CONSTRAINT source_record_observations_run_id_import_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.import_runs(id) ON DELETE RESTRICT;


--
-- Name: source_record_observations source_record_observations_source_record_id_source_records_id_f; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_observations
    ADD CONSTRAINT source_record_observations_source_record_id_source_records_id_f FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE RESTRICT;


--
-- Name: source_record_observations source_record_observations_source_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_observations
    ADD CONSTRAINT source_record_observations_source_tenant_fk FOREIGN KEY (source_record_id, organization_id) REFERENCES public.source_records(id, organization_id) ON DELETE RESTRICT;


--
-- Name: source_record_outcomes source_record_outcomes_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes
    ADD CONSTRAINT source_record_outcomes_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: source_record_outcomes source_record_outcomes_page_id_import_pages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes
    ADD CONSTRAINT source_record_outcomes_page_id_import_pages_id_fk FOREIGN KEY (page_id) REFERENCES public.import_pages(id) ON DELETE RESTRICT;


--
-- Name: source_record_outcomes source_record_outcomes_page_run_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes
    ADD CONSTRAINT source_record_outcomes_page_run_tenant_fk FOREIGN KEY (page_id, organization_id, run_id) REFERENCES public.import_pages(id, organization_id, run_id) ON DELETE RESTRICT;


--
-- Name: source_record_outcomes source_record_outcomes_run_id_import_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes
    ADD CONSTRAINT source_record_outcomes_run_id_import_runs_id_fk FOREIGN KEY (run_id) REFERENCES public.import_runs(id) ON DELETE RESTRICT;


--
-- Name: source_record_outcomes source_record_outcomes_source_record_id_source_records_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes
    ADD CONSTRAINT source_record_outcomes_source_record_id_source_records_id_fk FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE RESTRICT;


--
-- Name: source_record_outcomes source_record_outcomes_source_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_outcomes
    ADD CONSTRAINT source_record_outcomes_source_tenant_fk FOREIGN KEY (source_record_id, organization_id) REFERENCES public.source_records(id, organization_id) ON DELETE RESTRICT;


--
-- Name: source_record_projection_revisions source_record_projection_revisions_canonical_revision_id_canoni; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_projection_revisions
    ADD CONSTRAINT source_record_projection_revisions_canonical_revision_id_canoni FOREIGN KEY (canonical_revision_id) REFERENCES public.canonical_revisions(id) ON DELETE RESTRICT;


--
-- Name: source_record_projection_revisions source_record_projection_revisions_organization_id_organization; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_projection_revisions
    ADD CONSTRAINT source_record_projection_revisions_organization_id_organization FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: source_record_projection_revisions source_record_projection_revisions_revision_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_projection_revisions
    ADD CONSTRAINT source_record_projection_revisions_revision_tenant_fk FOREIGN KEY (canonical_revision_id, organization_id) REFERENCES public.canonical_revisions(id, organization_id) ON DELETE RESTRICT;


--
-- Name: source_record_projection_revisions source_record_projection_revisions_source_record_id_source_reco; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_projection_revisions
    ADD CONSTRAINT source_record_projection_revisions_source_record_id_source_reco FOREIGN KEY (source_record_id) REFERENCES public.source_records(id) ON DELETE RESTRICT;


--
-- Name: source_record_projection_revisions source_record_projection_revisions_source_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_record_projection_revisions
    ADD CONSTRAINT source_record_projection_revisions_source_tenant_fk FOREIGN KEY (source_record_id, organization_id) REFERENCES public.source_records(id, organization_id) ON DELETE RESTRICT;


--
-- Name: source_records source_records_first_page_id_import_pages_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_first_page_id_import_pages_id_fk FOREIGN KEY (first_page_id) REFERENCES public.import_pages(id) ON DELETE RESTRICT;


--
-- Name: source_records source_records_first_page_tenant_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_first_page_tenant_fk FOREIGN KEY (first_page_id, organization_id, provider_id, first_run_id) REFERENCES public.import_pages(id, organization_id, provider_id, run_id) ON DELETE RESTRICT;


--
-- Name: source_records source_records_first_run_id_import_runs_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_first_run_id_import_runs_id_fk FOREIGN KEY (first_run_id) REFERENCES public.import_runs(id) ON DELETE RESTRICT;


--
-- Name: source_records source_records_organization_id_organizations_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_organization_id_organizations_id_fk FOREIGN KEY (organization_id) REFERENCES public.organizations(id) ON DELETE RESTRICT;


--
-- Name: source_records source_records_provider_id_provider_sources_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.source_records
    ADD CONSTRAINT source_records_provider_id_provider_sources_id_fk FOREIGN KEY (provider_id) REFERENCES public.provider_sources(id) ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--
