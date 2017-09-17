import { WTF8ToCPs } from 'codpoint';
import { Writable } from 'stream';
import { writeSourceToFile } from './utf32-to-utf8';
import { formatRed } from './err-format';
import { fromBuffer, fromCPs, fromFilename } from './static-input-methods';

// CSS has some interesting properties that make it a bit challenging to parse,
// despite its lack of complex structures or hidden left recursion. In some ways
// the lexing is more tricky than the parsing. This mainly owes to the fact that
// there is no input which cannot be parsed as the goal symbol(s)*. From a user
// perspective this is "error correction" or "recovery", and the spec does
// describe (some) of these cases as such, even though, by virtue of those
// strategies being unambiguously mandated by the language spec, these "errors"
// are effectively legal (somewhat like ASI, I guess). A matter of perspective,
// then, and you can disable the typical handling by passing in recover: false
// if you want to throw on the first "error". Otherwise errors will be collected
// and exposed as part of the result (though note that some things which may
// intuitively seem like errors are not considered to be by the spec at all).
//
// This behavior makes perfect sense in light of CSS’s near and long term goals,
// like being forgiving on the web and ensuring that future language extensions
// can be easily added without creating backwards incompatibility.
//
// The second concern is that CSS is not described at the lexical level in
// formal grammar terms. Rather it is described as an abstract algorithm that
// you must behave as if you were following. In theory that’s actually perfect
// for this sort of by-hand parser (paint by numbers), except that the abstract
// algorithm employs a conceit which presumes the codepoints may be consumed or
// looked at without consumption. This is certainly common in real world
// parsers, but no good for us, since we want to parse in real time with
// streaming input. That means each instruction which presumes we have this
// (sometimes rather complex) non-consumptive lookahead facility must be
// translated into a linear realization of distinct states. Usually this is
// simple, but sometimes it can get hairy (e.g. the instructions for consuming
// a hash token are surpisingly complex when linearized).
//
// Finally things are complicated a bit further by the fact that CSS has a
// "modular" spec, and the relationships between the modules are not always
// particularly transparent. Each module has one or more versions. The latest
// versions on the W3C site are quite confusing. For example, the syntax spec
// and the selectors spec describe and operate on different lexical grammars,
// and to some extent those grammars aren’t really compatible (e.g. the numeric
// productions). Fortunately the versions published by WHATWG (drafts.csswg.org)
// have addressed these issues, so those are the ones I operated off of.

// * In formal terms, this makes CSS the "same language" as HTML, which also
//   describes the infinite set. They differ only in the parse trees produced.
//   Just a stray thought, no particular significance.

const DEFAULT_SIZE = 2 ** 16;

const AT_KEYWORD_TOKEN         =  0;
const BAD_STRING_TOKEN         =  1;
const BAD_URL_TOKEN            =  2;
const CDC_TOKEN                =  3;
const CDO_TOKEN                =  4;
const COLON_TOKEN              =  5;
const COMMA_TOKEN              =  6;
const DELIM_TOKEN              =  7;
const DIMENSION_TOKEN          =  8;
const FUNCTION_TOKEN           =  9;
const HASH_TOKEN               = 10;
const IDENT_TOKEN              = 11;
const LEFT_BRACE_TOKEN         = 12;
const LEFT_BRACKET_TOKEN       = 13;
const LEFT_PARENTHESIS_TOKEN   = 14;
const NUMBER_TOKEN             = 15;
const PERCENTAGE_TOKEN         = 16;
const RIGHT_BRACE_TOKEN        = 17;
const RIGHT_BRACKET_TOKEN      = 18;
const RIGHT_PARENTHESIS_TOKEN  = 19;
const SEMICOLON_TOKEN          = 20;
const STRING_TOKEN             = 21;
const URL_TOKEN                = 22;
const WHITESPACE_TOKEN         = 23;
const __COMMENT_TOKEN__        = 24; // Not technically a token.

const EOF_SENTINEL = 0x110000;

// Ultimately, switch is faster than any other kind of check until the number of
// cases is very high. Though verbose, these rip.

const isHex = cp => {
  switch (cp) {
    case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35: case 0x36:
    case 0x37: case 0x38: case 0x39: case 0x41: case 0x42: case 0x43: case 0x44:
    case 0x45: case 0x46: case 0x61: case 0x62: case 0x63: case 0x64: case 0x65:
    case 0x66:
      return true;
    default:
      return false;
  }
};

const isNameContinue = cp => {
  switch (cp) {
    case 0x2D: case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
    case 0x36: case 0x37: case 0x38: case 0x39: case 0x41: case 0x42: case 0x43:
    case 0x44: case 0x45: case 0x46: case 0x47: case 0x48: case 0x49: case 0x4A:
    case 0x4B: case 0x4C: case 0x4D: case 0x4E: case 0x4F: case 0x50: case 0x51:
    case 0x52: case 0x53: case 0x54: case 0x55: case 0x56: case 0x57: case 0x58:
    case 0x59: case 0x5A: case 0x5F: case 0x61: case 0x62: case 0x63: case 0x64:
    case 0x65: case 0x66: case 0x67: case 0x68: case 0x69: case 0x6A: case 0x6B:
    case 0x6C: case 0x6D: case 0x6E: case 0x6F: case 0x70: case 0x71: case 0x72:
    case 0x73: case 0x74: case 0x75: case 0x76: case 0x77: case 0x78: case 0x79:
    case 0x7A:
      return true;
    default:
      return cp >= 0x80;
  }
};

const isNameStart = cp => {
  switch (cp) {
    case 0x41: case 0x42: case 0x43: case 0x44: case 0x45: case 0x46: case 0x47:
    case 0x48: case 0x49: case 0x4A: case 0x4B: case 0x4C: case 0x4D: case 0x4E:
    case 0x4F: case 0x50: case 0x51: case 0x52: case 0x53: case 0x54: case 0x55:
    case 0x56: case 0x57: case 0x58: case 0x59: case 0x5A: case 0x5F: case 0x61:
    case 0x62: case 0x63: case 0x64: case 0x65: case 0x66: case 0x67: case 0x68:
    case 0x69: case 0x6A: case 0x6B: case 0x6C: case 0x6D: case 0x6E: case 0x6F:
    case 0x70: case 0x71: case 0x72: case 0x73: case 0x74: case 0x75: case 0x76:
    case 0x77: case 0x78: case 0x79: case 0x7A:
      return true;
    default:
      return cp >= 0x80;
  }
};

const normalizeEscapeCP = cp => {
  if (cp === 0 || cp > 0x10FFFF)
    return 0xFFFD;
  if (cp > 0xDFFF)
    return cp;
  if (cp > 0xD7FF)
    return 0xFFFD;

  return cp;
};

const toHexValue = cp =>
  cp & 0b1000000 ? cp + 0x09 & 0b1111 : cp ^ 0b110000;

const formatAndTruncate = src => src.length > 20
  ? `${ formatRed(String.fromCodePoint(...src.subarray(0, 14))) } [...]`
  : `${ formatRed(String.fromCodePoint(...src)) }${
    ' '.repeat(20 - src.length)
  }`;

