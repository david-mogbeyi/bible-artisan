import { crc32, deflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { readCorpusArtifact } from './corpus-importer';
import { ENGWEBP_RELEASE } from './engwebp-release';
import { MAX_MEMBER_BYTES, readZip, ZipFormatError } from './zip';

const archive = readCorpusArtifact(ENGWEBP_RELEASE);

interface MemberSpec {
  name: string;
  data: Buffer;
  method?: 0 | 8;
  /** Overrides written into the local header only. */
  local?: Partial<{ name: string; flags: number; method: number; crc: number; size: number }>;
  /** Overrides written into the central directory entry only. */
  central?: Partial<{ flags: number; size: number; localOffset: number }>;
  /** Raw compressed bytes to store instead of compressing `data`. */
  compressed?: Buffer;
}

/** Builds a ZIP archive (local headers, central directory, EOCD) from scratch. */
function buildZip(
  members: MemberSpec[],
  eocd: Partial<{ entryCount: number; directorySize: number; comment: Buffer }> = {},
): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const m of members) {
    const method = m.method ?? 8;
    const compressed = m.compressed ?? (method === 8 ? deflateRawSync(m.data) : m.data);
    const crc = crc32(m.data);
    const name = Buffer.from(m.name);
    const localName = Buffer.from(m.local?.name ?? m.name);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(m.local?.flags ?? 0, 6);
    local.writeUInt16LE(m.local?.method ?? method, 8);
    local.writeUInt32LE(m.local?.crc ?? crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(m.local?.size ?? m.data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    locals.push(local, localName, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(m.central?.flags ?? 0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(m.central?.size ?? m.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(m.central?.localOffset ?? offset, 42);
    centrals.push(central, name);
    offset += 30 + localName.length + compressed.length;
  }
  const directory = Buffer.concat(centrals);
  const comment = eocd.comment ?? Buffer.alloc(0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(eocd.entryCount ?? members.length, 8);
  end.writeUInt16LE(eocd.entryCount ?? members.length, 10);
  end.writeUInt32LE(eocd.directorySize ?? directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(comment.length, 20);
  return Buffer.concat([...locals, directory, end, comment]);
}

/** Placeholder member content (no Scripture). */
const placeholder = (n: number): Buffer => Buffer.from('ab'.repeat(n));

function zipFailure(bytes: Buffer): { code: string; message: string } | undefined {
  try {
    readZip(bytes);
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ZipFormatError);
    const { code, message } = error as ZipFormatError;
    return { code, message };
  }
}

const failsWith = (bytes: Buffer, message: string): void => {
  expect(zipFailure(bytes)).toStrictEqual({ code: 'CORPUS_ZIP_FORMAT', message });
};

describe('readZip', () => {
  it('reads every member of the committed WEB artifact, CRC-checked', () => {
    const members = readZip(archive);
    const usfm = [...members.keys()].filter((name) => name.endsWith('.usfm'));
    // 66 canon books plus front matter and glossary.
    expect(usfm).toHaveLength(68);
    expect(members.has('copr.htm')).toBe(true);
  });

  it('reads a well-formed archive built from scratch, stored and deflated, with a comment', () => {
    const zip = buildZip(
      [
        { name: 'a.txt', data: placeholder(10), method: 0 },
        { name: 'b.txt', data: placeholder(500) },
      ],
      { comment: Buffer.from('comment') },
    );
    expect(readZip(zip)).toStrictEqual(
      new Map([
        ['a.txt', placeholder(10)],
        ['b.txt', placeholder(500)],
      ]),
    );
  });

  it('refuses an archive whose central directory CRC does not match a member', () => {
    const corrupt = Buffer.from(archive);
    const eocd = corrupt.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const firstEntry = corrupt.readUInt32LE(eocd + 16);
    corrupt[firstEntry + 16] = (corrupt[firstEntry + 16] ?? 0) ^ 0xff;
    failsWith(corrupt, 'local header does not match the central directory');
  });

  describe('truncated archives', () => {
    const zip = buildZip([
      { name: 'a.txt', data: placeholder(50) },
      { name: 'b.txt', data: placeholder(50) },
    ]);

    it.each([
      ['empty input', 0],
      ['shorter than an EOCD record', 10],
      ['cut inside the members', 40],
      ['cut inside the central directory', zip.length - 40],
      ['cut inside the EOCD record', zip.length - 5],
    ])('refuses %s', (_case, length) => {
      failsWith(zip.subarray(0, length), 'end of central directory not found');
    });

    it('refuses the real artifact cut short', () => {
      failsWith(archive.subarray(0, archive.length - 100), 'end of central directory not found');
    });

    it('refuses an EOCD whose comment length runs past the end', () => {
      const bad = Buffer.from(zip);
      bad.writeUInt16LE(10, bad.length - 2);
      failsWith(bad, 'end of central directory not found');
    });
  });

  describe('inconsistent archives', () => {
    const one = (spec: Partial<MemberSpec>): Buffer =>
      buildZip([{ name: 'a.txt', data: placeholder(50), ...spec }]);

    it.each<[string, Buffer, string]>([
      [
        'a local name that differs from the central directory',
        one({ local: { name: 'b.txt' } }),
        'local header does not match the central directory',
      ],
      [
        'a local method that differs',
        one({ local: { method: 0 } }),
        'local header does not match the central directory',
      ],
      [
        'local flags that differ',
        one({ local: { flags: 0x0800 } }),
        'local header does not match the central directory',
      ],
      [
        'a local size that differs',
        one({ local: { size: 7 } }),
        'local header does not match the central directory',
      ],
      [
        'a local CRC that differs',
        one({ local: { crc: 1 } }),
        'local header does not match the central directory',
      ],
      [
        'a local offset past the central directory',
        one({ central: { localOffset: 0x7fffffff } }),
        'member out of range',
      ],
      [
        'a local offset that is not a local header',
        one({ central: { localOffset: 2 } }),
        'bad local file header',
      ],
      [
        'a central directory size that does not match its entries',
        buildZip([{ name: 'a.txt', data: placeholder(5) }], { directorySize: 47 + 5 }),
        'central directory out of range',
      ],
      [
        'more entries than the central directory holds',
        buildZip([{ name: 'a.txt', data: placeholder(5) }], { entryCount: 2 }),
        'central directory truncated',
      ],
      [
        'an encrypted member',
        one({ central: { flags: 0x0001 }, local: { flags: 0x0001 } }),
        'encrypted members are not supported',
      ],
      [
        'a data descriptor',
        one({ central: { flags: 0x0008 }, local: { flags: 0x0008 } }),
        'data descriptors are not supported',
      ],
      [
        'a ZIP64 size marker',
        one({ central: { size: 0xffffffff } }),
        'ZIP64 archives are not supported',
      ],
      [
        'a duplicate member name',
        buildZip([
          { name: 'a.txt', data: placeholder(5) },
          { name: 'a.txt', data: placeholder(6) },
        ]),
        'duplicate member name',
      ],
      [
        'a stored member whose bytes do not match its CRC',
        one({ method: 0, compressed: Buffer.alloc(100, 0x61) }),
        'member failed its size or CRC-32 check',
      ],
      [
        'a corrupt deflate stream',
        one({ compressed: Buffer.from([0xff, 0xff, 0xff, 0xff]) }),
        'member failed to decompress within its declared size',
      ],
    ])('refuses %s', (_case, bytes, message) => {
      failsWith(bytes, message);
    });

    it('refuses an unsupported compression method', () => {
      const zip = one({});
      const directory = zip.readUInt32LE(zip.length - 22 + 16);
      zip.writeUInt16LE(12, directory + 10); // bzip2, in the central directory
      failsWith(zip, 'unsupported compression method');
    });

    it('refuses members that overlap (a local header hidden inside another member)', () => {
      // Member "a" is stored and its bytes are a complete local header + data for member "b";
      // the central directory points "b" into the middle of "a".
      const inner = buildZip([{ name: 'b.txt', data: placeholder(5), method: 0 }]);
      const innerMember = inner.subarray(0, 30 + 'b.txt'.length + 10);
      const outer = buildZip([
        { name: 'a.txt', data: innerMember, method: 0 },
        { name: 'b.txt', data: placeholder(5), method: 0, central: { localOffset: 30 + 5 } },
      ]);
      failsWith(outer, 'overlapping members');
    });
  });

  describe('decompression limits', () => {
    it('stops a deflate bomb at its declared size instead of inflating it', () => {
      // 8 MiB of zeros deflates to a few KiB; the member declares 1 KiB.
      const bomb = deflateRawSync(Buffer.alloc(8 * 1024 * 1024));
      expect(bomb.length).toBeLessThan(16 * 1024);
      const zip = buildZip([{ name: 'bomb.txt', data: Buffer.alloc(1024), compressed: bomb }]);
      failsWith(zip, 'member failed to decompress within its declared size');
    });

    it('refuses a member that declares more than the per-member limit', () => {
      const zip = buildZip([
        { name: 'big.txt', data: placeholder(5), central: { size: MAX_MEMBER_BYTES + 1 } },
      ]);
      failsWith(zip, 'member too large');
    });
  });
});
