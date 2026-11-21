import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { deflateRawSync } from 'node:zlib';

import { readZipEntryText } from '../src/ios/shared/zipEntry.ts';

interface Entry {
  readonly name: string;
  readonly text: string;
  readonly method: 0 | 8;
}

/**
 * A zip the way a streaming archiver writes it: local headers carry a data
 * descriptor flag and zero sizes, so only the central directory has them.
 */
function streamedZip(entries: readonly Entry[], comment = ''): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = Buffer.from(entry.text, 'utf8');
    const data = entry.method === 8 ? deflateRawSync(raw) : raw;
    const name = Buffer.from(entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(0x0008, 6);
    local.writeUInt16LE(entry.method, 8);
    local.writeUInt16LE(name.length, 26);
    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(data.length, 8);
    descriptor.writeUInt32LE(raw.length, 12);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x0008, 8);
    central.writeUInt16LE(entry.method, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data, descriptor);
    centrals.push(central, name);
    offset += local.length + name.length + data.length + descriptor.length;
  }
  const directory = Buffer.concat(centrals);
  const commentBytes = Buffer.from(comment, 'utf8');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(commentBytes.length, 20);
  return Buffer.concat([...locals, directory, end, commentBytes]);
}

describe('reading one file out of an artifact zip', () => {
  const entry = '{"runId":"41","plannedMinutes":90}\n';

  it('reads a deflated entry whose sizes live only in the central directory', () => {
    const archive = streamedZip([
      { name: 'other.txt', text: 'not this one', method: 0 },
      { name: 'entry.json', text: entry, method: 8 },
    ]);
    assert.equal(readZipEntryText(archive, 'entry.json'), entry);
  });

  it('reads a stored entry and finds the end record behind an archive comment', () => {
    const archive = streamedZip([{ name: 'entry.json', text: entry, method: 0 }], 'written by a test');
    assert.equal(readZipEntryText(archive, 'entry.json'), entry);
  });

  it('refuses an archive without the file, a truncated archive, and bytes that are no zip', () => {
    const archive = streamedZip([{ name: 'entry.json', text: entry, method: 8 }]);
    assert.throws(() => readZipEntryText(archive, 'missing.json'), /holds no missing\.json/);
    assert.throws(() => readZipEntryText(archive.subarray(0, 40), 'entry.json'));
    assert.throws(() => readZipEntryText(Buffer.from('plain text, long enough to scan for a record'), 'entry.json'),
      /no end of central directory/);
    assert.throws(() => readZipEntryText(Buffer.alloc(4), 'entry.json'), /shorter than its end record/);
  });

  it('refuses a compression method the artifact service never writes', () => {
    const archive = streamedZip([{ name: 'entry.json', text: entry, method: 8 }]);
    const directoryOffset = archive.readUInt32LE(archive.length - 22 + 16);
    archive.writeUInt16LE(12, directoryOffset + 10);
    assert.throws(() => readZipEntryText(archive, 'entry.json'), /unsupported compression method 12/);
  });
});
