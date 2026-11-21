import { inflateRawSync } from 'node:zlib';

/**
 * One named file out of a zip archive, as the Actions artifact download
 * endpoint serves it. The central directory is authoritative: the artifact
 * service streams its archives, so a local header may carry a data
 * descriptor instead of the sizes.
 */

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const END_RECORD_SIZE = 22;
const MAX_COMMENT_SIZE = 0xffff;

function endOfCentralDirectory(archive: Buffer): number {
  const lowest = Math.max(0, archive.length - END_RECORD_SIZE - MAX_COMMENT_SIZE);
  for (let offset = archive.length - END_RECORD_SIZE; offset >= lowest; offset -= 1) {
    if (archive.readUInt32LE(offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new Error('zip archive has no end of central directory record');
}

function entryData(archive: Buffer, localOffset: number, compressedSize: number, method: number): Buffer {
  if (archive.readUInt32LE(localOffset) !== LOCAL_FILE_HEADER) {
    throw new Error('zip central directory points at no local file header');
  }
  const start = localOffset + 30 + archive.readUInt16LE(localOffset + 26) + archive.readUInt16LE(localOffset + 28);
  const data = archive.subarray(start, start + compressedSize);
  if (data.length !== compressedSize) throw new Error('zip entry is truncated');
  if (method === 0) return data;
  if (method === 8) return inflateRawSync(data);
  throw new Error(`zip entry uses unsupported compression method ${method}`);
}

/**
 * The UTF-8 text of `fileName` in `archive`.
 *
 * @throws when the archive is malformed or holds no such file.
 */
export function readZipEntryText(archive: Buffer, fileName: string): string {
  if (archive.length < END_RECORD_SIZE) throw new Error('zip archive is shorter than its end record');
  const end = endOfCentralDirectory(archive);
  const entries = archive.readUInt16LE(end + 10);
  let offset = archive.readUInt32LE(end + 16);
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > archive.length || archive.readUInt32LE(offset) !== CENTRAL_DIRECTORY_ENTRY) {
      throw new Error('zip central directory is malformed');
    }
    const method = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === fileName) return entryData(archive, localOffset, compressedSize, method).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new Error(`zip archive holds no ${fileName}`);
}
