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

const NEW_LINES = /(?:\r\n|[\n\r\u2028\u2029])+/g;
const SPACES = / +/g;
const OTHER_CONTROL = /[\0-\x1F\x80-x9F]/g;

const format = (light, dark) => str => `${ light }${
  str
    .replace(NEW_LINES, ws => `${ dark }${ '¶'.repeat(ws.length) }${ light }`)
    .replace(SPACES, ws => `${ dark }${ '·'.repeat(ws.length) }${ light }`)
    .replace(OTHER_CONTROL, char =>
      String.raw`${ dark }\x${
        char.codePointAt(0).toString(16).toUpperCase().fill(2, '0')
      }${ light }`
    )
  }\u001b[39m`;

const formatNeutral = format('\x1B[38;5;242m', '\x1B[38;5;241m');
const formatRed = format('\x1B[38;5;197m', '\x1B[38;5;203m');

export default class Lexer extends Writable {
  constructor({ size=DEFAULT_SIZE }={}) {
    super();

    this._ended        = false;
    this._error        = undefined;
    this._column       = 0;
    this._lastCPWasCR  = false;
    this._length       = 0;
    this._lex          = this.$input;
    this._line         = 0;
    this._size         = size;
    this._source       = new Uint32Array(size);
    this._positions    = new Uint16Array(size * 2);
    this._tokenStart   = 0;
    this._tokens       = new Uint32Array(size * 2);
    this._tokensLength = 0;
    this._tokensSize   = size;
  }

  getCP(index) {
    return this._source[index];
  }

  getLineAndColumn(index) {
    index = Math.imul(index, 2);
    return this._positions.subarray(index, index + 1);
  }

  getLineAndColumnForToken(index) {
    index = Math.imul(index, 2) + 1;
    return this.getLineAndColumn(this._tokens[index]);
  }

  getSegment(start, end) {
    return this._source.subarray(start, end);
  }

  getSegmentForToken(index) {
    const start = this._tokens[Math.imul(index, 2) + 1];
    const next = index + 1;
    const end = this._tokensLength > next
      ? this._tokens[Math.imul(next, 2) + 1]
      : this._length;

    return this.getSegment(start, end);
  }

  getString(start, end) {
    return String.fromCodePoint(...this.getSegment(start, end));
  }

  getStringForToken(index) {
    return String.fromCodePoint(...this.getSegmentForToken(index));
  }

  getToken(index) {
    return this._tokens[Math.imul(index, 2)];
  }

  // Given a new buffer of CPs, adds them to the source buffer and returns them
  // with the appropriate typed array view. The meat here is the logic that will
  // expand the allocated source buffer if necessary. If the size provided at
  // construction time was actually the size of the input (or greater), this
  // reallocation will never be necessary.

  _append(buffer) {
    const cpCount = buffer.length / 4;

    if (this._size - this._length < cpCount) {
      const newSize      = Math.imul(Math.max(cpCount, this._size), 2);
      const newSource    = new Uint32Array(newSize);
      const newPositions = new Uint16Array(Math.imul(newSize, 2));

      newPositions.set(this._positions);
      newSource.set(this._source);

      this._positions = newPositions;
      this._size      = newSize;
      this._source    = newSource;
    }

    const newCPs = new Uint32Array(buffer.buffer, buffer.offset, cpCount);

    this._source.set(newCPs, this._length);

    return newCPs;
  }

  // Sets the _error property to a new error with the given message, augmented
  // with contextual information about where the failure occurred. By default
  // in the snippet the currently untokenized sequence up to the point of
  // unambiguous offense (from the lexical perspective) is highlighted, but this
  // can be customized. Note that errors are always terminal and abort lexing /
  // parsing.

  _fail(msg, start=this._tokenStart, end=this._length) {
    const [ line, column ] = this.getLineAndColumn(end - 1);

    const offendingLength = Math.min(60, end - start);
    const offendingEnd = start + offendingLength;
    const priorContextMaxLength = 60 - offendingLength;
    const priorContextStart = Math.max(0, start - priorContextMaxLength);
    const priorContext = this.getString(priorContextStart, start);
    const offendingSequence = this.getString(start, offendingEnd);
    const index = priorContext.length + 1;

    this.getString(start, end);

    this._error = new Error(
      `${ msg } [at line ${ line }, column ${ column }]\n` +
      `------------------------------------------------------------\n` +
      `${ formatNeutral(priorContext) }${ formatRed(offendingSequence) }` +
      `^`.padStart(index, ' ') +
      `------------------------------------------------------------\n`
    );
  }

