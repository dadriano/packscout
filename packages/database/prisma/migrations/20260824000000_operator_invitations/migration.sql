-- Invited operators: an account created by invitation exists so it can hold a
-- role and appear in the access ledger, but it authenticates nowhere until the
-- invited person proves control of the mailbox and chooses a password.
--
-- Two new account states carry that: `pending` is invited-but-not-activated,
-- and `cancelled` is an invitation an administrator withdrew — terminal, and
-- deliberately distinct from `disabled`, which is an account that once worked
-- and was switched off. Both sort next to the state they follow so the enum
-- reads in lifecycle order.
--
-- A pending account has no credential at all, rather than a placeholder hash
-- that could be guessed, reused, or mistaken for a real one, so `password_hash`
-- becomes nullable. The check constraint is the invariant that matters and is
-- enforced by the database rather than by any caller: an account that can
-- authenticate always has a credential. It names only the pre-existing
-- `active` value, so it is safe alongside the new enum values added in this
-- same transaction.

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
-- Name: operator_state; Type: TYPE; Schema: public; Owner: -
--

ALTER TYPE public.operator_state ADD VALUE IF NOT EXISTS 'pending' BEFORE 'active';
ALTER TYPE public.operator_state ADD VALUE IF NOT EXISTS 'cancelled' AFTER 'disabled';

--
-- Name: operators; Type: TABLE; Schema: public; Owner: -
--

ALTER TABLE public.operators ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE public.operators
    ADD CONSTRAINT operators_active_requires_credential
    CHECK (((password_hash IS NOT NULL) OR (state <> 'active'::public.operator_state)));
