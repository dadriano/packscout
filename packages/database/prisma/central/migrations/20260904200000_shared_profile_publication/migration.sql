-- CreateTable
CREATE TABLE "shared_change_checkpoints" (
    "organization_id" UUID NOT NULL,
    "source_key" VARCHAR(200) NOT NULL,
    "through_sequence" BIGINT NOT NULL DEFAULT 0,
    "change_id" UUID,
    "receipt_sha256" CHAR(64),

    CONSTRAINT "shared_change_checkpoints_pkey" PRIMARY KEY ("organization_id","source_key")
);

-- CreateTable
CREATE TABLE "shared_catalog_changes" (
    "organization_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "source_key" VARCHAR(200) NOT NULL,
    "source_sequence" BIGINT NOT NULL,
    "source_identity" VARCHAR(200) NOT NULL,
    "request_sha256" CHAR(64) NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "dependencies_json" JSONB NOT NULL,
    "audience_json" JSONB NOT NULL,
    "audience_sha256" CHAR(64) NOT NULL,
    "profile_intent_ids" JSONB NOT NULL,
    "receipt_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_catalog_changes_pkey" PRIMARY KEY ("organization_id","id")
);

-- CreateTable
CREATE TABLE "shared_change_deliveries" (
    "organization_id" UUID NOT NULL,
    "provider_id" UUID NOT NULL,
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "change_id" UUID NOT NULL,
    "provider_change_sequence" BIGSERIAL NOT NULL,
    "shard_index" INTEGER NOT NULL,
    "delivery_json" JSONB NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'ready',
    "reason_code" VARCHAR(64),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" UUID,
    "lease_fence" BIGINT NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMPTZ(6),
    "acknowledgment_sha256" CHAR(64),
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "shared_change_deliveries_pkey" PRIMARY KEY ("organization_id","provider_id","id")
);

-- CreateTable
CREATE TABLE "profile_snapshot_artifacts" (
    "organization_id" UUID NOT NULL,
    "profile_kind" VARCHAR(16) NOT NULL,
    "entity_id" UUID NOT NULL,
    "snapshot_id" VARCHAR(69) NOT NULL,
    "content_sha256" CHAR(64) NOT NULL,
    "descriptor_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_snapshot_artifacts_pkey" PRIMARY KEY ("organization_id","profile_kind","entity_id","snapshot_id")
);

-- CreateTable
CREATE TABLE "profile_snapshot_batches" (
    "organization_id" UUID NOT NULL,
    "profile_kind" VARCHAR(16) NOT NULL,
    "entity_id" UUID NOT NULL,
    "snapshot_id" VARCHAR(69) NOT NULL,
    "batch_index" INTEGER NOT NULL,
    "batch_json" JSONB NOT NULL,

    CONSTRAINT "profile_snapshot_batches_pkey" PRIMARY KEY ("organization_id","profile_kind","entity_id","snapshot_id","batch_index")
);

-- CreateTable
CREATE TABLE "profile_publication_heads" (
    "organization_id" UUID NOT NULL,
    "profile_kind" VARCHAR(16) NOT NULL,
    "entity_id" UUID NOT NULL,
    "generation" BIGINT NOT NULL DEFAULT 0,
    "active_snapshot_id" VARCHAR(69),
    "lease_intent_id" UUID,
    "lease_owner" UUID,
    "lease_fence" BIGINT NOT NULL DEFAULT 0,
    "lease_expires_at" TIMESTAMPTZ(6),

    CONSTRAINT "profile_publication_heads_pkey" PRIMARY KEY ("organization_id","profile_kind","entity_id")
);

-- CreateTable
CREATE TABLE "profile_activation_intents" (
    "organization_id" UUID NOT NULL,
    "profile_kind" VARCHAR(16) NOT NULL,
    "entity_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "snapshot_id" VARCHAR(69) NOT NULL,
    "sequence" BIGSERIAL NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "intent_json" JSONB NOT NULL,
    "authorization_sha256" CHAR(64) NOT NULL,
    "payload_sha256" CHAR(64) NOT NULL,
    "state" VARCHAR(32) NOT NULL DEFAULT 'ready',
    "reason_code" VARCHAR(64),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(6),

    CONSTRAINT "profile_activation_intents_pkey" PRIMARY KEY ("organization_id","profile_kind","entity_id","id")
);

-- CreateTable
CREATE TABLE "profile_publication_operations" (
    "organization_id" UUID NOT NULL,
    "profile_kind" VARCHAR(16) NOT NULL,
    "entity_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "id" UUID NOT NULL,
    "idempotency_key" VARCHAR(200) NOT NULL,
    "request_sha256" CHAR(64) NOT NULL,
    "request_json" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_publication_operations_pkey" PRIMARY KEY ("organization_id","profile_kind","entity_id","intent_id","id")
);

