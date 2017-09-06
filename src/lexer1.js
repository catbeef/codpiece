import { UTF8ToCPs } from 'codpoint';
import { Writable } from 'stream';
import fs from 'fs';
import util from 'util';

const stat = util.promisify(fs.stat);

const DEFAULT_SIZE = 2 ** 16;

const CR = 0x000D;
const LF = 0x000A;
const LS = 0x2028;
const PS = 0x2029;

export default class Lexer extends Writable {
  constructor({ size=DEFAULT_SIZE }={}) {
    this.column      = 0;
    this.error       = undefined;
    this.index       = 0;
    this.lastCPWasCR = false;
    this.lastColumn  = 0;
    this.lastLine    = 0;
    this.lexComplete = false;
    this.line        = 0;
    this.source      = new Uint32Array(size);
    this.startIndex  = 0;
    this.startLine   = 0;
    this.startColumn = 0;
  }

  codepoint() {
    this.error = new Error(`${ this.constructor.name } missing codepoint()`);

    /*
      A realized lexer should implement codepoint(), which should call
      advancePosition() or discard() whenever a goal symbol is completed. In
      practice this can be a method with shifting identity following lexical
      state, rather than a single definition.

      The codepoint() method will receive the non-codepoint sentinel value -1 as
      an EOI signal. An EOI token is also automatically pushed to token() by
      default.

      A realized parser would likewise implement token(); however a generic
      implementation is provided that just emits tokens as events, e.g. for
      testing.

      Either may call fail(msg) to halt the stream and emit an error annotated
      with contextual information.

      The token() method may retrieve source strings corresponding to tokens
      received with getString() when necessary. The pattern here attempts to
      minimize unnecessary allocations while still permitting useful error
      messages and providing enough data for source map generation or use in
      CST parsing.
    */
  }

  advancePosition(tokenType, consumedCurrent=true) {
    const terminalIndex = consumedCurrent ? this.index : this.index - 1;

    if (tokenType) this.token(
      tokenType,
      this.startIndex,
      terminalIndex,
      this.startLine,
      this.startColumn
    );

    this.startIndex  = terminalIndex;
    this.startLine   = consumedCurrent ? this.line : this.lastLine;
    this.startColumn = consumedCurrent ? this.column : this.lastColumn;

    if (!consumedCurrent) this.codepoint(this.source[terminalIndex]);
  }

  discard(consumedCurrent=true) {
    this.advancePosition(undefined, consumedCurrent);
  }

  fail(msg) {
    // The 'evident at' language is to clarify that the line and column
    // information indicates the point in the input where the error became
    // known as such, which is usually but not necessarilly the same position as
    // that of the logically offending codepoint.

    this.error = new Error(
      `${ msg } ` +
      `[evident at line ${ this.line }, column ${ this.column }] ` +
      `(... ${ this.getString(Math.max(0, this.index - 10), this.index) })`
    );
  }

  getString(start, end) {
    return String.fromCodePoint(...this.source.subarray(start, end));
  }

  reconsume(count) {

  }

  token(tokenType, start, end, line, column) {
    // Intended for testing lexing without parsing; parser classes would
    // overwrite this method.

    const string = this.getString(start, end);

    this.emit('token',{ start, end, line, column, string });
  }

  _finish(done) {
    if (this.error) return;

    if (this.lexComplete) {
      done(new Error('lex _finish called again after EOI'));
      return;
    }

    this.lexComplete = true;

    this.source = this.source.subarray(0, this.index);

    this.codepoint(-1);

    if (!this.error)
      this.token('EOI', this.index, this.index, this.line, this.column);

    done(this.error);
  }

  _write(buffer, enc, done) {
    if (this.error) return;

    if (this.lexComplete) {
      done(new Error('lex _write called again after EOI'));
      return;
    }

    // Expand source buffer if needed

    const cpCount = buffer.length / 4;

    if (this.source.length - this.index < cpCount) {
      const newLength = Math.max(cpCount, this.source.length) * 2;
      const newSource = new Uint32Array(newLength);

      newSource.set(this.source);

      this.source = newSource;
    }

    // Append new codepoints to source buffer

    const newCPs = new Uint32Array(buffer.buffer, buffer.offset, cpCount);

    this.source.set(newCPs, this.index);

    // Pass new codepoints into the pipeline and track line/column/index

    for (const cp of newCPs) {
      if (this.lastCPWasCR && cp !== LF) {
        this.lastLine = this.line;
        this.lastColumn = this.column;
        this.line++,
        this.column = 0;
      }

      this.index++;

      this.codepoint(cp);


      if (this.error) break;

      this.lastCPWasCR = cp === CR;
      this.lastColumn = this.column;

      if (cp === LF || cp === LS || cp === PS) {
        this.lastLine = this.line;
        this.line++;
        this.column = 0;
      } else {
        this.column++;
      }
    }

    done(this.error);
  }

  static async fromFilename(filename, opts) {
    opts = Object.assign({}, opts);

    if (opts.size === undefined) {
      opts.size = (await stat(filename)).size;
    }

    const src = fs.createReadStream(filename);
    const decoder = new this.constructor.Decoder(this.constructor.decoderOpts);
    const processor = new this(opts);

    src.pipe(decoder).pipe(processor);

    return processor;
  }
}

Object.defineProperties(Lexer, {
  Decoder: { value: UTF8ToCPs },
  decoderOpts: { value: { discardBOM: true } }
});
