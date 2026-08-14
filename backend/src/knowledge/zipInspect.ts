const eocdSignature = 0x06054b50;
const centralFileHeaderSignature = 0x02014b50;
const maxCommentLength = 65_535;
const zip64Sentinel = 0xFFFFFFFF;

export type ZipEntry = {
  name: string;
  compressedSize: number;
  uncompressedSize: number;
};

export type ZipInspection = {
  entries: ZipEntry[];
  uncompressedTotal: number;
  compressedTotal: number;
};

export function inspectZip(buffer: Buffer): ZipInspection {
  const eocdOffset = findEocd(buffer);
  if (eocdOffset < 0) {
    throw new Error('Not a valid ZIP archive');
  }

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (entryCount === 0xFFFF || centralDirectoryOffset === zip64Sentinel) {
    throw new Error('ZIP64 archives are not supported');
  }

  const entries: ZipEntry[] = [];
  let offset = centralDirectoryOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== centralFileHeaderSignature) {
      throw new Error('ZIP central directory is corrupt');
    }

    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (uncompressedSize === zip64Sentinel || compressedSize === zip64Sentinel) {
      throw new Error('ZIP64 archives are not supported');
    }

    entries.push({ name, compressedSize, uncompressedSize });
    offset += 46 + nameLength + extraLength + commentLength;
  }

  return {
    entries,
    uncompressedTotal: entries.reduce((total, entry) => total + entry.uncompressedSize, 0),
    compressedTotal: entries.reduce((total, entry) => total + entry.compressedSize, 0)
  };
}

function findEocd(buffer: Buffer) {
  const minOffset = Math.max(0, buffer.length - (22 + maxCommentLength));
  for (let offset = buffer.length - 22; offset >= minOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === eocdSignature) return offset;
  }
  return -1;
}
