// 无依赖的 STORE（不压缩）ZIP 生成器：导出包要求确定性、可逐字节核对，
// 且避免为打包引入第三方依赖。文件名一律 UTF-8（置位标志第 11 位）。
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let value = 0xffffffff;
  for (let index = 0; index < data.length; index++) value = CRC_TABLE[(value ^ data[index]) & 0xff] ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

export type ZipEntry = { name: string; data: Buffer };

export function buildZip(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(size, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, entry.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += 30 + name.length + size;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, eocd]);
}

export class ZipFormatError extends Error {}
const MAX_ENTRY_BYTES = 64 * 1024 * 1024;
const MAX_ENTRIES = 20000;

// 严格解析 STORE ZIP：仅接受本工具生成的结构；拒绝压缩方法、路径穿越、
// 异常规模与签名不符的内容。
export function parseZip(zip: Buffer, allowedName: (name: string) => boolean): Map<string, Buffer> {
  let eocdOffset = -1;
  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 70000); index--) {
    if (zip.readUInt32LE(index) === 0x06054b50) { eocdOffset = index; break; }
  }
  if (eocdOffset < 0) throw new ZipFormatError('ZIP 结束记录缺失。');
  const entryCount = zip.readUInt16LE(eocdOffset + 8);
  const declaredCount = zip.readUInt16LE(eocdOffset + 10);
  if (entryCount !== declaredCount || entryCount > MAX_ENTRIES) throw new ZipFormatError('ZIP 文件项数异常。');
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  if (centralOffset > zip.length) throw new ZipFormatError('ZIP 中央目录越界。');
  const entries = new Map<string, Buffer>();
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014b50) throw new ZipFormatError('ZIP 中央目录损坏。');
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    if (method !== 0) throw new ZipFormatError('ZIP 仅支持不压缩的条目。');
    const name = zip.slice(cursor + 46, cursor + 46 + nameLength).toString('utf8');
    if (!allowedName(name)) throw new ZipFormatError(`ZIP 包含不允许的文件项：${name}`);
    if (entries.has(name)) throw new ZipFormatError(`ZIP 包含重复文件项：${name}`);
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipFormatError('ZIP 本地头损坏。');
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength;
    if (dataStart + compressedSize > zip.length) throw new ZipFormatError('ZIP 条目数据越界。');
    const data = zip.slice(dataStart, dataStart + compressedSize);
    if (data.length > MAX_ENTRY_BYTES) throw new ZipFormatError('ZIP 条目超过大小限制。');
    if (crc32(data) !== zip.readUInt32LE(cursor + 16)) throw new ZipFormatError(`ZIP 条目摘要不符：${name}`);
    entries.set(name, Buffer.from(data));
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}