export default class CSSParser extends Writable {
  constructor({ debug, recover=true, size=DEFAULT_SIZE }={}) {
    if (!Number.isInteger(size) || size < 0)
      throw new TypeError('size must be a positive integer');

    super();

    this._column              = 0;
    this._error               = undefined;
    this._errors              = [];
    this._escapeCount         = 0;
    this._escapeCP            = 0;
    this._floatValues         = new Float64Array(size);
    this._floatValuesLength   = 0;
    this._hashTokenIsID       = false;
    this._intValues           = new Int32Array(size);
    this._intValuesLength     = 0;
    this._lastCPWasCR         = false;
    this._lex                 = this.$input;
    this._lexAfterEscape      = this.$input;
    this._line                = 0;
    this._numericTokenIsFloat = false;
    this._numericTokenValue   = 0;
    this._positions           = new Uint32Array(Math.imul(size, 2));
    this._positionsLength     = 0;
    this._recover             = Boolean(recover);
    this._source              = new Uint32Array(size);
    this._sourceLength        = 0;
    this._stringDelimiter     = 0;
    this._stringValues        = new Uint32Array(size);
    this._stringValuesLength  = 0;
    this._stringValuesStart   = 0;
    this._tokens              = new Uint32Array(Math.imul(size, 4));
    this._tokensLength        = 0;
    this._urlWhitespaceCount  = 0;

    if (debug === 'LEXING') {
      console.log(
        `\nDEBUGGING CSS LEXER...\n\n` +
        `LINE | CLMN | TOKEN TYPE        | SOURCE               | META\n` +
        `-----|------|-------------------|----------------------|--------------`
      );

      this._token = this._printToken;
    }

    // The tokens array takes the following form:
    //
    // [ tokenType, sourceIndex, specialValue1, specialValue2, <repeat> ]
    //
    // The meaning of specialValue depends on the tokenType:
    //
    // - AT_KEYWORD_TOKEN, FUNCTION_TOKEN, IDENT_TOKEN, STRING_TOKEN, URL_TOKEN
    //
    //   For these, the special values indicate the start and end indices of
    //   a string value in the _stringValues buffer. These string values are
    //   distinct from source because they describe the string after escapes
    //   have been decoded; further, they are "bare", so that for example the
    //   string value of an AT_KEYWORD_TOKEN whose source is "@keyframes" would
    //   be "keyframes".
    //
    //   :: _getStringValueOfNonHashToken(index)
    //   :: _testSimpleStringValue(index, cps)
    //
    // - HASH_TOKEN
    //
    //   Hash token is like those above, except the start index includes an
    //   extra final bit indicating whether the token is of "ID" or
    //   "UNRESTRICTED" type.
    //
    //   :: _getHashTokenIsID(index)
    //   :: _getStringValueOfHashToken(index)
    //
    // - DELIM_TOKEN
    //
    //   Delim tokens always correspond to a single codepoint; the sv1 is simply
    //   that codepoint, while sv2 is unused.
    //
    //   :: _getDelimTokenCP(index)
    //
    // - PERCENTAGE_TOKEN
    //
    //   For percentage tokens, sv1 is the index of the numeric value in the
    //   _floatValues array.
    //
    //   :: _getNumericValueOfPercentageToken(index)
    //
    // - NUMBER_TOKEN
    //
    //   For number tokens, sv1 indicates whether the value is an integer (0) or
    //   float (1), while sv2 indicates the index in the corresponding value
    //   array (_intValues or _floatValues).
    //
    //   :: _getNumberTokenIsFloat(index)
    //   :: _getNumericValueOfNumberToken(index)
    //
    // - DIMENSION_TOKEN
    //
    //   Dimension tokens have more information associated with them than any
    //   other type. For these, sv1 and sv2 are start and end indices in
    //   _stringValues, describing the identifier (unit) substring. However,
    //   within _stringValues, the sv2 index and sv2 index + 1 will additionally
    //   encode the int/float and number value indices, as with number tokens.
    //
    //   :: _getDimensionTokenIsFloat(index)
    //   :: _getNumericValueOfDimensionToken(index)
    //   :: _getStringValueOfNonHashToken(index)
    //   :: _testSimpleStringValue(index, cps)
    //
    // All other tokens do not employ sv1 or sv2.
  }

  // META //////////////////////////////////////////////////////////////////////

  // This is a safety valve to allow buffers to expand if the original size was
  // smaller than the input. Provided the size was known correctly in advance,
  // which should typically be the case, this will never be called.

  _expandBuffers(min) {
    const length       = Math.imul(Math.max(this._sourceLength, min), 2);
    const floatValues  = new Float64Array(length);
    const intValues    = new Int32Array(length);
    const positions    = new Uint32Array(Math.imul(length, 2));
    const source       = new Uint32Array(length);
    const stringValues = new Uint32Array(length);
    const tokens       = new Uint32Array(Math.imul(length, 4));

    floatValues.set(this._floatValues);
    intValues.set(this._intValues);
    positions.set(this._positions);
    source.set(this._source);
    stringValues.set(this._stringValues);
    tokens.set(this._tokens);

    this._floatValues  = floatValues;
    this._intValues    = intValues;
    this._positions    = positions;
    this._source       = source;
    this._stringValues = stringValues;
    this._tokens       = tokens;
  }

  // At various points, this may be called by lexing or parsing states to signal
  // an error. Depending on the "recover" setting, this will either be terminal
  // or the errors will be accreted and accessible later.

  _fail(module, hash) {
    const badTokenStart = this._tokensLength === 0
      ? 0
      : this._tokens[this._tokensLength - 3];

    const sourceStart    = Math.max(badTokenStart - 15, 0);
    const startOffset    = badTokenStart - sourceStart;
    const actualEnd      = this._positionsLength / 2;
    const sourceEnd      = Math.min(sourceStart + 45, actualEnd);
    const sourceLength   = sourceEnd - sourceStart;
    const source         = this._source.subarray(sourceStart, sourceEnd);
    const sourceText     = formatRed(String.fromCodePoint(...source));
    const positionOffset = this._sourceLength - badTokenStart;
    const pointerPrefix  = ' '.repeat(startOffset);
    const pointer        = '^'.repeat(positionOffset);
    const sourcePointer  = (pointerPrefix + pointer).slice(0, sourceLength);
    const pIndex         = Math.imul(badTokenStart, 2);
    const line           = this._positions[pIndex];
    const column         = this._positions[pIndex + 1];
    const disambigLine   = this._line;
    const disambigCol    = this._column;
    const url            = `https://drafts.csswg.org/${ module }/#${ hash }`;
    const prelude        = `CSS error at line ${ line }, column ${ column }`;
    const parenthetical  = line !== disambigLine || column !== disambigCol
      ? ` (disambiguated at line ${ disambigLine }, column ${ disambigCol })`
      : '';

    const err = new Error([
      `${ prelude }${ parenthetical }: see ${ url }`,
      `  ${ sourceText }`,
      `  ${ sourcePointer }`
    ].join('\n'));

    Error.captureStackTrace(err, this._fail);

    if (this._recover) {
      this._errors.push(err);
      return false;
    }

    this._error = err;
    return true;
  }

  _finish(done) {
    if (this._error) return;

    this._source[this._sourceLength++] = EOF_SENTINEL;

    this._lex(EOF_SENTINEL);

    this._sourceLength--;

    done(this._error);
  }

  // Debugging method. Used when debug is set to 'LEXING'.

