-- Alertable machinery conditions: the pipeline's own machinery failing, as
-- opposed to a data outcome. One recovery kind closes them all, because the
-- condition each alert groups is already named by its recovery key.
ALTER TYPE public.operational_event_kind
  ADD VALUE 'worker_fleet_silent';
ALTER TYPE public.operational_event_kind
  ADD VALUE 'import_run_stalled';
ALTER TYPE public.operational_event_kind
  ADD VALUE 'provider_schedule_overdue';
ALTER TYPE public.operational_event_kind
  ADD VALUE 'recomputation_backlogged';
ALTER TYPE public.operational_event_kind
  ADD VALUE 'retention_overdue';
ALTER TYPE public.operational_event_kind
  ADD VALUE 'machinery_recovered';
