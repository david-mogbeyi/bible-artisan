import { describe, expect, it } from 'vitest';
import { readCorpusArtifact } from './corpus-importer';
import { ENGWEBP_RELEASE } from './engwebp-release';
import { readZip, ZipFormatError } from './zip';

const archive = readCorpusArtifact(ENGWEBP_RELEASE);

describe('readZip', () => {
  it('reads every member of the committed WEB artifact, CRC-checked', () => {
    const members = readZip(archive);
    const usfm = [...members.keys()].filter((name) => name.endsWith('.usfm'));
    // 66 canon books plus front matter and glossary.
    expect(usfm).toHaveLength(68);
    expect(members.has('copr.htm')).toBe(true);
  });

  it('refuses an archive whose central directory CRC does not match a member', () => {
    const corrupt = Buffer.from(archive);
    const eocd = corrupt.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const firstEntry = corrupt.readUInt32LE(eocd + 16);
    corrupt[firstEntry + 16] = (corrupt[firstEntry + 16] ?? 0) ^ 0xff;
    expect(() => readZip(corrupt)).toThrow(ZipFormatError);
  });

  it('refuses a truncated archive', () => {
    expect(() => readZip(archive.subarray(0, archive.length - 100))).toThrow(ZipFormatError);
  });
});