  _printToken(tokenType, index) {
    const columns = [
      ...Array.from(this._getPositionOfToken(index), n => `${ n }`.padStart(4)),
      this.constructor[tokenType].padEnd(17),
      formatAndTruncate(this._getSourceOfToken(index))
    ];

    switch (tokenType) {
      case DELIM_TOKEN:
        columns.push(`CP: 0x${
          this._getDelimTokenCP(index)
            .toString(16)
            .toUpperCase()
            .padStart(4, 0)
        }`);

        break;

      case AT_KEYWORD_TOKEN:
      case FUNCTION_TOKEN:
      case IDENT_TOKEN:
      case STRING_TOKEN:
      case URL_TOKEN:
        columns.push(`SV: ${
          formatAndTruncate(this._getStringValueOfNonHashToken(index))
        }`);

        break;

      case HASH_TOKEN:
        columns.push(`ID: ${ this._getHashTokenIsID(index) }, SV: ${
          formatAndTruncate(this._getStringValueOfHashToken(index))
        }`);

        break;

      case PERCENTAGE_TOKEN:
        columns.push(`NV: ${ this._getNumericValueOfPercentageToken(index) }`);
        break;

      case NUMBER_TOKEN:
        columns.push(`INT: ${ !this._getNumberTokenIsFloat(index) }, NV: ${
          this._getNumericValueOfNumberToken(index)
        }`);

        break;

      case DIMENSION_TOKEN:
        columns.push(`INT: ${ !this._getDimensionTokenIsFloat(index) }, NV: ${
          this._getNumericValueOfDimensionToken(index)
        }, UNIT: ${
          formatAndTruncate(this._getStringValueOfNonHashToken(index))
        }`);

        break;

      default:
        columns.push('');
    }

    console.log(columns.join(' | '));
  }

  // For CSS, the source is normalized not only to convert CR+LF to LF, but also
  // FF; also, NUL becomes the replacement character. We will consider the
  // "source text" to be not the literal source input, but rather the normalized
  // stream, since there is no real benefit to preserving its unnormalized form
  // (even for source maps); this allows us to avoid a significant amount of
  // additional complexity.

  _write({ buffer, length, offset }, enc, done) {
    const cps = new Uint32Array(buffer, offset, length /= 4);

    if (this._source.length - this._sourceLength < length)
      this._expandBuffers(length);

    for (let i = 0; i < cps.length; i++) {
      let cp = cps[i];

      if (this._lastCPWasCR && cp === 0x0A) {
        this._lastCPWasCR = false;
        continue;
      }

      switch (cp) {
        case 0x00:
          cp = 0xFFFD;
          break;
        case 0x0C: case 0x0D:
          cp = 0x0A;
          break;
      }

      this._lastCPWasCR = cp === 0x0D;
      this._source[this._sourceLength++] = cp;
      this._positions[this._positionsLength++] = this._line;
      this._positions[this._positionsLength++] = this._column;

      this._lex(cp);

      if (this._error) return done(this._error);

      if (cp === 0x0A || cp === 0x2028 || cp === 0x2029) {
        this._line++;
        this._column = 0;
      } else {
        this._column++;
      }
    }

    done();
  }

  // TOKEN INTROSPECTION ///////////////////////////////////////////////////////
  //
  // Note that, for the most part, _there is no protection_ from addressing a
  // token that does not exist or using an inapplicable method for retrieving
  // data for a given token type. It is the responsibility of the consumer to
  // only pass in actual token indices (which function, effectively, as IDs) and
  // only call the methods that logically apply to a token of that type.

  // For DELIM_TOKEN type token, given the token index, returns the codepoint
  // value of the token.

  _getDelimTokenCP(index) {
    return this._tokens[index + 2];
  }

  // For DIMENSION_TOKEN type token, given the token index, returns a boolean
  // indicating whether the number is a float as opposed to an integer.

  _getDimensionTokenIsFloat(index) {
    return this._stringValues[this._tokens[index + 3]] === 1;
  }

  // For HASH_TOKEN type token, given the token index, returns a boolean
  // indicating whether hash token is of type "ID" as opposed to "UNRESTRICTED".

  _getHashTokenIsID(index) {
    return (this._tokens[index + 2] & 1) === 1;
  }

  // For NUMBER_TOKEN type token, given the token index, returns boolean
  // indicating whether the number is a float as opposed to an integer.

  _getNumberTokenIsFloat(index) {
    return this._tokens[index + 2] === 1;
  }

  // For DIMENSION_TOKEN type token, given the token index, returns the numeric
  // value of the token.

  _getNumericValueOfDimensionToken(index) {
    const numberIndex = this._stringValues[this._tokens[index + 3] + 1];

    return this._getDimensionTokenIsFloat(index)
      ? this._floatValues[numberIndex]
      : this._intValues[numberIndex];
  }

  // For NUMBER_TOKEN type token, given the token index, returns the numeric
  // value of the token.

  _getNumericValueOfNumberToken(index) {
    const numberIndex = this._tokens[index + 3];

    return this._getNumberTokenIsFloat(index)
      ? this._floatValues[numberIndex]
      : this._intValues[numberIndex];
  }

  // For PERCENTAGE_TOKEN type token, given the token index, returns the numeric
  // value of the token.

  _getNumericValueOfPercentageToken(index) {
    return this._floatValues[this._tokens[index + 2]];
  }

  // For any token index, returns the [ line, column ] of its first codepoint.

  _getPositionOfToken(index) {
    const positionIndex =
      index === 0 ? 0 : Math.imul(this._tokens[index - 3], 2);

    return this._positions.subarray(positionIndex, positionIndex + 2);
  }

  // For any token index, returns a corresponding source buffer.

  _getSourceOfToken(index) {
    const start = index === 0 ? 0 : this._tokens[index - 3];
    const end = this._tokens[index + 1];

    return this._source.subarray(start, end);
  }

  // For AT_KEYWORD_TOKEN, BAD_STRING_TOKEN, BAD_URL_TOKEN, DIMENSION_TOKEN,
  // FUNCTION_TOKEN, IDENT_TOKEN, STRING_TOKEN, URL_TOKEN type tokens, given the
  // token index, returns the corresponding string value buffer.
  //
  // (token type)     | (ex source) | (ex string value)
  // AT_KEYWORD_TOKEN | @keyframes  | keyframes
  // DIMENSION_TOKEN  | 10px        | px
  // FUNCTION_TOKEN   | rgba(       | rgba
  // IDENT_TOKEN      | \u41 BC     | ABC
  // STRING_TOKEN     | "foo"       | foo
  // URL_TOKEN        | url(foo)    | foo

  _getStringValueOfNonHashToken(index) {
    return this._stringValues.subarray(
      this._tokens[index + 2],
      this._tokens[index + 3]
    );
  }

  // For HASH_TOKEN type token, given the token index, returns the corresponding
  // string value buffer.
  //
  // (token type)     | (ex source) | (ex string value)
  // HASH_TOKEN       | #foo        | foo

  _getStringValueOfHashToken(index) {
    return this._stringValues.subarray(
      this._tokens[index + 2] >>> 1,
      this._tokens[index + 3]
    );
  }

