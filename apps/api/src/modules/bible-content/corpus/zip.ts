import { crc32, inflateRawSync } from 'node:zlib';

/** A ZIP archive that is malformed, uses an unsupported feature, or fails its CRC check. */
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
const MAX_COMMENT = 0xffff;

/**
 * Reads every member of a ZIP archive into memory: stored or deflated members only, no ZIP64, no
 * encryption, no multi-disk archives (none of which the eBible artifact uses). Each member's
 * CRC-32 and size are checked against the central directory, so a corrupt artifact fails here
 * rather than producing silently different text. Only ever called on bytes whose SHA-256 was
 * already checked against the pinned release, so this is an integrity backstop, not a parser
 * for hostile input.
 */
export function readZip(archive: Buffer): Map<string, Buffer> {
  const eocd = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const directorySize = archive.readUInt32LE(eocd + 12);
  let offset = archive.readUInt32LE(eocd + 16);
  if (archive.readUInt16LE(eocd + 4) !== 0 || archive.readUInt16LE(eocd + 8) !== entryCount) {
    throw new ZipFormatError('multi-disk archives are not supported');
  }
  if (offset + directorySize > eocd) throw new ZipFormatError('central directory out of range');

  const members = new Map<string, Buffer>();
  for (let i = 0; i < entryCount; i++) {
    if (archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new ZipFormatError('bad central directory entry');
    }
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const crc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    if (flags & 0x1) throw new ZipFormatError('encrypted members are not supported');
    if (members.has(name)) throw new ZipFormatError('duplicate member name');
    if (archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
      throw new ZipFormatError('bad local file header');
    }
    const dataStart =
      localOffset +
      30 +
      archive.readUInt16LE(localOffset + 26) +
      archive.readUInt16LE(localOffset + 28);
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    if (compressed.length !== compressedSize) throw new ZipFormatError('member out of range');

    let data: Buffer;
    if (method === STORED) data = Buffer.from(compressed);
    else if (method === DEFLATED) data = inflateRawSync(compressed);
    else throw new ZipFormatError('unsupported compression method');

    if (data.length !== size || crc32(data) !== crc) {
      throw new ZipFormatError('member failed its size or CRC-32 check');
    }
    members.set(name, data);
  }
  return members;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  const lowest = Math.max(0, archive.length - EOCD_SIZE - MAX_COMMENT);
  for (let at = archive.length - EOCD_SIZE; at >= lowest; at--) {
    if (archive.readUInt32LE(at) === END_OF_CENTRAL_DIRECTORY) return at;
  }
  throw new ZipFormatError('end of central directory not found');
}
