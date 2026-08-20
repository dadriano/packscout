-- Durable, lane-generic publication readiness conditions.
ALTER TYPE public.operational_event_kind
  ADD VALUE 'promotion_activation_delayed';
ALTER TYPE public.operational_event_kind
  ADD VALUE 'promotion_settlement_blocked';
ALTER TYPE public.operational_event_kind
  ADD VALUE 'promotion_failed';
ALTER TYPE public.operational_event_kind
  ADD VALUE 'promotion_recovered';