  // For AT_KEYWORD_TOKEN, BAD_STRING_TOKEN, BAD_URL_TOKEN, DIMENSION_TOKEN,
  // FUNCTION_TOKEN, IDENT_TOKEN, STRING_TOKEN, URL_TOKEN type tokens, given the
  // token index and an array of CPs for comparison, returns a boolean
  // indicating whether the values matched. In practice this is needed only for
  // AT_KEYWORD_TOKEN, DIMENSION_TOKEN, FUNCTION_TOKEN and IDENT_TOKEN.

  _testSimpleStringValue(index, buf) {
    const start = this._tokens[index + 2];
    const end = this._tokens[index + 3];

    if (end - start !== buf.length) return false;

    for (let i = start, j = 0; i < end; i++, j++) {
      if (this._stringValues[i] !== buf[j]) return false;
    }

    return true;
  }

  // TOKEN CREATION & LEXICAL CONCERNS /////////////////////////////////////////

  _addDelimTokenWithOffset(cp, offset) {
    this._sourceLength -= offset;
    this._addDelimTokenWithoutOffset(cp);

    // Never more than 3

    switch (offset) {
      case 3: this._lex(this._source[this._sourceLength++]);
      case 2: this._lex(this._source[this._sourceLength++]);
      case 1: this._lex(this._source[this._sourceLength++]);
    }
  }

  _addDelimTokenWithoutOffset(cp) {
    const tokenIndex = this._tokensLength;

    this._lex = this.$input;
    this._tokens[this._tokensLength++] = DELIM_TOKEN;
    this._tokens[this._tokensLength++] = this._sourceLength;
    this._tokens[this._tokensLength++] = cp;
    this._tokensLength++;

    this._token(DELIM_TOKEN, tokenIndex);
  }

  _addDimensionToken(offset) {
    const tokenIndex = this._tokensLength;

    if (this._numericTokenIsFloat) {
      this._numericTokenIsFloat = false;
      this._floatValues[this._floatValuesLength] = this._numericTokenValue;
      this._stringValue(0x01);
      this._stringValue(this._floatValuesLength++);
    } else {
      this._intValues[this._intValuesLength] = this._numericTokenValue;
      this._stringValue(0x00);
      this._stringValue(this._intValuesLength++);
    }

    this._lex = this.$input;
    this._tokens[this._tokensLength++] = DIMENSION_TOKEN;
    this._tokens[this._tokensLength++] = this._sourceLength - offset;
    this._tokens[this._tokensLength++] = this._stringValuesStart;
    this._tokens[this._tokensLength++] = this._stringValuesLength - 2;
    this._stringValuesStart = this._stringValuesLength;

    this._token(DIMENSION_TOKEN, tokenIndex);

    if (offset === 1)
      this._lex(this._source[this._sourceLength - 1]);
    else /* always 1 or 2 */
      this._sourceLength--,
      this._lex(this._source[this._sourceLength - 1]),
      this._sourceLength++;
  }

  _addGeneralTokenWithoutOffset(tokenType) {
    const tokenIndex = this._tokensLength;

    this._lex = this.$input;
    this._tokens[this._tokensLength++] = tokenType;
    this._tokens[this._tokensLength++] = this._sourceLength;
    this._tokensLength += 2;

    this._token(tokenType, tokenIndex);
  }

  _addHashToken(offset) {
    const tokenIndex = this._tokensLength;
    const sv1 = (this._stringValuesStart << 1) + this._hashTokenIsID;

    this._lex = this.$input;
    this._tokens[this._tokensLength++] = HASH_TOKEN;
    this._tokens[this._tokensLength++] = this._sourceLength - offset;
    this._tokens[this._tokensLength++] = sv1;
    this._tokens[this._tokensLength++] = this._stringValuesLength;
    this._stringValuesStart = this._stringValuesLength;
    this._hashTokenIsID = false;

    this._token(HASH_TOKEN, tokenIndex);

    if (offset === 1)
      this._lex(this._source[this._sourceLength - 1]);
    else /* always 1 or 2 */
      this._sourceLength--,
      this._lex(this._source[this._sourceLength - 1]),
      this._sourceLength++;
  }

  _addNumberToken(offset) {
    const tokenIndex = this._tokensLength;

    this._lex = this.$input;
    this._tokens[this._tokensLength++] = NUMBER_TOKEN;
    this._tokens[this._tokensLength++] = this._sourceLength -= offset;

    if (this._numericTokenIsFloat) {
      this._numericTokenIsFloat = false;
      this._floatValues[this._floatValuesLength] = this._numericTokenValue;
      this._tokens[this._tokensLength++] = 1;
      this._tokens[this._tokensLength++] = this._floatValuesLength++;
    } else {
      this._intValues[this._intValuesLength] = this._numericTokenValue;
      this._tokens[this._tokensLength++] = 0;
      this._tokens[this._tokensLength++] = this._intValuesLength++;
    }

    this._token(NUMBER_TOKEN, tokenIndex);

    // Never more than 3

    switch (offset) {
      case 3: this._lex(this._source[this._sourceLength++]);
      case 2: this._lex(this._source[this._sourceLength++]);
      case 1: this._lex(this._source[this._sourceLength++]);
    }
  }

  _addPercentageToken() {
    const tokenIndex = this._tokensLength;

    this._lex = this.$input;
    this._floatValues[this._floatValuesLength] = this._numericTokenValue;
    this._tokens[this._tokensLength++] = PERCENTAGE_TOKEN;
    this._tokens[this._tokensLength++] = this._sourceLength;
    this._tokens[this._tokensLength++] = this._floatValuesLength++;
    this._tokensLength++;
    this._numericTokenIsFloat = false;

    this._token(PERCENTAGE_TOKEN, tokenIndex);
  }

  _addStringValueTokenWithOffset(tokenType, offset) {
    this._sourceLength -= offset;
    this._addStringValueTokenWithoutOffset(tokenType);

    let cp;

    switch (offset) {
      case 2:
        this._lex(this._source[this._sourceLength++]);
      case 1:
        this._lex(this._source[this._sourceLength++]);
        break;

      // Arbitrary loop length is rare edge case

      default:
        while (offset-- && this._error === undefined)
          this._lex(this._source[this._sourceLength++]);
    }
  }

  _addStringValueTokenWithoutOffset(tokenType) {
    const tokenIndex = this._tokensLength;

    this._lex = this.$input;
    this._tokens[this._tokensLength++] = tokenType;
    this._tokens[this._tokensLength++] = this._sourceLength;
    this._tokens[this._tokensLength++] = this._stringValuesStart;
    this._tokens[this._tokensLength++] = this._stringValuesLength;
    this._stringValuesStart = this._stringValuesLength;

    this._token(tokenType, tokenIndex);
  }

  _addWhitespaceToken(cp) {
    const tokenIndex = this._tokensLength;

    this._lex = this.$input;
    this._tokens[this._tokensLength++] = WHITESPACE_TOKEN;
    this._tokens[this._tokensLength++] = this._sourceLength - 1;
    this._tokensLength += 2;

    this._token(WHITESPACE_TOKEN, tokenIndex);

    if (this._error === undefined) this._lex(cp);
  }

  _commitNumber(offset) {
    const start =
      this._tokensLength === 0 ? 0 : this._tokens[this._tokensLength - 3];

    const end =
      this._sourceLength - offset;

    const src =
      this._source.subarray(start, end);

    this._numericTokenValue = Number.parseFloat(String.fromCodePoint(...src));
  }

  _escape(lexState, cp) {
    this._lexAfterEscape = lexState;
    this._lex = this.$escape;
    this._lex(cp);
  }

