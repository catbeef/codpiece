import { UTF8ToCPs } from 'codpoint';
import { Readable, Writable } from 'stream';
import fs from 'fs';
import util from 'util';

const stat = util.promisify(fs.stat);

const DEFAULT_SIZE = 2 ** 16;

const CR = 0x000D;
const LF = 0x000A;
const LS = 0x2028;
const PS = 0x2029;

const C1_AND_SPACE =
  /[\0-\x20]+/g;

const C2_AND_INVISIBLES =
  /[\x80-\xA0\xAD\u2000-\u200F\u2028-\u202F\u205F-\u2064\u2066-\u206F]+/g;

const DELETE =
  /\x7F+/g;

const cc1 = ([ ...chars ]) =>
  String.fromCodePoint(...chars.map(char => char.codePointAt(0) + 0x2400));

const cc2 = ([ ...chars ]) => `\\u${
  chars.map(char => char
    .codePointAt(0)
    .toString(16)
    .toUpperCase()
    .padStart(4, '0')
  ).join('\\u')
}`;

const formatDelete = ({ length }) =>
  '\u2421'.repeat(length);

const format = (light, dark) => str => `${ light }${
  str
    .replace(C1_AND_SPACE, str => `${ dark }${ cc1(str) }${ light }`)
    .replace(DELETE, str => `${ dark }${ formatDelete(str) }${ light }`)
    .replace(C2_AND_INVISIBLES, str => `${ dark }${ cc2(str) }${ light }`)
}\x1B[39m`;

