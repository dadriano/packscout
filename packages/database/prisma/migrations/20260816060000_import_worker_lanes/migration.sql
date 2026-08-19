-- Controlled local imports must remain affinity-bound across cooperative yields.
CREATE TYPE public.import_worker_lane AS ENUM ('general', 'controlled');

ALTER TABLE public.import_runs
  ADD COLUMN worker_lane public.import_worker_lane NOT NULL DEFAULT 'general';

CREATE INDEX import_runs_worker_lane_queue_idx
  ON public.import_runs USING btree (
    worker_lane,
    state,
    lease_expires_at,
    created_at,
    id
  );
