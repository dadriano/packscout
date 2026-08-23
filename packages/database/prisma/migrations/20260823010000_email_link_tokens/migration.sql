-- One-time email-link tokens: a link mailed to an address is redeemable
-- exactly once, for one purpose and one subject, until it expires. The token
-- splits into a lookup selector (stored plaintext, unique) and a secret
-- verifier stored only as a keyed hash, so a database read can never yield a
-- usable token; the usable composite exists only in the message that was
-- sent. Redemption consumes the row through a single guarded UPDATE, so two
-- concurrent redemptions resolve to exactly one success at the database.
-- Reissuing marks prior outstanding rows superseded rather than deleting
-- them, and pruning removes only rows past their expiry. No foreign keys
-- reach tenant data, mirroring the outbox: subjects are bound by identifier
-- and re-checked for eligibility at redemption time, and pruning never
-- blocks on unrelated rows.

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
-- Name: email_link_purpose; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.email_link_purpose AS ENUM (
    'operator_password_reset',
    'operator_invitation'
);

--
-- Name: email_link_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_link_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    purpose public.email_link_purpose NOT NULL,
    selector text NOT NULL,
    verifier_hash text NOT NULL,
    subject_id uuid NOT NULL,
    address_normalized text NOT NULL,
    issued_at timestamp with time zone NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    redeemed_at timestamp with time zone,
    superseded_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT email_link_tokens_address_bounded CHECK (((length(address_normalized) >= 3) AND (length(address_normalized) <= 320) AND (strpos(address_normalized, '@'::text) > 1))),
    CONSTRAINT email_link_tokens_expires_after_issue CHECK ((expires_at > issued_at)),
    CONSTRAINT email_link_tokens_redeemed_after_issue CHECK (((redeemed_at IS NULL) OR (redeemed_at >= issued_at))),
    CONSTRAINT email_link_tokens_selector_bounded CHECK ((selector ~ '^[A-Za-z0-9_-]{22}$'::text)),
    CONSTRAINT email_link_tokens_settled_exclusive CHECK (((redeemed_at IS NULL) OR (superseded_at IS NULL))),
    CONSTRAINT email_link_tokens_superseded_after_issue CHECK (((superseded_at IS NULL) OR (superseded_at >= issued_at))),
    CONSTRAINT email_link_tokens_verifier_hash_bounded CHECK ((verifier_hash ~ '^[A-Za-z0-9_-]{43}$'::text))
);

--
-- Name: email_link_tokens email_link_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_link_tokens
    ADD CONSTRAINT email_link_tokens_pkey PRIMARY KEY (id);

--
-- Name: email_link_tokens email_link_tokens_selector_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_link_tokens
    ADD CONSTRAINT email_link_tokens_selector_unique UNIQUE (selector);

--
-- Name: email_link_tokens_outstanding_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_link_tokens_outstanding_idx ON public.email_link_tokens USING btree (purpose, subject_id);

--
-- Name: email_link_tokens_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX email_link_tokens_expiry_idx ON public.email_link_tokens USING btree (expires_at);
