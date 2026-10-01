import { crc32, inflateRawSync } from 'node:zlib';

/**
 * A ZIP archive that is malformed, inconsistent, uses an unsupported feature, or fails its CRC
 * check. `code` is fixed and the message is one of a fixed set, never archive content.
 */
export class ZipFormatError extends Error {
  readonly code = 'CORPUS_ZIP_FORMAT';
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;
/** The fixed part of the end-of-central-directory record; a trailing comment may follow it. */
const EOCD_SIZE = 22;
const CENTRAL_ENTRY_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const MAX_COMMENT = 0xffff;
/** General-purpose flags: bit 0 encryption, bit 3 data descriptor, bit 6 strong encryption. */
const FLAG_ENCRYPTED = 0x0001;
const FLAG_DATA_DESCRIPTOR = 0x0008;
const FLAG_STRONG_ENCRYPTION = 0x0040;
/**
 * Decompression limits: the largest artifact member is about 1 MiB, so these are generous for
 * real input and stop a crafted member (a deflate bomb, or a central directory lying about sizes)
 * from exhausting memory.
 */
export const MAX_MEMBER_BYTES = 16 * 1024 * 1024;
export const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

interface Entry {
  name: string;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  localOffset: number;
}

/**
 * Reads every member of a ZIP archive into memory: stored or deflated members only, no ZIP64, no
 * encryption, no data descriptors, no multi-disk archives (none of which the eBible artifact uses).
 * Hardened for hostile input, though callers only pass bytes whose SHA-256 already matched the
 * pinned release (`readArtifact`): every offset and length is bounds-checked; each local header
 * must agree with its central directory entry (name, flags, method, CRC-32, sizes); members may not
 * overlap each other or the central directory; inflation is capped at the declared size; and each
 * member's size and CRC-32 are verified. Any failure is a `ZipFormatError`.
 */
export function readZip(archive: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  const directoryStart = archive.readUInt32LE(eocd + 16);
  if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 6) !== 0) {
    throw new ZipFormatError('multi-disk archives are not supported');
  }
  if (archive.readUInt16LE(eocd + 8) !== entryCount) {
    throw new ZipFormatError('multi-disk archives are not supported');
  }
  if (entryCount === 0xffff || directorySize === 0xffffffff || directoryStart === 0xffffffff) {
    throw new ZipFormatError('ZIP64 archives are not supported');
  }
  const directoryEnd = directoryStart + directorySize;
  if (directoryEnd !== eocd) throw new ZipFormatError('central directory out of range');

  const entries = readCentralDirectory(archive, directoryStart, directoryEnd, entryCount);

  // Members, in archive order, must each lie before the central directory and not overlap.
  const spans = entries
    .map((entry) => ({ entry, ...memberSpan(archive, entry, directoryStart) }))
    .sort((a, b) => a.headerStart - b.headerStart);
  spans.forEach((span, i) => {
    const previous = spans[i - 1];
    if (previous && span.headerStart < previous.dataEnd) {
      throw new ZipFormatError('overlapping members');
    }
  });

  const members = new Map<string, Buffer>();
  let total = 0;
  for (const { entry, dataStart, dataEnd } of spans) {
    total += entry.size;
    if (total > MAX_TOTAL_BYTES) throw new ZipFormatError('archive too large');
    const data = inflateMember(entry, archive.subarray(dataStart, dataEnd));
    if (data.length !== entry.size || crc32(data) !== entry.crc) {
      throw new ZipFormatError('member failed its size or CRC-32 check');
    }
    members.set(entry.name, data);
  }
  return members;
}

