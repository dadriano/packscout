-- Durable email outbox: a message is enqueued as an intent and delivered by a
-- background drain, so a provider outage delays messages instead of losing
-- them and the same triggering event can never send twice. Intents keep the
-- claim-lease discipline the pipeline's other background work uses; every
-- delivery try leaves a bounded attempt record. No foreign keys reach tenant
-- data so enqueueing can never fail on it and pruning stays unblocked.

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
-- Name: worker_activity_kind; Type: TYPE VALUE; Schema: public; Owner: -
--

ALTER TYPE public.worker_activity_kind
  ADD VALUE 'message_outbox';

--
-- Name: email_message_intent_state; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.email_message_intent_state AS ENUM (
    'pending',
    'retrying',
    'sent',
    'skipped',
    'failed'
);

--
-- Name: email_message_attempt_outcome; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.email_message_attempt_outcome AS ENUM (
    'sent',
    'skipped',
    'failed'
);

--
-- Name: email_message_intents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_message_intents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    kind text NOT NULL,
    input_json jsonb NOT NULL,
    recipient text NOT NULL,
    idempotency_key text NOT NULL,
    source text NOT NULL,
    state public.email_message_intent_state DEFAULT 'pending'::public.email_message_intent_state NOT NULL,
    due_at timestamp with time zone NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    claim_owner text,
    claim_token uuid,
    claim_expires_at timestamp with time zone,
    last_provider text,
    last_error_code text,
    last_skip_reason text,
    last_attempted_at timestamp with time zone,
    finalized_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_message_intents_attempts_nonnegative CHECK ((attempt_count >= 0)),
    CONSTRAINT email_message_intents_claim_consistent CHECK ((((claim_owner IS NULL) AND (claim_token IS NULL) AND (claim_expires_at IS NULL)) OR ((claim_owner IS NOT NULL) AND (claim_token IS NOT NULL) AND (claim_expires_at IS NOT NULL)))),
    CONSTRAINT email_message_intents_claim_owner_bounded CHECK (((claim_owner IS NULL) OR ((length(claim_owner) >= 1) AND (length(claim_owner) <= 256)))),
    CONSTRAINT email_message_intents_error_code_bounded CHECK (((last_error_code IS NULL) OR (last_error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'::text))),
    CONSTRAINT email_message_intents_idempotency_key_bounded CHECK (((length(idempotency_key) >= 1) AND (length(idempotency_key) <= 256))),
    CONSTRAINT email_message_intents_input_bounded CHECK ((length((input_json)::text) <= 16384)),
    CONSTRAINT email_message_intents_kind_bounded CHECK ((kind ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
    CONSTRAINT email_message_intents_provider_bounded CHECK (((last_provider IS NULL) OR ((length(last_provider) >= 1) AND (length(last_provider) <= 64)))),
    CONSTRAINT email_message_intents_recipient_bounded CHECK (((length(recipient) >= 3) AND (length(recipient) <= 320) AND (strpos(recipient, '@'::text) > 1))),
    CONSTRAINT email_message_intents_skip_reason_valid CHECK (((last_skip_reason IS NULL) OR (last_skip_reason = ANY (ARRAY['delivery_disabled'::text, 'console_mode'::text, 'missing_configuration'::text])))),
    CONSTRAINT email_message_intents_source_bounded CHECK ((source ~ '^[a-z][a-z0-9_]{0,63}$'::text)),
    CONSTRAINT email_message_intents_terminal_consistent CHECK ((((state = ANY (ARRAY['sent'::public.email_message_intent_state, 'skipped'::public.email_message_intent_state, 'failed'::public.email_message_intent_state])) AND (finalized_at IS NOT NULL) AND (claim_owner IS NULL)) OR ((state = ANY (ARRAY['pending'::public.email_message_intent_state, 'retrying'::public.email_message_intent_state])) AND (finalized_at IS NULL))))
);

--
-- Name: email_message_attempts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_message_attempts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    intent_id uuid NOT NULL,
    attempt_number integer NOT NULL,
    attempted_at timestamp with time zone NOT NULL,
    outcome public.email_message_attempt_outcome NOT NULL,
    provider text,
    provider_message_id text,
    error_code text,
    error_message text,
    error_retryable boolean,
    skip_reason text,
    CONSTRAINT email_message_attempts_error_code_bounded CHECK (((error_code IS NULL) OR (error_code ~ '^[A-Z][A-Z0-9_]{0,127}$'::text))),
    CONSTRAINT email_message_attempts_error_message_bounded CHECK (((error_message IS NULL) OR (length(error_message) <= 200))),
    CONSTRAINT email_message_attempts_number_positive CHECK ((attempt_number >= 1)),
    CONSTRAINT email_message_attempts_outcome_consistent CHECK ((((outcome = 'sent'::public.email_message_attempt_outcome) AND (provider IS NOT NULL) AND (error_code IS NULL) AND (error_message IS NULL) AND (error_retryable IS NULL) AND (skip_reason IS NULL)) OR ((outcome = 'skipped'::public.email_message_attempt_outcome) AND (skip_reason IS NOT NULL) AND (provider_message_id IS NULL) AND (error_code IS NULL) AND (error_message IS NULL) AND (error_retryable IS NULL)) OR ((outcome = 'failed'::public.email_message_attempt_outcome) AND (error_code IS NOT NULL) AND (error_retryable IS NOT NULL) AND (provider_message_id IS NULL) AND (skip_reason IS NULL)))),
    CONSTRAINT email_message_attempts_provider_bounded CHECK (((provider IS NULL) OR ((length(provider) >= 1) AND (length(provider) <= 64)))),
    CONSTRAINT email_message_attempts_provider_message_id_bounded CHECK (((provider_message_id IS NULL) OR ((length(provider_message_id) >= 1) AND (length(provider_message_id) <= 256)))),
    CONSTRAINT email_message_attempts_skip_reason_valid CHECK (((skip_reason IS NULL) OR (skip_reason = ANY (ARRAY['delivery_disabled'::text, 'console_mode'::text, 'missing_configuration'::text]))))
);

--
-- Name: email_message_intents email_message_intents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message_intents
    ADD CONSTRAINT email_message_intents_pkey PRIMARY KEY (id);

--
-- Name: email_message_attempts email_message_attempts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message_attempts
    ADD CONSTRAINT email_message_attempts_pkey PRIMARY KEY (id);

--
-- Name: email_message_intents email_message_intents_idempotency_key_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message_intents
    ADD CONSTRAINT email_message_intents_idempotency_key_unique UNIQUE (idempotency_key);

--
-- Name: email_message_attempts email_message_attempts_intent_attempt_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message_attempts
    ADD CONSTRAINT email_message_attempts_intent_attempt_unique UNIQUE (intent_id, attempt_number);

--
-- Name: email_message_attempts email_message_attempts_intent_id_email_message_intents_id_fk; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_message_attempts
    ADD CONSTRAINT email_message_attempts_intent_id_email_message_intents_id_fk FOREIGN KEY (intent_id) REFERENCES public.email_message_intents(id) ON UPDATE NO ACTION;

--
-- Name: email_message_intents_state_due_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_message_intents_state_due_idx ON public.email_message_intents USING btree (state, due_at, id);

--
-- Name: email_message_intents_source_state_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_message_intents_source_state_idx ON public.email_message_intents USING btree (source, state);

--
-- Name: email_message_intents_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_message_intents_created_idx ON public.email_message_intents USING btree (created_at, id);

--
-- Name: email_message_intents_state_finalized_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_message_intents_state_finalized_idx ON public.email_message_intents USING btree (state, finalized_at);

--
-- Name: email_message_intents_recipient_created_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_message_intents_recipient_created_idx ON public.email_message_intents USING btree (recipient, created_at);

--
-- Name: email_message_attempts_attempted_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_message_attempts_attempted_idx ON public.email_message_attempts USING btree (attempted_at);