  _finishHexEscape() {
    this._stringValue(normalizeEscapeCP(this._escapeCP));
    this._lex = this._lexAfterEscape;
  }

  _isStringValueURL() {
    if (this._stringValuesLength - this._stringValuesStart !== 3) return false;

    const u = this._stringValues[this._stringValuesStart];
    const r = this._stringValues[this._stringValuesStart + 1];
    const l = this._stringValues[this._stringValuesStart + 2];

    return (
      (u === 0x75 || u === 0x55) &&
      (r === 0x72 || r === 0x52) &&
      (r === 0x6C || l === 0x4C)
    );
  }

  _reconsumeCurrentCP(lexState, cp) {
    this._lex = lexState;
    this._lex(cp);
  }

  _stringValue(cp) {
    this._stringValues[this._stringValuesLength++] = cp;
  }

  _token() {}

  // LEXICAL STATES ////////////////////////////////////////////////////////////

  $atKeyword(cp) {
    if (isNameContinue(cp))
      this._stringValue(cp);
    else if (cp === 0x5C)
      this._lex = this.$atKeywordEscape;
    else
      this._addStringValueTokenWithOffset(AT_KEYWORD_TOKEN, 1);
  }

  $atKeywordEscape(cp) {
    if (cp === 0x0A)
      this._addStringValueTokenWithOffset(AT_KEYWORD_TOKEN, 2);
    else
      this._escape(this.$atKeyword, cp);
  }

  $badURL(cp) {
    switch (cp) {
      case 0x29:
      case EOF_SENTINEL:
        this._addStringValueTokenWithoutOffset(BAD_URL_TOKEN);
        return;
      case 0x5C:
        this._lex = this.$badURLEscape;
    }
  }

  $badURLEscape(cp) {
    switch (cp) {
      case EOF_SENTINEL:
        if (this._fail('css-syntax-3', 'consume-escaped-code-point')) return;
        this._addStringValueTokenWithoutOffset(BAD_URL_TOKEN);
      default:
        this._lex = this.$badURL;
    }
  }

  $cdcOrIdent(cp) {
    if (cp === 0x3E) {
      this._addGeneralTokenWithoutOffset(CDC_TOKEN);
      return;
    }

    this._stringValue(0x2D);
    this._stringValue(0x2D);
    this._reconsumeCurrentCP(this.$ident, cp);
  }

  $comment(cp) {
    switch (cp) {
      case 0x2A:
        this._lex = this.$commentAfterAsterisk;
        return;
      case EOF_SENTINEL:
        if (this._fail('css-syntax-3', 'consume-comment')) return;
        this._addGeneralTokenWithoutOffset(__COMMENT_TOKEN__);
    }
  }

  $commentAfterAsterisk(cp) {
    switch (cp) {
      case 0x2A:
        return;
      case 0x2F:
        this._addGeneralTokenWithoutOffset(__COMMENT_TOKEN__);
        return;
      case EOF_SENTINEL:
        if (this._fail('css-syntax-3', 'consume-comment')) return;
        this._addGeneralTokenWithoutOffset(__COMMENT_TOKEN__);
        return;
      default:
        this._lex = this.$comment;
    }
  }

  $delimOrAtKeyword(cp) {
    if (isNameStart(cp))
      this._stringValue(cp),
      this._lex = this.$atKeyword;
    else if (cp === 0x2D)
      this._lex = this.$delimOrAtKeywordAfterHyphen;
    else if (cp === 0x5C)
      this._lex = this.$delimOrAtKeywordAfterBackslash;
    else
      this._addDelimTokenWithOffset(0x40, 1);
  }

  $delimOrAtKeywordAfterBackslash(cp) {
    if (cp === 0x0A)
      this._addDelimTokenWithOffset(0x40, 2);
    else
      this._escape(this.$atKeyword, cp);
  }

  $delimOrAtKeywordAfterHyphen(cp) {
    if (isNameStart(cp) || cp === 0x2D)
      this._stringValue(0x2D),
      this._stringValue(cp),
      this._lex = this.$atKeyword;
    else if (cp === 0x5C)
      this._lex = this.$delimOrAtKeywordAfterHyphenBackslash;
    else
      this._addDelimTokenWithOffset(0x40, 2);
  }

  $delimOrAtKeywordAfterHyphenBackslash(cp) {
    if (cp === 0x0A)
      this._addDelimTokenWithOffset(0x40, 3);
    else
      this._stringValue(0x2D),
      this._escape(this.$atKeyword, cp);
  }

  $delimOrCDO(cp) {
    if (cp === 0x21)
      this._lex = this.$delimOrCDOAfterExclamationPoint;
    else
      this._addDelimTokenWithOffset(0x3C, 1);
  }

  $delimOrCDOAfterExclamationPoint(cp) {
    if (cp === 0x2D)
      this._lex = this.$delimOrCDOAfterExclamationPointHyphen;
    else
      this._addDelimTokenWithOffset(0x3C, 2);
  }

  $delimOrCDOAfterExclamationPointHyphen(cp) {
    if (cp === 0x2D)
      this._addGeneralTokenWithoutOffset(CDO_TOKEN);
    else
      this._addDelimTokenWithOffset(0x3C, 3);
  }

  $delimOrComment(cp) {
    if (cp === 0x2A)
      this._lex = this.$comment;
    else
      this._addDelimTokenWithOffset(0x2F, 1);
  }

  $delimOrFractionalNumber(cp) {
    switch (cp) {
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        this._numericTokenIsFloat = true;
        this._lex = this.$numberInDecimal;
        return;
      default:
        this._addDelimTokenWithOffset(0x2E, 1);
    }
  }

  $delimOrHash(cp) {
    if (isNameStart(cp))
      this._hashTokenIsID = true,
      this._stringValue(cp),
      this._lex = this.$hash;
    else if (cp === 0x2D)
      this._stringValue(cp),
      this._lex = this.$hashAfterHyphen;
    else if (cp === 0x5C)
      this._lex = this.$delimOrHashAfterBackslash;
    else if (isNameContinue(cp))
      this._stringValue(cp),
      this._lex = this.$hash;
    else
      this._addDelimTokenWithOffset(0x23, 1);
  }

  $delimOrHashAfterBackslash(cp) {
    if (cp === 0x0A)
      this._addDelimTokenWithOffset(0x23, 2);
    else
      this._hashTokenIsID = true,
      this._escape(this.$hash, cp);
  }

  $delimOrIdentAfterHyphenBackslash(cp) {
    if (cp === 0x0A)
      this._addDelimTokenWithOffset(0x2D, 1);
    else
      this._stringValue(0x2D),
      this._escape(this.$ident, cp);
  }

  $delimOrIdentInitialEscape(cp) {
    if (cp === 0x0A) {
      if (this._fail('css-syntax-3', 'consume-token')) return;
      this._addDelimTokenWithOffset(0x5C, 1);
      return;
    }

    this._escape(this.$ident, cp);
  }

  $delimOrNegativeSignedNumberOrCDCOrIdent(cp) {
    switch (cp) {
      case 0x2D:
        this._lex = this.$cdcOrIdent;
        return;
      case 0x2E:
        this._lex = this.$delimOrNegativeSignedNumberFractional;
        return;
      case 0x5C:
        this._lex = this.$delimOrIdentAfterHyphenBackslash;
        return;
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        this._lex = this.$number;
        return;
      default:
        if (isNameStart(cp))
          this._stringValue(0x2D),
          this._reconsumeCurrentCP(this.$ident, cp);
        else
          this._addDelimTokenWithOffset(0x2D, cp);
    }
  }

