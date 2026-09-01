-- Canonical summaries read each entity type's first and last ledger sequence.
-- Build outside a transaction so ingestion can continue while the index builds.
CREATE INDEX CONCURRENTLY "promotion_changes_entity_sequence_idx"
  ON "promotion_changes" ("entity_type", "sequence");
