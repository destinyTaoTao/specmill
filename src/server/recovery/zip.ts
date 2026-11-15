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
export class ZipFormatError extends Error {}
export const MAX_ZIP_ENTRIES = 65535;

// STORE 格式的本地头、中央目录和结束记录都没有额外字段。
export function zipSize(entries: ZipEntry[]): number {
  return 22 + entries.reduce((total, entry) => total + 30 + 46 + 2 * Buffer.byteLength(entry.name, 'utf8') + entry.data.length, 0);
}

export function buildZip(entries: ZipEntry[]): Buffer {
  if (entries.length > MAX_ZIP_ENTRIES) throw new ZipFormatError('ZIP 文件项超过格式上限。');
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

const MAX_ENTRY_BYTES = 64 * 1024 * 1024;

// 严格解析 STORE ZIP：仅接受本工具生成的结构；拒绝压缩方法、路径穿越、
// 异常规模与签名不符的内容。
export function parseZip(zip: Buffer, allowedName: (name: string) => boolean): Map<string, Buffer> {
  let eocdOffset = -1;
  for (let index = zip.length - 22; index >= Math.max(0, zip.length - 70000); index--) {
    if (zip.readUInt32LE(index) === 0x06054b50) { eocdOffset = index; break; }
  }
  if (eocdOffset < 0) throw new ZipFormatError('ZIP 结束记录缺失。');
  if (zip.readUInt16LE(eocdOffset + 4) !== 0 || zip.readUInt16LE(eocdOffset + 6) !== 0 ||
      eocdOffset + 22 + zip.readUInt16LE(eocdOffset + 20) !== zip.length) throw new ZipFormatError('ZIP 结束记录异常。');
  const entryCount = zip.readUInt16LE(eocdOffset + 8);
  const declaredCount = zip.readUInt16LE(eocdOffset + 10);
  if (entryCount !== declaredCount || entryCount > MAX_ZIP_ENTRIES) throw new ZipFormatError('ZIP 文件项数异常。');
  const centralOffset = zip.readUInt32LE(eocdOffset + 16);
  const centralSize = zip.readUInt32LE(eocdOffset + 12);
  if (centralOffset + centralSize !== eocdOffset) throw new ZipFormatError('ZIP 中央目录越界。');
  const names = new Set<string>();
  const localRanges: { name: string; start: number; dataStart: number; end: number; crc: number }[] = [];
  let cursor = centralOffset;
  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > eocdOffset || zip.readUInt32LE(cursor) !== 0x02014b50) throw new ZipFormatError('ZIP 中央目录损坏。');
    const flags = zip.readUInt16LE(cursor + 8);
    const method = zip.readUInt16LE(cursor + 10);
    const compressedSize = zip.readUInt32LE(cursor + 20);
    const uncompressedSize = zip.readUInt32LE(cursor + 24);
    const nameLength = zip.readUInt16LE(cursor + 28);
    const extraLength = zip.readUInt16LE(cursor + 30);
    const commentLength = zip.readUInt16LE(cursor + 32);
    const localOffset = zip.readUInt32LE(cursor + 42);
    const nextCursor = cursor + 46 + nameLength + extraLength + commentLength;
    if (nextCursor > eocdOffset || zip.readUInt16LE(cursor + 34) !== 0) throw new ZipFormatError('ZIP 中央目录损坏。');
    if (flags !== 0x0800 || method !== 0 || compressedSize !== uncompressedSize) throw new ZipFormatError('ZIP 仅支持 UTF-8 不压缩的条目。');
    if (compressedSize > MAX_ENTRY_BYTES) throw new ZipFormatError('ZIP 条目超过大小限制。');
    const platform = zip.readUInt16LE(cursor + 4) >>> 8;
    const unixMode = zip.readUInt32LE(cursor + 38) >>> 16;
    if (platform === 3 && (unixMode & 0xf000) === 0xa000) throw new ZipFormatError('ZIP 不支持符号链接。');
    const nameBytes = zip.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBytes.toString('utf8');
    if (!allowedName(name)) throw new ZipFormatError(`ZIP 包含不允许的文件项：${name}`);
    if (names.has(name)) throw new ZipFormatError(`ZIP 包含重复文件项：${name}`);
    names.add(name);
    if (localOffset + 30 > centralOffset || zip.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipFormatError('ZIP 本地头损坏。');
    const localNameLength = zip.readUInt16LE(localOffset + 26);
    const dataStart = localOffset + 30 + localNameLength + zip.readUInt16LE(localOffset + 28);
    if (dataStart + compressedSize > centralOffset || localNameLength !== nameLength ||
        !zip.subarray(localOffset + 30, localOffset + 30 + localNameLength).equals(nameBytes) ||
        zip.readUInt16LE(localOffset + 6) !== flags || zip.readUInt16LE(localOffset + 8) !== method ||
        zip.readUInt32LE(localOffset + 14) !== zip.readUInt32LE(cursor + 16) ||
        zip.readUInt32LE(localOffset + 18) !== compressedSize || zip.readUInt32LE(localOffset + 22) !== uncompressedSize) throw new ZipFormatError('ZIP 本地头与中央目录不一致。');
    localRanges.push({ name, start: localOffset, dataStart, end: dataStart + compressedSize, crc: zip.readUInt32LE(cursor + 16) });
    cursor = nextCursor;
  }
  if (cursor !== eocdOffset) throw new ZipFormatError('ZIP 中央目录大小不符。');
  localRanges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < localRanges.length; index++) {
    if (localRanges[index].start < localRanges[index - 1].end) throw new ZipFormatError('ZIP 条目重叠。');
  }
  // 在复制或计算摘要前先确认条目互不重叠，避免恶意目录反复引用大段数据。
  const entries = new Map<string, Buffer>();
  for (const range of localRanges) {
    const data = zip.subarray(range.dataStart, range.end);
    if (crc32(data) !== range.crc) throw new ZipFormatError(`ZIP 条目摘要不符：${range.name}`);
    entries.set(range.name, Buffer.from(data));
  }
  return entries;
}