const formatNeutral = format('\x1B[38;5;248m', '\x1B[38;5;240m');
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
    this._tokenMeta    = undefined;
    this._tokenMetas   = new Map();
    this._tokenStart   = 0;
    this._tokenValue   = undefined;
    this._tokenValues  = new Map();
    this._tokens       = new Uint32Array(size * 2);
    this._tokensLength = 0;
    this._tokensSize   = size;
  }

  // The method naming convention here signals more than "public" vs "private".
  // Methods without a prefix character are reasonable to call at any time
  // (provided the indices are in bounds). Most methods and properties with an
  // underscore prefix may be called or accessed by lexer/parser subclasses, but
  // they concern transient state that only makes sense in the context of an
  // ongoing parse; they should not be called from outside or relied on after
  // the parse is complete. This is true as well for $dollarPrefixed methods,
  // which are the "mobile" lexer methods associated with particular states, and
  // is also true of the parsing layer’s $$doubleDollarGenerator methods.

  // External API. Note that in the interest of efficiency these methods are
  // _not_ guarded and the caller should not indiscriminately fetch cps, tokens,
  // slices etc without taking into account provided knowledge of which indices
  // are valid. These methods are mainly intended for use within the parsing
  // layer.

  // Returns the unnormalized CP at the specified index in the codepoint input
  // stream.

  getCP(index) {
    return this._source[index];
  }

  // Returns an unnormalized CP within a token. So if the source value of token
  // 666 is [ 0x30, 0x31, 0x32 ], calling getCPOfToken(666, 1) return 0x31.

  getCPOfToken(index, internalIndex=0) {
    return this._source[this._tokens[Math.imul(index, 2) + 1] + internalIndex];
  }

  // Returns a [ line, column ] pair describing the position of the unnormalized
  // CP at the specified index.

  getLineAndColumn(index) {
    index = Math.imul(index, 2);
    return this._positions.subarray(index, index + 2);
  }

  // Returns a [ line, column ] pair describing the starting position of the
  // token at the specified index in the token stream. This is intended for the
  // construction of source maps.

  getLineAndColumnForToken(index) {
    return this.getLineAndColumn(this._tokens[Math.imul(index, 2) + 1]);
  }

  // Returns a window on the source buffer from the start to end index. Like
  // Array.prototype.slice, start is inclusive and end is exclusive; however the
  // segment is a _live_ window, not a copy, and should not normally be mutated.

  getSegment(start, end) {
    return this._source.subarray(start, end);
  }

  // As above for getSegment, but taking a token index rather than `start` and
  // `end`; the return value is the unnormalized source cps of the token.

  getSegmentForToken(index) {
    const tokenIndexIndex = Math.imul(index, 2) + 1;
    const start = this._tokens[tokenIndexIndex];
    const end = this._tokensLength > index + 1
      ? this._tokens[tokenIndexIndex + 2]
      : this._tokenStart;

    return this.getSegment(start, end);
  }

  // As above but permits extracting a segment from within the token segment.
  // The third integer may be negative.

  getSegmentOfToken(index, start=0, end) {
    const tokenIndexIndex = Math.imul(index, 2) + 1;
    const tokenStart = this._tokens[tokenIndexIndex];

    if (end >= 0) {
      end = tokenStart + end;
    } else {
      const tokenEnd = this._tokensLength > index + 1
        ? this._tokens[tokenIndexIndex + 2]
        : this._tokenStart;

      end = end === undefined ? tokenEnd : tokenEnd + end;
    }

    return this.getSegment(start, end);
  }

  // The same as getSegment, but the array is coerced to string.

  getString(start, end) {
    return String.fromCodePoint(...this.getSegment(start, end));
  }

  // The same as getSegmentForToken, but the array is coerced to string. Note
  // the distinction from getTokenStringValue below.

  getStringForToken(index) {
    return String.fromCodePoint(...this.getSegmentForToken(index));
  }

  // Returns the identity of a token at the specified index; this is an integer
  // which will correspond to one of TOKENS.foo, TOKENS.bar, etc.

  getToken(index) {
    return this._tokens[Math.imul(index, 2)];
  }

  // Returns associated metadata for the specified token index, if it exists.
  // The _tokenMetas map can contain anything, though I would avoid creating
  // objects when primitives would suffice (additional interpretive methods may
  // overlay that).

  getTokenMeta(index) {
    return this._tokenMetas.get(index);
  }

  // This method is intended for use when testing mainly; it is not an efficent
  // way to manage tokens. Subclasses may augment this further.

  getTokenObject(index) {
    const [ line, column ] = this.getLineAndColumnForToken(index);

    return {
      column, line,
      source : this.getStringForToken(index),
      type   : this.constructor.SNEKOT[this.getToken(index)],
      value  : this.getTokenStringValue(index)
    };
  }

  // It is common to derive a "working value" for a token during the lexing
  // phase, for example by converting escape sequences in string literals or
  // identifiers. This method will return such a normalized value if applicable
  // or else the original string.

  getTokenStringValue(index) {
    return this._tokenValues.has(index)
      ? this._tokenValues.get(index)
      : this.getStringForToken(index);
  }

  // Related to the above; when it is necessary to distinguish between cases
  // where normalization was applied or was not (for example, in determining
  // whether an identifier which would be parsed as a keyword contained escape
  // sequences, which is typically disallowed), one may call this for a
  // boolean result.

  getTokenHasDistinctStringValue(index) {
    return this._tokenValues.has(index);
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

    this.getString(start, end);

    this._error = new Error(
      `${ msg } [at line ${ line }, column ${ column }]\n` +
      `------------------------------------------------------------\n` +
      `${ formatNeutral(priorContext) }${ formatRed(offendingSequence) }` +
      `------------------------------------------------------------\n`
    );
  }

  // This is a part of the Writable stream implementation interface. It acts as
  // our EOI signal, which we pass into the lexing logic as the sentinel value
  // -1.

  _finish(done) {
    if (this._error)
      return;

    if (this._ended)
      return done(new Error(`_finish called after already in _ended state`));

    this._ended = true;

    this._lex(-1);

    done(this._error);
  }

  // Subclasses can override this to provide normalization behavior to input
  // before it gets passed to _lex. It may return undefined, which will cause
  // the cp to be skipped. Although I know of no examples where normalization
  // would convert one cp to multiple cps, if this were needed I suppose you
  // could call _lex(firstArtificialCP) within this function. Note that this
  // method does not alter the raw source.

  _normalize(cp) {
    return cp;
  }

  // Method which will be called as new tokens become available.

  _onToken(i) {
    /* ... */
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
  // and the odd indices correspond to a start index in the source buffer; these
  // enum-like values are created with the static method defineTokens as part of
  // the lexer definition.
  //
  // Each time _token is called, the start index of the next token is set (the
  // remainder being taken into account). If a _tokenValue or _tokenMeta have
  // been created as part of the lexing process, these will be snatched up and
  // reset as well. The lexical state is reset to $input, and if a remainder was
  // indicated, it will be reconsumed from there.

  _token(value, remainder=0) {
    const actualLength = Math.imul(this._tokensLength, 2);

    if (actualLength === this._tokensSize) {
      const newTokensSize = Math.imul(this._tokensSize, 2);
      const newTokens = new Uint32Array(newTokensSize);

      newTokens.set(this._tokens);

      this._tokensSize = newTokensSize;
      this._tokens = newTokens;
    }

    if (this._tokenValue) {
      this._tokenValues.set(
        this._tokensLength,
        String.fromCodePoint(...this._tokenValue)
      );

      this._tokenValue = undefined;
    }

    if (this._tokenMeta !== undefined) {
      this._tokenMetas.set(this._tokensLength, this._tokenMeta);
      this._tokenMeta = undefined;
    }

    this._tokens[actualLength] = value;
    this._tokens[actualLength + 1] = this._tokenStart;

    if (remainder) {
      this._tokenStart = this._length - remainder;
      this._lex = this.$input;

      if (this._ended) {
        this._length -= --remainder;
        this._onToken(this._tokensLength++);

        for (let i = 0; i < remainder; i++) {
          this._lex(this._source[this._length++]);
          if (this._error) break;
        }

        this._lex(-1);
      } else {
        this._length -= remainder;
        this._onToken(this._tokensLength++);

        for (let i = 0; i < remainder; i++) {
          this._lex(this._source[this._length++]);
          if (this._error) break;
        }
      }

    } else {
      this._lex = this.$input;
      this._tokenStart = this._length;
      this._onToken(this._tokensLength++);
    }
  }

  // This is part of the Writable implementation interface. It receives a buffer
  // of little endian 32bit unsigned integers which represent the codepoints
  // which compose the source and are fed into the lexing methods, and as part
  // of this process, line and column positions are tracked.
  //
  // The line and column counts are zero-indexed. New lines begin _after_ CR+LF,
  // CR or LF alone, and after \u2028 and \u2029; this definition of line
  // terminators is taken from the EcmaScript spec. The sourcemap specification
  // mentions that the line+column system was chosen over a simple index to
  // account for system line terminator differences, but it does not ever define
  // what constitutes a line, so I have assumed that it follows ES for now (as
  // ES was the original language associated with this system).

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

      const normalizedCP = this._normalize(cp);

      if (normalizedCP !== undefined) this._lex(normalizedCP);

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

  // Given a (utf8) buffer and constructor opts, returns an instance which has
  // been fed the buffer.

  static fromBuffer(buffer, opts={}) {
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

  static fromCPs(cps, opts={}) {
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
  // stream in for processing and resolves the processor. If the options object
  // is absent or otherwise does not include 'size', the size will be looked up
  // in advance.

  static async fromFilename(filename, opts={}) {
    if (typeof filename !== 'string')
      throw new TypeError(`expected a filename string, received ${ filename }`);

    opts = Object.assign({}, opts);

    if (opts.size === undefined)
      opts.size = (await stat(filename)).size;

    const src = fs.createReadStream(filename);
    const decoder = new this.Decoder(this.decoderOpts);
    const processor = new this(opts);

    setImmediate(() => src.pipe(decoder).pipe(processor));

    return processor;
  }

  // Just more alternative interface stuff. Not very polished. Ad hoc async
  // iterator for token objects. Not efficient, do not use except for testing.

  static * asyncTokenIterator(input, opts) {
    const stream = new this.TokenStream(input, opts);
    const tokens = [];

    let error, fulfill, reject;

    stream.on('data', newTokens => {
      tokens.push(...newTokens);
      if (fulfill) fulfill(tokens.shift());
      fulfill = reject = undefined;
    });

    stream.on('error', err => {
      if (reject) reject(err);
      else error = err;
      fulfill = reject = undefined;
    });

    while (true) {
      if (fulfill) throw new Error(
        `Cannot call next() until prior promise is resolved`
      );

      while (tokens.length) {
        if (error) throw error;
        yield Promise.resolve(tokens.shift());
      }

      if (error) throw error;

      if (stream._processor._ended) return;

      yield new Promise((_fulfill, _reject) => {
        fulfill = _fulfill;
        reject = _reject;
      });
    }
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

// This is intended mainly for testing, but could be useful in other
// circumstances.

class TokenStream extends Readable {
  constructor(Processor, input, opts) {
    super({ objectMode: true });

    this._tokens = [];

    const prop = processor => {
      processor.on('error', err => this.emit('error', err));
      processor.on('token', token => {
        if (this._tokens.length === 0) this.push(token);
        else this._tokens.push(token);
      });
    }

    if (typeof input === 'string')
      Processor
        .fromFilename(input, opts)
        .then(processor => this._processor = prop(processor))
        .catch(err => this.emit('error', err));
    else if (input instanceof Buffer)
      this._processor = prop(Processor.fromBuffer(input, opts));
    else if (input instanceof Uint32Array)
      this._processor = prop(Processor.fromCPs(input, opts));
    else
      throw new TypeError(`Expected Buffer, Uint32Array, or filename string`);
  }

  _read() {
    while (this._tokens.length) {
      this.push(this._tokens.shift());
      if (this._processor._error) return;
    }

    if (this._processor && this._processor._ended)
      this.push(null);
  }
}

const TOKEN_STREAM_MAP = new WeakMap();

Object.defineProperties(Lexer, {
  Decoder: { value: UTF8ToCPs },
  TokenStream: {
    get() {
      if (!TOKEN_STREAM_MAP.has(this))
        TOKEN_STREAM_MAP.set(this, TokenStream.bind(null, class extends this {
          _onToken(index) {
            this.emit('token', this.getTokenObject(index));
          }
        }));

      return TOKEN_STREAM_MAP.get(this);
    }
  },
  decoderOpts: { value: { discardBOM: true } },
  TOKENS: { value: Object.freeze({}) },
  SNEKOT: { value: Object.freeze([]) }
});
