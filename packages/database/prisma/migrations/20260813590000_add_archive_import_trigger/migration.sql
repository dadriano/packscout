-- PostgreSQL requires a commit before a newly-added enum value is referenced.
ALTER TYPE public.import_trigger ADD VALUE 'archive';