  // Writable implementation. This is our EOI signal, which we need to pass
  // into the lexing logic.

  _finish(done) {
    if (this._error)
      return;

    if (this._ended)
      return done(new Error(`_finish called after already in _ended state`));

    this._ended = true;

    this._lex(-1);

    done(this._error);
  }

  // During _lex() the _reconsume() method may be called to effectively
  // backtrack. Not all grammars will need to ever do this; technically it could
  // always be avoided but it can be more practical than alternatives in some
  // cases, and it is used internally when creating greedy tokens since it is
  // such a common need.

  _reconsume(newState, n) {
    this._lex = newState;

    if (this._ended) {
      this._length -= --n;

      for (let i = 0; i < n; i++) {
        this._lex(this._source[this._length++]);
        if (this._error) break;
      }

      this._lex(-1);
    } else {
      this._length -= n;

      for (let i = 0; i < n; i++) {
        this._lex(this._source[this._length++]);
        if (this._error) break;
      }
    }
  }

  // To be called by _lex() when a token is finalized, with or without a number
  // indicating an unprocessed remainder. Tokens are represented as a
  // Uint32Array of paired values where the even indices are token enum values
  // and the odd indices correspond to a start index in the source buffer.

  _token(value, remainder=0) {
    const actualLength = Math.imul(this._tokensLength, 2);

    if (actualLength === this._tokensSize) {
      const newTokensSize = Math.imul(this._tokensSize, 2);
      const newTokens = new Uint32Array(newTokensSize);

      newTokens.set(this._tokens);

      this._tokensSize = newTokensSize;
      this._tokens = newTokens;
    }

    this._tokens[actualLength] = value;
    this._tokens[actualLength + 1] = this._tokenStart;
    this._tokensLength++;

    if (remainder) {
      this._tokenStart = this._length - remainder;
      this._reconsume(this.$input, remainder);
    } else {
      this._lex = this.$input;
      this._tokenStart = this._length;
    }
  }

  _write(buffer, enc, done) {
    if (this._error)
      return;

    if (this._ended)
      return done(new Error(`_write called after already in _ended state`));

    const cps = this._append(buffer);

    let pIndex = Math.imul(this._length, 2);

    for (let i = 0; i < cps.length; i++) {
      const cp = cps[i];

      if (this._lastCPWasCR && cp !== LF) {
        this._line++;
        this._column = 0;
      }

      this._positions[pIndex++] = this._line;
      this._positions[pIndex++] = this._column;
      this._lastCPWasCR = cp === CR;
      this._length++;

      this._lex(cp);

      if (this._error) return done(this._error);

      if (cp === LF || cp === LS || cp === PS) {
        this._line++;
        this._column = 0;
      } else {
        this._column++;
      }
    }

    done();
  }

  // Lexing states in subclasses should be implemented as methods that accept a
  // cp and may do some combination of the following:
  //
  // - move to a new state (e.g. this._lex = this.$foo)
  // - call this._fail(msg)
  // - call this._reconsume(newState, count)
  // - call this._token(tokenValue, unconsumedCount?)
  // - maintain arbitrary additional grammar-specific state
  // - nothing (i.e. accretion states)
  //
  // It is expected that the initial state be called $input.

  $input() {
    throw new Error(`$input not implemented on lexer`);
  }

  // Subclasses should call this static method once to define their token name
  // mapping. The indices of the strings will become the internal values.

  static defineTokens(tokensByValue) {
    if (this.hasOwnProperty('TOKENS'))
      throw new Error(`tokens already defined`);

    if (!(tokensByValue instanceof Array))
      throw new TypeError(`defineTokens accepts only an array of strings`);

    if (tokensByValue.some(tokenName => typeof tokenName !== 'string'))
      throw new TypeError(`defineTokens accepts only an array of strings`);

    if (new Set(tokensByValue).size !== tokensByValue.length)
      throw new TypeError(`defineTokens array must contain no duplicates`);

    const tokensByName = tokensByValue.reduce(
      (acc, tokenName, index) => Object.assign(acc, { [tokenName]: index }),
      {}
    );

    Object.defineProperties(this, {
      TOKENS: { value: Object.freeze(tokensByName) },
      SNEKOT: { value: Object.freeze(tokensByValue.slice()) }
    });
  }
}

Object.defineProperties(Lexer, {
  Decoder: { value: UTF8ToCPs },
  decoderOpts: { value: { discardBOM: true } }
});

Object.defineProperties(Lexer.prototype, {
  TOKENS: { value: Object.freeze({}) },
  SNEKOT: { value: Object.freeze([]) }
});
