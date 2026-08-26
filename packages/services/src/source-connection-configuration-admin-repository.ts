import type { SourceAdapterRegistry } from "./source-adapter-registry.ts";
import type { SourceAdminConfigurationCodecRegistry } from "./source-admin-configuration-codec.ts";
import type {
  EncryptedSourceConnectionConfiguration,
  SourceConnectionConfigurationCipher,
} from "./source-connection-configuration-cipher.ts";

export interface SourceConnectionRevisionSecretRecord {
  readonly organizationId: string;
  readonly connectionProfileId: string;
  readonly connectionRevisionId: string;
  readonly sourceTypeKey: string;
  readonly sourceAdapterVersion: string;
  readonly revisionNumber: number;
  readonly state: "candidate" | "active" | "retired" | "revoked";
  readonly healthGeneration: bigint;
  readonly configurationFingerprint: string;
  readonly encryptedConfiguration: EncryptedSourceConnectionConfiguration;
}

export interface SourceConnectionConfigurationAdminRepository {
  createConnectionProfile(input: Readonly<{
    organizationId: string;
    profileId: string;
    revisionId: string;
    sourceTypeKey: string;
    connectionTypeKey: string;
    displayName: string;
    requestLimit: number;
    sourceAdapterVersion: string;
    encryptedConfiguration: EncryptedSourceConnectionConfiguration;
    configurationFingerprint: string;
    actorKey: string;
    createdAt: Date;
  }>): Promise<void>;
  loadConnectionRevision(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId?: string;
  }>): Promise<SourceConnectionRevisionSecretRecord | null>;
  addConnectionRevision(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    expectedRevisionId: string;
    revisionId: string;
    revisionNumber: number;
    sourceTypeKey: string;
    sourceAdapterVersion: string;
    encryptedConfiguration: EncryptedSourceConnectionConfiguration;
    configurationFingerprint: string;
    actorKey: string;
    createdAt: Date;
  }>): Promise<void>;
  addRecoveryConnectionRevision(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    blockedRevisionId: string;
    latestRevisionId: string;
    blockingEpisodeId: string | null;
    revisionId: string;
    revisionNumber: number;
    sourceTypeKey: string;
    sourceAdapterVersion: string;
    encryptedConfiguration: EncryptedSourceConnectionConfiguration;
    configurationFingerprint: string;
    actorKey: string;
    createdAt: Date;
  }>): Promise<void>;
  requestConnectionTest(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    expectedHealthGeneration: bigint;
    requestedByActorKey: string;
    requestedAt: Date;
  }>): Promise<{ readonly jobId: string }>;
  requestConnectionRecoveryTest(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    expectedHealthGeneration: bigint;
    blockedRevisionId: string;
    blockingEpisodeId: string | null;
    requestedByActorKey: string;
    requestedAt: Date;
  }>): Promise<{ readonly jobId: string }>;
  activateTestedConnectionRevision(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    expectedHealthGeneration: bigint;
    preservePinnedWork: true;
    actorKey: string;
    activatedAt: Date;
  }>): Promise<void>;
  activateTestedConnectionRecovery(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    expectedHealthGeneration: bigint;
    blockedRevisionId: string;
    blockingEpisodeId: string | null;
    actorKey: string;
    activatedAt: Date;
  }>): Promise<Readonly<{
    runIds: readonly string[];
  }>>;
  revokeConnectionRevision(input: Readonly<{
    organizationId: string;
    connectionProfileId: string;
    connectionRevisionId: string;
    expectedHealthGeneration: bigint;
    actorKey: string;
    revokedAt: Date;
  }>): Promise<void>;
}

export interface SourceConnectionConfigurationServiceDependencies {
  readonly repository: SourceConnectionConfigurationAdminRepository;
  readonly cipher: SourceConnectionConfigurationCipher;
  readonly sourceAdapters: SourceAdapterRegistry;
  readonly adminConfigurationCodecs: SourceAdminConfigurationCodecRegistry;
  readonly clock?: Readonly<{ now(): Date }>;
  readonly ids?: Readonly<{ id(): string }>;
}
