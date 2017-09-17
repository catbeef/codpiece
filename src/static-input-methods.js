import fs from 'fs';
import util from 'util';

const stat = util.promisify(fs.stat);

// Given a (utf8) buffer and constructor opts, returns an instance which has
// been fed the buffer.

export function fromBuffer(buffer, opts={}) {
  if (!(buffer instanceof Buffer))
    throw new TypeError(`expected a Buffer, received ${ buffer }`);

  opts = Object.assign({}, opts);

  if (opts.size === undefined)
    opts.size = buffer.length;

  const decoder = new this.Decoder(this.decoderOpts);
  const processor = new this(opts);

  decoder.pipe(processor);

  setImmediate(() => decoder.end(buffer));

  return processor;
}

// Given a Uint32Array of CPs and constructor opts, returns an instance which
// has been fed this as input directly.

export function fromCPs(cps, opts={}) {
  if (!(cps instanceof Uint32Array))
    throw new TypeError(`expected a Uint32Array, received ${ cps }`);

  opts = Object.assign({}, opts);

  if (opts.size === undefined)
    opts.size = cps.length;

  const processor = new this(opts);
  const emit = err => processor.emit('error', err);

  setImmediate(() => {
    processor._write(new Buffer(cps.buffer), undefined, emit);
    if (!processor._error) processor._finish(emit);
  });

  return processor;
}

// Given a filename and options for the constructor, creates and pipes a file
// stream in for processing and resolves the processor. If the options object is
// absent or otherwise does not include 'size', the size will be looked up in
// advance.

export async function fromFilename(filename, opts={}) {
  if (typeof filename !== 'string')
    throw new TypeError(`expected a filename string, received ${ filename }`);

  opts = Object.assign({}, opts);

  if (opts.size === undefined)
    opts.size = (await stat(filename)).size;

  if (opts.debug) {
    console.log(`\ninput file is "${ filename }"`);
    console.log(`input size resolved to ${ opts.size } bytes`);
  }

  const src = fs.createReadStream(filename);
  const decoder = new this.Decoder(this.decoderOpts);
  const processor = new this(opts);

  setImmediate(() => {
    if (opts.debug) {
      console.time('processing time');

      processor.on('finish', () => {
        console.log('\n');
        console.timeEnd('processing time');
        console.log(`${ processor._tokensLength / 4 } tokens lexed`);

        const errs = processor._errors;
        const count = errs.length;

        if (count) {
          console.log(`${ count } error${ count === '1' ? '' : 's' }:\n`);

          for (const err of processor._errors) {
            console.log('');
            console.log(err);
          }
        } else {
          console.log('no errors');
        }
      });
    }
    src.pipe(decoder).pipe(processor)
  });

  return processor;
}
