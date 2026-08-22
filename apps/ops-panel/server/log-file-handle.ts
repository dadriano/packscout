import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ByteRange } from "./core/log-window.ts";

/**
 * One open log file, and the identity that makes its offsets mean something.
 *
 * A pathname is not a file. `frontend.log` is a name a rotation can move to a
 * different inode between two lines of code, and every offset the panel holds
 * belongs to one continuous run of bytes behind that name — not to the name.
 * Statting a path and then re-opening it is therefore a bug with a timing
 * window in it: bytes from the replacement file arrive labelled with the old
 * file's generation and offsets, which is the one failure a log viewer must not
 * have. So a read opens the file *once*, takes its identity and size from that
 * descriptor, and answers every range from it.
 *
 * `dev:ino` is the identity, which is what the tail's generation counter is
 * anchored to as well, so the tail and history browsing agree about which file
 * a generation names rather than each trusting the path separately.
 *
 * Descriptors are held for the duration of one read and closed immediately. A
 * panel that parks an open handle on every service keeps rotated files alive on
 * disk and becomes the reason a developer cannot reclaim space.
 */

export interface LogFileHandle {
  /** `dev:ino` of the descriptor that was actually opened. */
  readonly identity: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number;
  read(range: ByteRange): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** Resolves to null when nothing is behind the name; that is not an error. */
export type OpenLogFile = (filePath: string) => Promise<LogFileHandle | null>;

export function formatFileIdentity(details: {
  dev: number;
  ino: number;
}): string {
  return `${details.dev}:${details.ino}`;
}

/**
 * Whether a descriptor actually said which file it is.
 *
 * `dev:ino` with a real inode behind it is the entire basis for trusting a
 * length or an offset, so a descriptor that cannot produce one has nothing to
 * anchor a read to and callers refuse instead of answering from it.
 */
export function isFileIdentity(value: string): boolean {
  const separator = value.indexOf(":");
  if (separator <= 0) return false;
  const inode = Number(value.slice(separator + 1));
  return Number.isSafeInteger(inode) && inode > 0;
}

/**
 * 64 KiB: few enough syscalls for a gigabyte file, small enough that the panel
 * never holds a meaningful slice of one in memory.
 */
const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * A byte stream over a range of an *already open* handle.
 *
 * Every chunk is a positional read on the descriptor the caller measured, so a
 * rotation between measuring a file and reading it cannot substitute the
 * replacement file's bytes — which is exactly what handing a pathname to
 * `createReadStream` leaves room for. The bytes and the length they were
 * promised against come from one descriptor or they are two separate claims
 * about a name.
 *
 * The handle is not closed here. The caller opened it and owns its lifetime; a
 * stream that closed it too would close it in one more place than the caller
 * can account for.
 */
export function streamLogFile(
  file: Pick<LogFileHandle, "read">,
  range: ByteRange,
): Readable {
  const end = range.offset + Math.max(0, range.length);
  async function* chunks(): AsyncGenerator<Uint8Array> {
    let offset = range.offset;
    while (offset < end) {
      const bytes = await file.read({
        offset,
        length: Math.min(STREAM_CHUNK_BYTES, end - offset),
      });
      // A short read means the file shrank beneath the descriptor. Stopping is
      // the honest answer: inventing padding would be worse than a truncated
      // transfer the client can detect against the length it was given.
      if (bytes.length === 0) return;
      yield bytes;
      offset += bytes.length;
    }
  }
  // One chunk is in flight at a time, so a large file is transferred rather
  // than buffered.
  return Readable.from(chunks(), {
    objectMode: false,
    highWaterMark: STREAM_CHUNK_BYTES,
  });
}

export async function openLogFile(
  filePath: string,
): Promise<LogFileHandle | null> {
  let handle;
  try {
    handle = await open(filePath, "r");
  } catch {
    return null;
  }

  try {
    // `fstat`, not `stat`: the identity and the size describe the descriptor
    // that will answer the reads, not whatever the path points at now.
    const details = await handle.stat();
    return {
      identity: formatFileIdentity(details),
      sizeBytes: details.size,
      modifiedAtMs: details.mtimeMs,
      async read(range) {
        if (range.length <= 0) return new Uint8Array(0);
        const buffer = new Uint8Array(range.length);
        const { bytesRead } = await handle.read(
          buffer,
          0,
          range.length,
          range.offset,
        );
        return buffer.subarray(0, bytesRead);
      },
      close: () => handle.close(),
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
