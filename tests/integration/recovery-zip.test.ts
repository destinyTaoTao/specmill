import { describe, expect, it } from 'vitest';
import { buildZip, parseZip, zipSize, ZipFormatError } from '../../src/server/recovery/zip.js';

describe('recovery ZIP validation', () => {
  it('calculates the exact STORE ZIP length for empty, binary and UTF-8 entries', () => {
    for (const entries of [[], [{ name: '中文/文件', data: Buffer.from([0, 1, 255]) }, { name: 'empty', data: Buffer.alloc(0) }]]) {
      expect(zipSize(entries)).toBe(buildZip(entries).length);
    }
  });
  it.each([20001, 65535])('accepts a legacy ZIP with %i entries', count => {
    const entries = Array.from({ length: count }, (_, index) => ({ name: `entry-${index}`, data: Buffer.alloc(0) }));
    const decoded = parseZip(buildZip(entries), () => true);
    expect(decoded.size).toBe(count);
    expect(decoded.has(`entry-${count - 1}`)).toBe(true);
  }, 30000);
  it('rejects an export that exceeds the classic ZIP entry limit', () => {
    expect(() => buildZip(Array.from({ length: 65536 }, () => ({ name: 'a', data: Buffer.alloc(0) })))).toThrow('ZIP 文件项超过格式上限');
  });
  it('rejects symbolic links', () => {
    const original = buildZip([{ name: 'records.json', data: Buffer.from('{}') }]);
    const central = original.readUInt32LE(original.length - 6);
    const symlink = Buffer.from(original);
    symlink.writeUInt16LE(0x0314, central + 4);
    symlink.writeUInt32LE((0xa1ff * 0x10000) >>> 0, central + 38);
    expect(() => parseZip(symlink, () => true)).toThrow(ZipFormatError);
  });

  it('rejects inconsistent headers, sizes and directory bounds', () => {
    const original = buildZip([{ name: 'records.json', data: Buffer.from('{}') }]);
    const central = original.readUInt32LE(original.length - 6);
    const mismatchedName = Buffer.from(original);
    mismatchedName[30] ^= 1;
    const mismatchedSize = Buffer.from(original);
    mismatchedSize.writeUInt32LE(3, central + 24);
    const invalidDirectory = Buffer.from(original);
    invalidDirectory.writeUInt32LE(1, invalidDirectory.length - 10);
    const mismatchedCrc = Buffer.from(original);
    mismatchedCrc.writeUInt32LE(0, 14);
    for (const zip of [mismatchedName, mismatchedSize, invalidDirectory, mismatchedCrc]) {
      expect(() => parseZip(zip, () => true)).toThrow(ZipFormatError);
    }
  });

  it('rejects overlapping entries before hashing their contents', () => {
    const inner = buildZip([{ name: 'inner', data: Buffer.from('payload') }]);
    const innerLocal = inner.subarray(0, inner.readUInt32LE(inner.length - 6));
    const zip = buildZip([{ name: 'outer', data: innerLocal }, { name: 'inner', data: Buffer.from('payload') }]);
    const central = zip.readUInt32LE(zip.length - 6);
    const secondCentral = central + 46 + Buffer.byteLength('outer');
    zip.writeUInt32LE(30 + Buffer.byteLength('outer'), secondCentral + 42);
    // 头部一致但摘要错误：重叠检查应在读取大量条目数据之前失败。
    zip.writeUInt32LE(0, 14);
    zip.writeUInt32LE(0, central + 16);
    expect(() => parseZip(zip, () => true)).toThrow('ZIP 条目重叠');
  });
});
