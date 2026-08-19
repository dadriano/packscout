import { statfs } from "node:fs/promises";
import { Prisma } from "@prisma/client";
import type { PackscoutPrismaClient } from "@packscout/database";
import {
  PROVIDER_IMPORT_MAXIMUM_PAGE_STORAGE_BYTES,
  type ProviderImportPageGuard,
} from "@packscout/services";

export interface ProviderWorkerFreeDiskReader {
  freeBytes(): Promise<bigint>;
}

export class ProviderWorkerDiskGuard implements ProviderImportPageGuard {
  readonly #requiredFreeBytes: bigint;

  constructor(
    private readonly reader: ProviderWorkerFreeDiskReader,
    minimumFreeBytes: number,
  ) {
    if (!Number.isSafeInteger(minimumFreeBytes) || minimumFreeBytes < 0) {
      throw new RangeError("Provider import disk reserve is invalid.");
    }
    this.#requiredFreeBytes =
      BigInt(minimumFreeBytes) +
      BigInt(PROVIDER_IMPORT_MAXIMUM_PAGE_STORAGE_BYTES);
  }

  async canStartPage(): Promise<boolean> {
    return (await this.reader.freeBytes()) >= this.#requiredFreeBytes;
  }
}

export function createProviderWorkerDiskGuard(
  database: PackscoutPrismaClient,
  minimumFreeBytes: number,
): ProviderWorkerDiskGuard {
  let dataDirectory: string | null = null;
  return new ProviderWorkerDiskGuard(
    {
      async freeBytes() {
        if (dataDirectory === null) {
          const [row] = await database.$queryRaw<
            Array<{ path: string }>
          >(Prisma.sql`
          select current_setting('data_directory') as path
        `);
          if (!row?.path)
            throw new Error("PostgreSQL data directory is unavailable.");
          dataDirectory = row.path;
        }
        const fileSystem = await statfs(dataDirectory, { bigint: true });
        return fileSystem.bavail * fileSystem.bsize;
      },
    },
    minimumFreeBytes,
  );
}