  $delimOrNegativeSignedNumberFractional(cp) {
    switch (cp) {
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        this._numericTokenIsFloat = true;
        this._lex = this.$numberInDecimal;
        return;
      default:
        this._addDelimTokenWithOffset(0x2D, 2);
    }
  }

  $delimOrPositiveSignedNumber(cp) {
    switch (cp) {
      case 0x2E:
        this._lex = this.$delimOrPositiveSignedNumberFractional;
        return;
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        this._lex = this.$number;
        return;
      default:
        this._addDelimTokenWithOffset(0x2B, 1);
    }
  }

  $delimOrPositiveSignedNumberFractional(cp) {
    switch (cp) {
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        this._numericTokenIsFloat = true;
        this._lex = this.$numberInDecimal;
        return;
      default:
        this._addDelimTokenWithOffset(0x2B, 2);
    }
  }

  $escape(cp) {
    if (isHex(cp))
      this._escapeCount = 1,
      this._escapeCP = toHexValue(cp),
      this._lex = this.$escapeHex;
    else if (cp === EOF_SENTINEL)
      this._fail('css-syntax-3', 'consume-escaped-code-point'),
      this._stringValue(0xFFFD),
      this._lex = this._lexAfterEscape;
    else
      this._stringValue(cp),
      this._lex = this._lexAfterEscape;
  }

  $escapeHex(cp) {
    if (isHex(cp)) {
      this._escapeCP <<= 4;
      this._escapeCP += toHexValue(cp);

      if (++this._escapeCount === 6) {
        this._finishHexEscape();
      }
    } else {
      this._finishHexEscape();

      switch (cp) {
        case 0x09: case 0x0A: case 0x20:
          return;
        default:
          this._lex(cp);
      }
    }
  }

  $functionOrURL(cp) {
    switch (cp) {
      case 0x09: case 0x0A: case 0x20:
        this._urlWhitespaceCount++;
        return;
      case 0x22: case 0x27:
        // In 4.3.4, the spec indicates to consume the next codepoint "while the
        // next two codepoints are whitespace"; then, this step occurs when "the
        // next one or two codepoints are 0x22, 0x27, or whitespace followed by
        // 0x22 or 0x27".
        //
        // It took me a while to decipher what this rather mysterious pattern
        // was intended to achieve. My best guess anyway was that it is meant to
        // ensure that a whitespace token gets produced when there was
        // whitespace but the URL bit is to be consumed as a function token. The
        // particulars here avoid reconsumption of any whitespace contributing
        // to such a token other than the last cp, which on one hand looks like
        // a microoptimization for a rather uncommon case, but it’s fair when
        // you consider that from the spec’s perspective, the _literal_ source
        // whitespace of a whitespace token is always discarded anyway (all that
        // matters is that the token is produced). It still struck me as
        // odd for an abstract "behave as if" spec until I realized that in
        // addition, reconsumption of all the whitespace would represent the
        // only place in the lexical spec where the number of codepoints to
        // reconsume could be arbitrarily long. So, lots of good reasons, though
        // I think the prose is kinda opaque.
        //
        // In any case, these instructions are at odds with parsers such as this
        // one which aim to preserve relationships between source text and the
        // tokens produced, so I haven’t followed these instructions, and
        // instead we reconsume the whitespace in total "as" whitespace despite
        // its arbitrary length in order to keep source associations correct.
        // This still ends up maintaining "behave as if" behavior from the spec
        // perspective, so it isn’t a real departure.
        //
        // Anyway, it’s all super academic regardless since there is nowhere
        // that a whitespace token after a function token will *ultimately* be
        // semantic, and it seems like a safe bet to say that will never change,
        // but I felt it merited explanation.

        this._addStringValueTokenWithOffset(
          FUNCTION_TOKEN,
          this._urlWhitespaceCount + 1
        );
      default:
        this._stringValuesLength = this._stringValuesStart;
        this._reconsumeCurrentCP(this.$url, cp);
    }
  }

  $hash(cp) {
    if (isNameContinue(cp))
      this._stringValue(cp);
    else if (cp === 0x5C)
      this._lex = this.$hashEscape;
    else
      this._addHashToken(1);
  }

  $hashAfterHyphen(cp) {
    if (isNameStart(cp) || cp === 0x2D)
      this._hashTokenIsID = true,
      this._stringValue(cp),
      this._lex = this.$hash;
    else if (cp === 0x5C)
      this._lex = this.$hashAfterHyphenBackslash;
    else if (isNameContinue(cp))
      this._stringValue(cp),
      this._lex = this.$hash;
    else
      this._addHashToken(1);
  }

  $hashAfterHyphenBackslash(cp) {
    // Note that the sequence "#-\" followed by EOF produces a hash token with
    // its type set to "ID". I think this may be a spec error. I opened a ticky:
    //
    // https://github.com/w3c/csswg-drafts/issues/1821

    if (cp === 0x0A)
      this._addHashToken(2);
    else
      this._hashTokenIsID = true,
      this._escape(this.$hash, cp);
  }

  $hashEscape(cp) {
    if (cp === 0x0A)
      this._addHashToken(2);
    else
      this._escape(this.$hash, cp);
  }

  $ident(cp) {
    if (isNameContinue(cp)) {
      this._stringValue(cp);
    } else if (cp === 0x5C) {
      this._lex = this.$identEscape;
    } else if (cp === 0x28) {
      if (this._isStringValueURL())
        this._urlWhitespaceCount = 0,
        this._lex = this.$functionOrURL;
      else
        this._addStringValueTokenWithoutOffset(FUNCTION_TOKEN);
    } else {
      this._addStringValueTokenWithOffset(IDENT_TOKEN, 1);
    }
  }

  $identEscape(cp) {
    if (cp === 0x0A)
      this._addStringValueTokenWithOffset(IDENT_TOKEN, 2);
    else
      this._escape(this.$ident, cp);
  }