function readCentralDirectory(
  archive: Buffer,
  start: number,
  end: number,
  entryCount: number,
): Entry[] {
  const entries: Entry[] = [];
  const names = new Set<string>();
  let offset = start;
  for (let i = 0; i < entryCount; i++) {
    if (offset + CENTRAL_ENTRY_SIZE > end) throw new ZipFormatError('central directory truncated');
    if (archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new ZipFormatError('bad central directory entry');
    }
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const next = offset + CENTRAL_ENTRY_SIZE + nameLength + extraLength + commentLength;
    if (next > end) throw new ZipFormatError('central directory truncated');
    if (archive.readUInt16LE(offset + 34) !== 0) {
      throw new ZipFormatError('multi-disk archives are not supported');
    }
    const entry: Entry = {
      flags: archive.readUInt16LE(offset + 8),
      method: archive.readUInt16LE(offset + 10),
      crc: archive.readUInt32LE(offset + 16),
      compressedSize: archive.readUInt32LE(offset + 20),
      size: archive.readUInt32LE(offset + 24),
      localOffset: archive.readUInt32LE(offset + 42),
      name: archive.toString(
        'utf8',
        offset + CENTRAL_ENTRY_SIZE,
        offset + CENTRAL_ENTRY_SIZE + nameLength,
      ),
    };
    if (entry.flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) {
      throw new ZipFormatError('encrypted members are not supported');
    }
    if (entry.flags & FLAG_DATA_DESCRIPTOR) {
      throw new ZipFormatError('data descriptors are not supported');
    }
    if (entry.method !== STORED && entry.method !== DEFLATED) {
      throw new ZipFormatError('unsupported compression method');
    }
    if (entry.compressedSize === 0xffffffff || entry.size === 0xffffffff) {
      throw new ZipFormatError('ZIP64 archives are not supported');
    }
    if (entry.size > MAX_MEMBER_BYTES) throw new ZipFormatError('member too large');
    if (entry.method === STORED && entry.compressedSize !== entry.size) {
      throw new ZipFormatError('local header does not match the central directory');
    }
    if (names.has(entry.name)) throw new ZipFormatError('duplicate member name');
    names.add(entry.name);
    entries.push(entry);
    offset = next;
  }
  if (offset !== end) throw new ZipFormatError('central directory size mismatch');
  return entries;
}

/** Checks the member's local header against its central entry; returns where its bytes lie. */
function memberSpan(
  archive: Buffer,
  entry: Entry,
  directoryStart: number,
): { headerStart: number; dataStart: number; dataEnd: number } {
  const at = entry.localOffset;
  if (at + LOCAL_HEADER_SIZE > directoryStart) throw new ZipFormatError('member out of range');
  if (archive.readUInt32LE(at) !== LOCAL_FILE_HEADER) {
    throw new ZipFormatError('bad local file header');
  }
  const nameLength = archive.readUInt16LE(at + 26);
  const extraLength = archive.readUInt16LE(at + 28);
  const nameStart = at + LOCAL_HEADER_SIZE;
  const dataStart = nameStart + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > directoryStart) throw new ZipFormatError('member out of range');
  if (
    archive.readUInt16LE(at + 6) !== entry.flags ||
    archive.readUInt16LE(at + 8) !== entry.method ||
    archive.readUInt32LE(at + 14) !== entry.crc ||
    archive.readUInt32LE(at + 18) !== entry.compressedSize ||
    archive.readUInt32LE(at + 22) !== entry.size ||
    archive.toString('utf8', nameStart, nameStart + nameLength) !== entry.name
  ) {
    throw new ZipFormatError('local header does not match the central directory');
  }
  return { headerStart: at, dataStart, dataEnd };
}

/**
 * Inflates at most the declared size: zlib throws instead of allocating past it. (Node requires a
 * limit of at least 1; a declared-empty member that inflates to 1 byte then fails the size check.)
 */
function inflateMember(entry: Entry, compressed: Buffer): Buffer {
  if (entry.method === STORED) return Buffer.from(compressed);
  try {
    return inflateRawSync(compressed, { maxOutputLength: Math.max(entry.size, 1) });
  } catch {
    // A corrupt stream, or output past the declared size (RangeError ERR_BUFFER_TOO_LARGE).
    throw new ZipFormatError('member failed to decompress within its declared size');
  }
}

/**
 * The end-of-central-directory record: the last signature whose comment length runs exactly to
 * the end of the archive.
 */
function findEndOfCentralDirectory(archive: Buffer): number {
  if (archive.length < EOCD_SIZE) throw new ZipFormatError('end of central directory not found');
  const lowest = Math.max(0, archive.length - EOCD_SIZE - MAX_COMMENT);
  for (let at = archive.length - EOCD_SIZE; at >= lowest; at--) {
    if (
      archive.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY &&
      at + EOCD_SIZE + archive.readUInt16LE(at + 20) === archive.length
    ) {
      return at;
    }
  }
  throw new ZipFormatError('end of central directory not found');
}