-- CreateTable
CREATE TABLE "profile_publication_receipts" (
    "organization_id" UUID NOT NULL,
    "profile_kind" VARCHAR(16) NOT NULL,
    "entity_id" UUID NOT NULL,
    "intent_id" UUID NOT NULL,
    "operation_id" UUID NOT NULL,
    "receipt_json" JSONB NOT NULL,
    "receipt_sha256" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "profile_publication_receipts_pkey" PRIMARY KEY ("organization_id","profile_kind","entity_id","intent_id","operation_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "shared_catalog_changes_organization_id_source_identity_key" ON "shared_catalog_changes"("organization_id", "source_identity");

-- CreateIndex
CREATE UNIQUE INDEX "shared_catalog_changes_organization_id_source_key_source_se_key" ON "shared_catalog_changes"("organization_id", "source_key", "source_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "shared_change_deliveries_provider_change_sequence_key" ON "shared_change_deliveries"("provider_change_sequence");

-- CreateIndex
CREATE INDEX "shared_change_deliveries_organization_id_provider_id_provid_idx" ON "shared_change_deliveries"("organization_id", "provider_id", "provider_change_sequence");

-- CreateIndex
CREATE UNIQUE INDEX "shared_change_deliveries_organization_id_change_id_provider_key" ON "shared_change_deliveries"("organization_id", "change_id", "provider_id");

-- CreateIndex
CREATE UNIQUE INDEX "shared_change_deliveries_organization_id_change_id_shard_in_key" ON "shared_change_deliveries"("organization_id", "change_id", "shard_index");

-- CreateIndex
CREATE UNIQUE INDEX "profile_snapshot_artifacts_organization_id_profile_kind_ent_key" ON "profile_snapshot_artifacts"("organization_id", "profile_kind", "entity_id", "content_sha256");

-- CreateIndex
CREATE UNIQUE INDEX "profile_activation_intents_sequence_key" ON "profile_activation_intents"("sequence");

-- CreateIndex
CREATE INDEX "profile_activation_intents_organization_id_profile_kind_ent_idx" ON "profile_activation_intents"("organization_id", "profile_kind", "entity_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "profile_activation_intents_organization_id_profile_kind_ent_key" ON "profile_activation_intents"("organization_id", "profile_kind", "entity_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "profile_publication_operations_organization_id_id_key" ON "profile_publication_operations"("organization_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "profile_publication_operations_organization_id_idempotency__key" ON "profile_publication_operations"("organization_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "shared_change_checkpoints" ADD CONSTRAINT "shared_checkpoint_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "shared_change_checkpoints" ADD CONSTRAINT "shared_checkpoint_change_fk" FOREIGN KEY ("organization_id", "change_id") REFERENCES "shared_catalog_changes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "shared_catalog_changes" ADD CONSTRAINT "shared_change_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "shared_change_deliveries" ADD CONSTRAINT "shared_delivery_provider_fk" FOREIGN KEY ("provider_id", "organization_id") REFERENCES "providers"("id", "organization_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "shared_change_deliveries" ADD CONSTRAINT "shared_delivery_change_fk" FOREIGN KEY ("organization_id", "change_id") REFERENCES "shared_catalog_changes"("organization_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_snapshot_artifacts" ADD CONSTRAINT "profile_artifact_head_fk" FOREIGN KEY ("organization_id", "profile_kind", "entity_id") REFERENCES "profile_publication_heads"("organization_id", "profile_kind", "entity_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_snapshot_batches" ADD CONSTRAINT "profile_batch_artifact_fk" FOREIGN KEY ("organization_id", "profile_kind", "entity_id", "snapshot_id") REFERENCES "profile_snapshot_artifacts"("organization_id", "profile_kind", "entity_id", "snapshot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_publication_heads" ADD CONSTRAINT "profile_head_org_fk" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_publication_heads" ADD CONSTRAINT "profile_head_active_fk" FOREIGN KEY ("organization_id", "profile_kind", "entity_id", "active_snapshot_id") REFERENCES "profile_snapshot_artifacts"("organization_id", "profile_kind", "entity_id", "snapshot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_publication_heads" ADD CONSTRAINT "profile_head_lease_fk" FOREIGN KEY ("organization_id", "profile_kind", "entity_id", "lease_intent_id") REFERENCES "profile_activation_intents"("organization_id", "profile_kind", "entity_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_activation_intents" ADD CONSTRAINT "profile_intent_head_fk" FOREIGN KEY ("organization_id", "profile_kind", "entity_id") REFERENCES "profile_publication_heads"("organization_id", "profile_kind", "entity_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_activation_intents" ADD CONSTRAINT "profile_intent_artifact_fk" FOREIGN KEY ("organization_id", "profile_kind", "entity_id", "snapshot_id") REFERENCES "profile_snapshot_artifacts"("organization_id", "profile_kind", "entity_id", "snapshot_id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_publication_operations" ADD CONSTRAINT "profile_operation_intent_fk" FOREIGN KEY ("organization_id", "profile_kind", "entity_id", "intent_id") REFERENCES "profile_activation_intents"("organization_id", "profile_kind", "entity_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "profile_publication_receipts" ADD CONSTRAINT "profile_receipt_operation_fk" FOREIGN KEY ("organization_id", "profile_kind", "entity_id", "intent_id", "operation_id") REFERENCES "profile_publication_operations"("organization_id", "profile_kind", "entity_id", "intent_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;


ALTER TABLE shared_catalog_changes ADD CHECK (source_sequence > 0 AND jsonb_array_length(audience_json) <= 1000
  AND jsonb_array_length(profile_intent_ids) <= 100 AND jsonb_array_length(dependencies_json) <= 10000);
ALTER TABLE shared_change_checkpoints ADD CHECK (through_sequence >= 0);
ALTER TABLE shared_change_deliveries ADD CHECK (provider_change_sequence > 0 AND shard_index BETWEEN 0 AND 999
  AND attempts BETWEEN 0 AND 100 AND lease_fence >= 0 AND state IN ('ready','publishing','retry_scheduled','blocked','published'));
ALTER TABLE profile_snapshot_artifacts ADD CHECK (profile_kind IN ('provider','collectible') AND snapshot_id = 'ppfs_' || content_sha256);
ALTER TABLE profile_snapshot_batches ADD CHECK (batch_index = 0 AND (batch_json->>'byteCount')::integer BETWEEN 1 AND 480000);
ALTER TABLE profile_publication_heads ADD CHECK (generation >= 0 AND lease_fence >= 0 AND profile_kind IN ('provider','collectible'));
ALTER TABLE profile_activation_intents ADD CHECK (sequence > 0 AND attempts BETWEEN 0 AND 100 AND
  state IN ('waiting','ready','publishing','retry_scheduled','blocked','published','superseded','rolled_back'));
ALTER TABLE profile_publication_operations ADD CHECK (octet_length(request_json::text) <= 1048576);
ALTER TABLE profile_publication_receipts ADD CHECK (octet_length(receipt_json::text) <= 16384);

CREATE FUNCTION shared_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - COALESCE(TG_ARGV, ARRAY[]::text[])) IS DISTINCT FROM (to_jsonb(OLD) - COALESCE(TG_ARGV, ARRAY[]::text[])) THEN
    RAISE EXCEPTION 'SHARED_IMMUTABLE_RECORD';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER shared_change_immutable BEFORE UPDATE ON shared_catalog_changes FOR EACH ROW EXECUTE FUNCTION shared_publication_immutable();
CREATE TRIGGER profile_artifact_immutable BEFORE UPDATE ON profile_snapshot_artifacts FOR EACH ROW EXECUTE FUNCTION shared_publication_immutable();
CREATE TRIGGER profile_batch_immutable BEFORE UPDATE ON profile_snapshot_batches FOR EACH ROW EXECUTE FUNCTION shared_publication_immutable();
CREATE TRIGGER profile_operation_immutable BEFORE UPDATE ON profile_publication_operations FOR EACH ROW EXECUTE FUNCTION shared_publication_immutable();
CREATE TRIGGER profile_receipt_immutable BEFORE UPDATE ON profile_publication_receipts FOR EACH ROW EXECUTE FUNCTION shared_publication_immutable();
CREATE TRIGGER shared_delivery_identity_immutable BEFORE UPDATE ON shared_change_deliveries FOR EACH ROW EXECUTE FUNCTION shared_publication_immutable(
  'state','reason_code','attempts','available_at','lease_owner','lease_fence','lease_expires_at','acknowledgment_sha256','completed_at');
CREATE TRIGGER profile_intent_identity_immutable BEFORE UPDATE ON profile_activation_intents FOR EACH ROW EXECUTE FUNCTION shared_publication_immutable(
  'state','reason_code','attempts','available_at','completed_at');

-- A checkpoint cannot commit without the exact audience and required profile work.
CREATE FUNCTION shared_checkpoint_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c shared_catalog_changes; actual jsonb; profile_count integer;
BEGIN
  IF NEW.through_sequence = 0 THEN RETURN NEW; END IF;
  SELECT * INTO STRICT c FROM shared_catalog_changes WHERE organization_id = NEW.organization_id AND id = NEW.change_id;
  SELECT COALESCE(jsonb_agg(provider_id::text ORDER BY shard_index), '[]'::jsonb) INTO actual FROM shared_change_deliveries
    WHERE organization_id = NEW.organization_id AND change_id = c.id;
  SELECT count(*) INTO profile_count FROM profile_activation_intents WHERE organization_id = NEW.organization_id
    AND id::text IN (SELECT jsonb_array_elements_text(c.profile_intent_ids));
  IF actual <> c.audience_json OR profile_count <> jsonb_array_length(c.profile_intent_ids)
    OR c.source_sequence <> NEW.through_sequence OR c.source_key <> NEW.source_key OR c.receipt_sha256 <> NEW.receipt_sha256 THEN
    RAISE EXCEPTION 'SHARED_CHECKPOINT_INCOMPLETE';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER shared_checkpoint_complete AFTER INSERT OR UPDATE ON shared_change_checkpoints
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION shared_checkpoint_complete();