  $input(cp) {
    switch (cp) {
      case 0x09: case 0x0A: case 0x20:
        this._lex = this.$whitespace;
        return;
      case 0x22:
        this._stringDelimiter = 0x22;
        this._lex = this.$string;
        return;
      case 0x23:
        this._lex = this.$delimOrHash;
        return;
      case 0x27:
        this._stringDelimiter = 0x27;
        this._lex = this.$string;
        return;
      case 0x28:
        this._addGeneralTokenWithoutOffset(LEFT_PARENTHESIS_TOKEN);
        return;
      case 0x29:
        this._addGeneralTokenWithoutOffset(RIGHT_PARENTHESIS_TOKEN);
        return;
      case 0x2B:
        this._lex = this.$delimOrPositiveSignedNumber;
        return;
      case 0x2C:
        this._addGeneralTokenWithoutOffset(COMMA_TOKEN);
        return;
      case 0x2D:
        this._lex = this.$delimOrNegativeSignedNumberOrCDCOrIdent;
        return;
      case 0x2E:
        this._lex = this.$delimOrFractionalNumber;
        return;
      case 0x2F:
        this._lex = this.$delimOrComment;
        return;
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        this._lex = this.$number;
        return;
      case 0x3A:
        this._addGeneralTokenWithoutOffset(COLON_TOKEN);
        return;
      case 0x3B:
        this._addGeneralTokenWithoutOffset(SEMICOLON_TOKEN);
        return;
      case 0x3C:
        this._lex = this.$delimOrCDO;
        return;
      case 0x40:
        this._lex = this.$delimOrAtKeyword;
        return;
      case 0x5B:
        this._addGeneralTokenWithoutOffset(LEFT_BRACKET_TOKEN);
        return;
      case 0x5C:
        this._lex = this.$delimOrIdentInitialEscape;
        return;
      case 0x5D:
        this._addGeneralTokenWithoutOffset(RIGHT_BRACKET_TOKEN);
        return;
      case 0x7B:
        this._addGeneralTokenWithoutOffset(LEFT_BRACE_TOKEN);
        return;
      case 0x7D:
        this._addGeneralTokenWithoutOffset(RIGHT_BRACE_TOKEN);
        return;
      case EOF_SENTINEL:
        return;
      default:
        if (isNameStart(cp))
          this._reconsumeCurrentCP(this.$ident, cp);
        else
          this._addDelimTokenWithoutOffset(cp);
    }
  }

  $number(cp) {
    switch (cp) {
      case 0x25:
        this._commitNumber(1);
        this._addPercentageToken();
        return;
      case 0x2D:
        this._commitNumber(1);
        this._lex = this.$numberPossibleUnitHyphen;
        return;
      case 0x2E:
        this._lex = this.$numberPossibleFraction;
        return;
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        return;
      case 0x45: case 0x65:
        this._lex = this.$numberPossibleExponentOrUnit;
        return;
      case 0x5C:
        this._commitNumber(1);
        this._lex = this.$numberPossibleUnitBackslash;
        return;
      default:
        this._commitNumber(1);

        if (isNameStart(cp))
          this._stringValue(cp),
          this._lex = this.$numberUnit;
        else
          this._addNumberToken(1);
    }
  }

  $numberExponent(cp) {
    switch (cp) {
      case 0x25:
        this._commitNumber(1);
        this._addPercentageToken();
        return;
      case 0x2D:
        this._commitNumber(1);
        this._lex = this.$numberPossibleUnitHyphen;
        return;
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        return;
      case 0x5C:
        this._commitNumber(1);
        this._lex = this.$numberPossibleUnitBackslash;
        return;
      default:
        this._commitNumber(1);

        if (isNameStart(cp))
          this._stringValue(cp),
          this._lex = this.$numberUnit;
        else
          this._addNumberToken(1);
    }
  }

  $numberInDecimal(cp) {
    switch (cp) {
      case 0x25:
        this._commitNumber(1);
        this._addPercentageToken();
        return;
      case 0x2D:
        this._commitNumber(1);
        this._lex = this.$numberPossibleUnitHyphen;
        return;
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        return;
      case 0x45: case 0x65:
        this._lex = this.$numberPossibleExponentOrUnit;
        return;
      case 0x5C:
        this._commitNumber(1);
        this._lex = this.$numberPossibleUnitBackslash;
        return;
      default:
        this._commitNumber(1);

        if (isNameStart(cp))
          this._stringValue(cp),
          this._lex = this.$numberUnit;
        else
          this._addNumberToken(1);
    }
  }

  $numberPossibleExponentOrUnit(cp) {
    switch (cp) {
      case 0x2B:
        this._lex = this.$numberPossibleExponentSignedOrUnitPlus;
        return;
      case 0x2D:
        this._lex = this.$numberPossibleExponentSignedOrUnitHyphen;
        return;
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        this._numericTokenIsFloat = true;
        this._lex = this.$numberExponent;
        return;
      case 0x5C:
        this._commitNumber(2);
        this._stringValue(this._source[this._sourceLength - 2]);
        this._reconsumeCurrentCP(this.$numberUnitEscape, 0x5C);
        return;
      default:
        this._commitNumber(2);
        this._stringValue(this._source[this._sourceLength - 2]);

        if (isNameContinue(cp))
          this._stringValue(cp),
          this._lex = this.$numberUnit;
        else
          this._addDimensionToken(1);
    }
  }

  $numberPossibleExponentSignedOrUnitPlus(cp) {
    switch (cp) {
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        this._numericTokenIsFloat = true;
        this._lex = this.$numberExponent;
        return;
      default:
        this._commitNumber(3);
        this._stringValue(this._source[this._sourceLength - 3]);
        this._addDimensionToken(2);
    }
  }

  $numberPossibleExponentSignedOrUnitHyphen(cp) {
    switch (cp) {
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        this._numericTokenIsFloat = true;
        this._lex = this.$numberExponent;
        return;
      default:
        this._stringValue(this._source[this._sourceLength - 3]);
        this._stringValue(0x2D);

        if (isNameContinue(cp) || cp === 0x5C)
          this._reconsumeCurrentCP(this.$numberUnit, cp);
        else
          this._commitNumber(3),
          this._addDimensionToken(2);
    }
  }

  $numberPossibleFraction(cp) {
    switch (cp) {
      case 0x30: case 0x31: case 0x32: case 0x33: case 0x34: case 0x35:
      case 0x36: case 0x37: case 0x38: case 0x39:
        this._numericTokenIsFloat = true;
        this._lex = this.$numberInDecimal;
        return;
      default:
        this._commitNumber(2);
        this._addNumberToken(2);
    }
  }

  $numberPossibleUnitBackslash(cp) {
    if (cp === 0x0A)
      this._addNumberToken(2);
    else
      this._escape(this.$numberUnit, cp);
  }

  $numberPossibleUnitHyphen(cp) {
    switch (cp) {
      case 0x2D:
        this._stringValue(0x2D);
        this._stringValue(0x2D);
        this._lex = this.$numberUnit;
        return;
      case 0x5C:
        this._lex = this.$numberPossibleUnitHyphenBackslash;
        return;
      default:
        if (isNameStart(cp))
          this._stringValue(0x2D),
          this._stringValue(cp),
          this._lex = this.$numberUnit;
        else
          this._addNumberToken(2);
    }
  }

  $numberPossibleUnitHyphenBackslash(cp) {
    if (cp === 0x0A)
      this._addNumberToken(3);
    else
      this._stringValue(0x2D),
      this._escape(this.$numberUnit, cp);
  }

  $numberUnit(cp) {
    if (cp === 0x5C)
      this._lex = this.$numberUnitEscape;
    else if (isNameContinue(cp))
      this._stringValue(cp);
    else
      this._addDimensionToken(1);
  }

  $numberUnitEscape(cp) {
    if (cp === 0x0A)
      this._addDimensionToken(2);
    else
      this._escape(this.$numberUnit, cp);
  }

  $string(cp) {
    switch (cp) {
      case this._stringDelimiter:
        this._addStringValueTokenWithoutOffset(STRING_TOKEN);
        return;
      case 0x0A:
        if (this._fail('css-syntax-3', 'consume-a-string-token')) return;
        this._stringValuesLength = this._stringValuesStart;
        this._addStringValueTokenWithOffset(BAD_STRING_TOKEN, 1);
        return;
      case 0x5C:
        this._lex = this.$stringEscape;
        return;
      case EOF_SENTINEL:
        if (this._fail('css-syntax-3', 'consume-a-string-token')) return;
        this._addStringValueTokenWithoutOffset(STRING_TOKEN);
        return;
      default:
        this._stringValue(cp);
    }
  }

