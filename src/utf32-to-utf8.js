import { Readable } from 'stream';
import fs from 'fs';

// Note that we deliberately do not confirm that codepoints are valid scalars.
// In most cases we will have previously decoded as UTF8, so we already know
// they are; in the other cases we will have decoded as WTF8, and we want to
// preserve that. CPs out of range should not appear either way.

export default class UTF32ToUTF8 extends Readable {
  constructor(src) {
    super();

    this._index = 0;
    this._src = src;
  }

  _read(size) {
    const buf = new Uint8Array(size * 4);

    let bufIndex = 0;

    while (size-- && this._index < this._src.length) {
      const cp = this._src[this._index];

      if (cp < 0x80) {
        buf[bufIndex++] = cp;
        this._index++;
        continue;
      }

      if (cp < 0x800) {
        if (size < 2) break;
        buf[bufIndex++] = (cp & 0b11111000000) >> 6 | 0b11000000;
        buf[bufIndex++] = cp & 0b111111 | 0b10000000;
        this._index++;
        continue;
      }

      if (cp < 0x10000) {
        if (size < 3) break;
        buf[bufIndex++] = (cp & 0b1111000000000000) >> 12 | 0b11100000,
        buf[bufIndex++] = (cp & 0b111111000000) >> 6 | 0b10000000,
        buf[bufIndex++] = cp & 0b111111 | 0b10000000;
        this._index++;
        continue;
      }

      if (size < 4) break;

      buf[bufIndex++] = (cp & 0b111000000000000000000) >> 18 | 0b11110000,
      buf[bufIndex++] = (cp & 0b111111000000000000) >> 12 | 0b10000000,
      buf[bufIndex++] = (cp & 0b111111000000) >> 6 | 0b10000000,
      buf[bufIndex++] = cp & 0b111111 | 0b10000000;
      this._index++;
    }

    this.push(buf.subarray(0, bufIndex));

    if (this._index === this._src.length) this.push(null);
  }
}

export function writeSourceToFile(fileName) {
  return new Promise((fulfill, reject) => {
    fs.unlink(fileName, err => {
      if (err && err.code !== 'ENOENT') return reject(err);

      const writable = fs.createWriteStream(fileName);
      const source   = this._source.subarray(0, this._sourceLength);
      const readable = new UTF32ToUTF8(source);

      writable.on('error', err => fs.unlink(fileName, () => reject(err)));
      writable.on('close', fulfill);
      readable.on('error', err => writable.destroy(err));
      readable.pipe(writable);
    });
  });
}