  $stringEscape(cp) {
    switch (cp) {
      case 0x0A:
        this._lex = this.$string;
        return;
      case EOF_SENTINEL:
        if (this._fail('css-syntax-3', 'consume-a-string-token')) return;
        this._addStringValueTokenWithoutOffset(STRING_TOKEN);
        return;
      default:
        this._escape(this.$string, cp);
    }
  }

  $url(cp) {
    switch (cp) {
      case 0x09: case 0x0A: case 0x20:
        this._lex = this.$urlAfterWhitespace;
        return;
      case 0x22: case 0x27: case 0x28:
        this._fail('css-syntax-3', 'consume-url-token');
        this._stringValuesLength = this._stringValuesStart;
        this._lex = this.$badURL;
        return;
      case 0x29:
        this._addStringValueTokenWithoutOffset(URL_TOKEN);
        return;
      case 0x5C:
        this._lex = this.$urlEscape;
        return;
      case 0x00: case 0x01: case 0x02: case 0x03: case 0x04: case 0x05:
      case 0x06: case 0x07: case 0x08: case 0x0B: case 0x0E: case 0x0F:
      case 0x10: case 0x11: case 0x12: case 0x13: case 0x14: case 0x15:
      case 0x16: case 0x17: case 0x18: case 0x19: case 0x1A: case 0x1B:
      case 0x1C: case 0x1D: case 0x1E: case 0x1F: case 0x7F:
        this._fail('css-syntax-3', 'consume-url-token'),
        this._stringValuesLength = this._stringValuesStart,
        this._lex = this.$badURL;
      case EOF_SENTINEL:
        this._fail('css-syntax-3', 'consume-url-token');
        this._addStringValueTokenWithoutOffset(URL_TOKEN);
      default:
        this._stringValue(cp);
    }
  }

  $urlAfterWhitespace(cp) {
    switch (cp) {
      case 0x09: case 0x0A: case 0x20:
        return;
      case EOF_SENTINEL:
        if (this._fail('css-syntax-3', 'consume-url-token')) return;
      case 0x29:
        this._addStringValueTokenWithoutOffset(URL_TOKEN);
        return;
      default:
        this._stringValuesLength = this._stringValuesStart;
        this._lex = this.$badURL;
    }
  }

  $urlEscape(cp) {
    if (cp === 0x0A)
      this._stringValuesLength = this._stringValuesStart,
      this._lex = this.$badURL;
    else
      this._escape(this.$url, cp);
  }

  $whitespace(cp) {
    switch (cp) {
      case 0x09: case 0x0A: case 0x20:
        return;
      default:
        this._addWhitespaceToken(cp);
    }
  }
}

Object.defineProperties(CSSParser, {
  fromBuffer                : { value: fromBuffer },
  fromCPs                   : { value: fromCPs },
  fromFilename              : { value: fromFilename },

  Decoder                   : { value: WTF8ToCPs },
  decoderOpts               : { value: { discardBOM: true } },

  AT_KEYWORD_TOKEN          : { value: AT_KEYWORD_TOKEN },
  BAD_STRING_TOKEN          : { value: BAD_STRING_TOKEN },
  BAD_URL_TOKEN             : { value: BAD_URL_TOKEN },
  CDC_TOKEN                 : { value: CDC_TOKEN },
  CDO_TOKEN                 : { value: CDO_TOKEN },
  COLON_TOKEN               : { value: COLON_TOKEN },
  COMMA_TOKEN               : { value: COMMA_TOKEN },
  DELIM_TOKEN               : { value: DELIM_TOKEN },
  DIMENSION_TOKEN           : { value: DIMENSION_TOKEN },
  FUNCTION_TOKEN            : { value: FUNCTION_TOKEN },
  HASH_TOKEN                : { value: HASH_TOKEN },
  IDENT_TOKEN               : { value: IDENT_TOKEN },
  LEFT_BRACE_TOKEN          : { value: LEFT_BRACE_TOKEN },
  LEFT_BRACKET_TOKEN        : { value: LEFT_BRACKET_TOKEN },
  LEFT_PARENTHESIS_TOKEN    : { value: LEFT_PARENTHESIS_TOKEN },
  NUMBER_TOKEN              : { value: NUMBER_TOKEN },
  PERCENTAGE_TOKEN          : { value: PERCENTAGE_TOKEN },
  RIGHT_BRACE_TOKEN         : { value: RIGHT_BRACE_TOKEN },
  RIGHT_BRACKET_TOKEN       : { value: RIGHT_BRACKET_TOKEN },
  RIGHT_PARENTHESIS_TOKEN   : { value: RIGHT_PARENTHESIS_TOKEN },
  SEMICOLON_TOKEN           : { value: SEMICOLON_TOKEN },
  STRING_TOKEN              : { value: STRING_TOKEN },
  URL_TOKEN                 : { value: URL_TOKEN },
  WHITESPACE_TOKEN          : { value: WHITESPACE_TOKEN },
  __COMMENT_TOKEN__         : { value: __COMMENT_TOKEN__ },

  [AT_KEYWORD_TOKEN]        : { value: 'AT_KEYWORD' },
  [BAD_STRING_TOKEN]        : { value: 'BAD_STRING' },
  [BAD_URL_TOKEN]           : { value: 'BAD_URL' },
  [CDC_TOKEN]               : { value: 'CDC' },
  [CDO_TOKEN]               : { value: 'CDO' },
  [COLON_TOKEN]             : { value: 'COLON' },
  [COMMA_TOKEN]             : { value: 'COMMA' },
  [DELIM_TOKEN]             : { value: 'DELIM' },
  [DIMENSION_TOKEN]         : { value: 'DIMENSION' },
  [FUNCTION_TOKEN]          : { value: 'FUNCTION' },
  [HASH_TOKEN]              : { value: 'HASH' },
  [IDENT_TOKEN]             : { value: 'IDENT' },
  [LEFT_BRACE_TOKEN]        : { value: 'LEFT_BRACE' },
  [LEFT_BRACKET_TOKEN]      : { value: 'LEFT_BRACKET' },
  [LEFT_PARENTHESIS_TOKEN]  : { value: 'LEFT_PARENTHESIS' },
  [NUMBER_TOKEN]            : { value: 'NUMBER' },
  [PERCENTAGE_TOKEN]        : { value: 'PERCENTAGE' },
  [RIGHT_BRACE_TOKEN]       : { value: 'RIGHT_BRACE' },
  [RIGHT_BRACKET_TOKEN]     : { value: 'RIGHT_BRACKET' },
  [RIGHT_PARENTHESIS_TOKEN] : { value: 'RIGHT_PARENTHESIS' },
  [SEMICOLON_TOKEN]         : { value: 'SEMICOLON' },
  [STRING_TOKEN]            : { value: 'STRING' },
  [URL_TOKEN]               : { value: 'URL' },
  [WHITESPACE_TOKEN]        : { value: 'WHITESPACE' },
  [__COMMENT_TOKEN__]       : { value: 'COMMENT' }
});

Object.defineProperties(CSSParser.prototype, {
  writeSourceToFile: { value: writeSourceToFile }
});
