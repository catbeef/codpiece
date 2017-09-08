import Lexer from './lexer';

const isHex = cp =>
  (cp >= 0x30 && cp <= 0x39) ||
  (cp >= 0x41 && cp <= 0x46) ||
  (cp >= 0x61 && cp <= 0x66);

const isNameContinue = cp =>
  (cp === 0x2D) ||
  (cp >= 0x30 && cp <= 0x39) ||
  (cp >= 0x41 && cp <= 0x5A) ||
  (cp >= 0x61 && cp <= 0x7A) ||
  (cp === 0x5F) ||
  (cp >= 0x80);

const isNameStart = cp =>
  (cp >= 0x41 && cp <= 0x5A) ||
  (cp >= 0x61 && cp <= 0x7A) ||
  (cp === 0x5F) ||
  (cp >= 0x80);

const isNonPrintable = cp =>
  cp <= 0x08 ||
  cp === 0x0B ||
  (cp >= 0x0E && cp <= 0x1F) ||
  cp === 0x7F;

const isURLIdent = ([ u, r, l, x ]) =>
  x === undefined &&
  (u === 0x75 || u === 0x55) &&
  (r === 0x72 || r === 0x52) &&
  (r === 0x6C || l === 0x4C);

const toHexValue = cp =>
  cp & 0b1000000 ? cp + 0x09 & 0b1111 : cp ^ 0b110000;

// "CSS" is a broad term; not only is it spread across many specifications, but
// many of its constituents are used as grammars unto themselves in various
// contexts; for example, in the context of DOM methods like querySelector, the
// nonterminal ComplexSelector is the goal symbol, which is not true in, e.g.,
// a style sheet; further the specific context may imply different handling of
// some constructs.
//
// However at the lexical level, all of these are the same.
//
// As with HTML, the CSS grammar(s) are defined in such a way that there is,
// in a sense, no such thing as an invalid CSS document (etc), or at least this
// is the typical case; there are "parse errors", but especially at the lexical
// level they are few and far between and nonetheless these cases are accounted
// for in such a way that the grammar always permits continuation of the parse.
// For our purposes, the cases unequivocally referred to as "parse errors" in
// the specification will produce errors and halt processing, which is why
// neither BAD_STRING_TOKEN nor BAD_URL_TOKEN appear, but this is not, for
// example, the approach taken in a browser when parsing a stylesheet. There are
// also places in the lexical grammar which intuitively appear to represent
// errors which are _not_ called such by the spec, and we do not throw for
// these; as far as the lexical grammar is concerned, they are lexically valid
// CSS.
//
// I note this for a few reasons. One is that despite the apparently high
// "flexibility", this is not a "sloppy mode": in fact the approach taken here
// is the strictest possible that can be taken while still being conformant.
// The reasons CSS is designed this way are interesting; one is the obvious fact
// that the key use case (browser style sheets) benefits from being "hard to
// break", but another less obvious one is that the CSS specifications, which
// are modular building blocks rather than monolithic versioned steps, have been
// deliberately account for future syntax extensions that a given agent may not
// understand. So by clearly defining what will be permitted as "ignorable",
// typically with the semantics of comments, a large space is left open for
// future growth that will always be backwards compatible. It’s very clever!
//
// These facts lead to distinct patterns in this lexer. Most obviously, calls to
// _fail() are rare, but a less obvious consequence of this "recovery" approach
// is that the number of junctions where we call _reconsume() is very high; this
// is because 90% of the _reconsume() calls occur where, in a more typical
// language, we would instead be calling _fail().

export default class CSSLexer extends Lexer {
  constructor(opts) {
    super(opts);

    this._escapeCP        = 0;
    this._lexAfterEscape  = undefined;
    this._rangeCount      = 0;
    this._stringDelimiter = 0x22;
    this._wildBits        = 0;
  }

  // Parsing layers will be interested additional methods for introspecting
  // tokens; the methods relevent to each token type being listed here:
  //
  // (indented text from CSS3 § 4)
  //
  //   <ident-token>, <function-token>, <at-keyword-token>, <hash-token>,
  //   <string-token>, and <url-token> have a value composed of zero or more
  //   code points.
  //
  // this.getStringValueForToken(i) covers this as sting value
  //
  //   <hash-token> [has] a type flag set to either "id" or "unrestricted". The
  //   type flag defaults to "unrestricted" if not otherwise set.
  //
  // this.getHashTokenType(i) returns 'ID' or 'UNRESTRICTED'
  //
  //   <delim-token> has a value composed of a single code point.
  //
  // this.getCPOfToken(i, 0) is sensible here
  //
  //   <number-token>, <percentage-token>, and <dimension-token> have a
  //   representation composed of one or more code points, and a numeric value
  //
  // this.getString(i) works for the former;
  // for the latter, use this.getNumericValueForToken(i)
  //
  //   <number-token> and <dimension-token> additionally have a type flag set to
  //   either "integer" or "number".
  //
  // this.getNumberTokenType(i) returns 'INTEGER' or 'NUMBER'
  //
  //   <dimension-token> additionally have a unit composed of one or more
  //   code points.
  //
  // this.getDimensionTokenUnit(i) returns this as a string
  //
  //   <unicode-range-token> has a start and an end, a pair of integers.
  //
  // this.getRangeForUnicodeRangeToken(i) returns a pair of codepoints

  getDimensionTokenUnit(index) {
    return this.getTokenStringValue(index).slice(this.getTokenMeta(index) >> 1);
  }

  getHashTokenType(index) {
    return this.getTokenMeta(index) === 1 ? 'ID' : 'UNRESTRICTED';
  }

  getNumberTokenType(index) {
    return this.getTokenMeta(index) & 0b1 ? 'NUMBER' : 'INTEGER';
  }

  getNumericValueForToken(index) {
    // The CSS syntax for numbers always yields a value that can be parsed with
    // ES Number.parseFloat (which permits leading zeros & discards the units).
    return Number.parseFloat(this.getStringForToken(index));
  }

  getRangeForUnicodeRangeToken(index) {
    return this.getTokenMeta(index);
  }

  getTokenObject(index) {
    const token = super.getTokenObject(index);

    switch (this.getToken(index)) {
      case HASH_TOKEN:
        token.hashType = this.getHashTokenType(index);
        break;
      case DIMENSION_TOKEN:
        token.unit = this.getDimensionTokenUnit(index);
      case NUMBER_TOKEN:
      case PERCENTAGE_TOKEN:
        token.numericValue = this.getNumericValueForToken(index);
        token.numberType = this.getNumberTokenType(index);
        break;
    }

    return token;
  }

  _beginTokenUnit(...cps) {
    this._tokenValue = [ ...this.getSegment(this._tokenStart, this._length) ];
    this._tokenMeta += this._tokenValue.length << 1;
    this._tokenValue.push(...cps);
  }

  _normalize(cp) {
    switch (cp) {
      case 0x0000: return 0xFFFD;
      case 0x000A: if (this._lastCPWasCR) return;
      case 0x000C:
      case 0x000D: return 0x000A;
      default: return cp;
    }
  }

  _normalizeEscapeCP() {
    if (this._escapeCP === 0)
      return 0xFFFD;
    if (this._escapeCP > 0x10FFFF)
      return 0xFFFD;
    if (this._escapeCP >= 0xD800 && this._escapeCP <= 0xDFFF)
      return 0xFFFD;

    return this._escapeCP;
  }

  $atKeyword(cp) {
    if (cp === 0x5C)
      this._lex = this.$atKeywordEscape;
    else if (isNameContinue(cp))
      this._tokenValue.push(cp);
    else
      this._token(AT_KEYWORD_TOKEN, 1);
  }

  $atKeywordEscape(cp) {
    if (cp === 0x0A)
      this._token(AT_KEYWORD_TOKEN, 2);
    else
      this._lexAfterEscape = this.$atKeyword,
      this._reconsume(this.$escape, 1);
  }

  $comment(cp) {
    if (cp === 0x2A)
      this._lex = this.$commentAsterisk;
    else if (cp === -1)
      this._token(COMMENT_TOKEN);
  }

  $commentAsterisk(cp) {
    if (cp === 0x2F || cp === -1)
      this._token(COMMENT_TOKEN);
    else if (cp !== 0x2A)
      this._lex = this.$comment;
  }

  $delimOrAtKeyword(cp) {
    if (cp === 0x2D)
      this._lex = this.$delimOrAtKeywordWithHyphen;
    else if (cp === 0x5C)
      this._lex = this.$delimOrAtKeywordWithBackslash;
    else if (isNameStart(cp))
      this._tokenValue = [ cp ],
      this._lex = this.$atKeyword;
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrAtKeywordWithBackslash(cp) {
    if (cp === 0x0A)
      this._token(DELIM_TOKEN, 2);
    else
      this._tokenValue = [],
      this._reconsume(this.$atKeyword, 2);
  }

  $delimOrAtKeywordWithHyphen(cp) {
    if (cp === 0x5C)
      this._lex = this.$delimOrAtKeywordWithHyphenBackslash;
    else if (isNameStart(cp))
      this._tokenValue = [ 0x2D ],
      this._lex = this.$atKeyword;
    else
      this._token(DELIM_TOKEN, 2);
  }

  $delimOrAtKeywordWithHyphenBackslash(cp) {
    if (cp === 0x0A)
      this._token(DELIM_TOKEN, 3);
    else
      this._tokenValue = [ 0x2D ],
      this._reconsume(this.$atKeyword, 2);
  }

  $delimOrCDC(cp) {
    if (cp === 0x3E)
      this._token(CDC_TOKEN);
    else
      this._token(DELIM_TOKEN, 2);
  }

  $delimOrCDO(cp) {
    if (cp === 0x21)
      this._lex = this.$delimOrCDOExclamation;
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrCDOExclamation(cp) {
    if (cp === 0x2D)
      this._lex = this.$delimOrCDOExclamationHyphen;
    else
      this.token(DELIM_TOKEN, 2);
  }

  $delimOrCDOExclamationHyphen(cp) {
    if (cp === 0x2D)
      this._token(CDO_TOKEN);
    else
      this._token(DELIM_TOKEN, 3);
  }

  $delimOrComment(cp) {
    if (cp === 0x2A)
      this._lex = this.$comment;
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrDashMatchOrColumn(cp) {
    if (cp === 0x3D)
      this._token(DASH_MATCH_TOKEN);
    else if (cp === 0x73)
      this._token(COLUMN_TOKEN);
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrFractionalNumber(cp) {
    if (cp >= 0x30 && cp <= 0x39)
      this._tokenMeta = 0b1,
      this._lex = this.$numberInDecimal;
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrHash(cp) {
    if (isNameStart(cp))
      this._tokenMeta = 1;

    if (isNameContinue(cp))
      this._tokenValue = [ cp ],
      this._lex = this.$hash;
    else if (cp === 0x5C)
      this._lex = this.$delimOrHashWithBackslash;
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrHashWithBackslash(cp) {
    if (cp === 0x0A)
      this._token(DELIM_TOKEN, 2);
    else
      this._tokenValue = [],
      this._reconsume(this.$hash, 2);
  }

  $delimOrIdentFromBackslash(cp) {
    if (cp === 0x0A)
      this._fail(`A line terminator is not a valid identifier escape`);
    else
      this._reconsume(this.$ident, 2);
  }

  $delimOrIdentFromHyphen(cp) {
    if (cp === 0x0A)
      this._token(DELIM_TOKEN, 2);
    else
      this._reconsume(this.$ident, 3);
  }

  $delimOrIdentHyphen(cp) {
    if (cp === 0x0A)
      this._token(DELIM_TOKEN, 2);
    else
      this._reconsume(this.$ident, 3);
  }

  $delimOrIncludeMatch(cp) {
    if (cp === 0x3D)
      this._token(INCLUDE_MATCH_TOKEN);
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrNegativeSignedNumberOrCDCOrIdent(cp) {
    if (cp === 0x2E)
      this._lex = this.$delimOrSignedNumberFractional;
    else if (cp >= 0x30 && cp <= 0x39)
      this._lex = this.$number;
    else if (cp === 0x5C)
      this._lex = this.$delimOrIdentFromHyphen;
    else if (cp === 0x2D)
      this._lex = this.$delimOrCDC;
    else if (isNameStart(cp))
      this._reconsume(this.$ident, 2);
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrPositiveSignedNumber(cp) {
    if (cp === 0x2E)
      this._lex = this.$delimOrSignedNumberFractional;
    else if (cp >= 0x30 && cp <= 0x39)
      this._lex = this.$number;
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrPrefixMatch(cp) {
    if (cp === 0x3D)
      this._token(PREFIX_MATCH_TOKEN);
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrSignedNumberFractional(cp) {
    if (cp >= 0x30 && cp <= 0x39)
      this._tokenMeta = 0b1,
      this._lex = this.$numberInDecimal;
    else
      this._token(DELIM_TOKEN, 2);
  }

  $delimOrSubstringMatch(cp) {
    if (cp === 0x3D)
      this._token(SUBSTRING_MATCH_TOKEN);
    else
      this._token(DELIM_TOKEN, 1);
  }

  $delimOrSuffixMatch(cp) {
    if (cp === 0x3D)
      this._token(SUFFIX_MATCH_TOKEN);
    else
      this._token(DELIM_TOKEN, 1);
  }

  $escape(cp) {
    if (isHex(cp))
      this._escapeCP = toHexValue(cp),
      this._lex = this.$escapeHex;
    else if (cp === -1)
      this._tokenValue.push(0xFFFD),
      this._lex = this._lexAfterEscape;
    else
      this._tokenValue.push(cp),
      this._lex = this._lexAfterEscape;
  }

  $escapeHex(cp) {
    if (isHex(cp)) {
      this._escapeCP <<= 4;
      this._escapeCP += toHexValue(cp);
      return;
    }

    this._tokenValue.push(this._normalizeEscapeCP());

    switch (cp) {
      case 0x09:
      case 0x0A:
      case 0x20:
        this._lex = this._lexAfterEscape;
        return;
      default:
        this._reconsume(this._lexAfterEscape, 1);
    }
  }

  $hash(cp) {
    if (isNameContinue(cp))
      this._tokenValue.push(cp);
    else if (cp === 0x5C)
      this._lex = this.$hashEscape;
    else
      this._token(HASH_TOKEN, 1);
  }

  $hashEscape(cp) {
    if (cp === 0x0A) {
      this._token(HASH_TOKEN, 2);
    } else {
      switch (this._tokenValue.length) {
        case 0:
          this._tokenMeta = 1;
          break;
        case 1:
          if (this._tokenValue[0] === 0x2D)
            this._tokenMeta = 1;
          break;
      }

      this._lexAfterEscape = this.$hash;
      this._reconsume(this.$escape, 1);
    }
  }

  $ident(cp) {
    this._tokenValue = this._tokenValue || [];

    if (cp === 0x5C) {
      this._lex = this.$identEscape;
    } else if (isNameContinue(cp)) {
      this._tokenValue.push(cp);
    } else if (cp === 0x28) {
      if (isURLIdent(this._tokenValue))
        this._tokenValue = [],
        this._lex = this.$url;
      else
        this._token(FUNCTION_TOKEN);
    } else {
      this._token(IDENT_TOKEN, 1);
    }
  }

  $identEscape(cp) {
    if (cp === 0x0A)
      this._token(IDENT_TOKEN, 2);
    else
      this._lexAfterEscape = this.$ident,
      this._reconsume(this.$escape, 1);
  }

  $input(cp) {
    switch (cp) {
      case 0x0A:
      case 0x09:
      case 0x20:
        this._lex = this.$whitespace;
        return;
      case 0x22:
        this._stringDelimiter = 0x22;
        this._tokenValue = [];
        this._lex = this.$string;
        return;
      case 0x23:
        this._lex = this.$delimOrHash;
        return;
      case 0x24:
        this._lex = this.$delimOrSuffixMatch;
        return;
      case 0x27:
        this._stringDelimiter = 0x27;
        this._tokenValue = [];
        this._lex = this.$string;
        return;
      case 0x28:
        this._token(LEFT_PARENTHESIS_TOKEN);
        return;
      case 0x29:
        this._token(RIGHT_PARENTHESIS_TOKEN);
        return;
      case 0x2A:
        this._lex = this.$delimOrSubstringMatch;
        return;
      case 0x2B:
        this._lex = this.$delimOrPositiveSignedNumber;
        return;
      case 0x2C:
        this._token(COMMA_TOKEN);
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
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
      case 0x36:
      case 0x37:
      case 0x38:
      case 0x39:
        this._lex = this.$number;
        return;
      case 0x3A:
        this._token(COLON_TOKEN);
        return;
      case 0x3B:
        this._token(SEMICOLON_TOKEN);
        return;
      case 0x3C:
        this._lex = this.$delimOrCDO;
        return;
      case 0x40:
        this._lex = this.$delimOrAtKeyword;
        return;
      case 0x55:
      case 0x75:
        this._lex = this.$unicodeRangeOrIdent;
        return;
      case 0x5B:
        this._token(LEFT_BRACKET_TOKEN);
        return;
      case 0x5C:
        this._lex = this.$delimOrIdentFromBackslash;
        return;
      case 0x5D:
        this._token(RIGHT_BRACKET_TOKEN);
        return;
      case 0x5E:
        this._lex = this.$delimOrPrefixMatch;
        return;
      case 0x7B:
        this._token(LEFT_BRACE_TOKEN);
        return;
      case 0x7C:
        this._lex = this.$delimOrDashMatchOrColumn;
        return;
      case 0x7D:
        this._token(RIGHT_BRACE_TOKEN);
        return;
      case 0x7E:
        this._lex = this.$delimOrIncludeMatch;
        return;
      case -1:
        return;
      default:
        if (isNameStart(cp))
          this._reconsume(this.$ident, 1);
        else
          this._token(DELIM_TOKEN);
    }
  }

  $number(cp) {
    switch (cp) {
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
      case 0x36:
      case 0x37:
      case 0x38:
      case 0x39:
        return;
      case 0x2E:
        this._lex = this.$numberDecimalPossible;
        return;
      case 0x45:
      case 0x65:
        this._lex = this.$numberExponentE;
        return;
      default:
        this._lex = this.$numberPossibleUnit;
    }
  }

  $numberDecimalPossible(cp) {
    if (cp >= 0x30 && cp <= 0x39)
      this._tokenMeta = 0b1,
      this._lex = this.$numberInDecimal;
    else
      this._token(NUMBER_TOKEN, 2);
  }

  $numberExponentE(cp) {
    switch (cp) {
      case 0x2D:
      case 0x2B:
        this._lex = this.$numberExponentESigned;
        return;
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
      case 0x36:
      case 0x37:
      case 0x38:
      case 0x39:
        this._tokenMeta = 1;
        this._lex = this.$numberInDecimal;
        return;
      default:
        this._reconsume(this.$numberPossibleUnit, 2);
    }
  }

  $numberExponentESigned(cp) {
    switch (cp) {
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
      case 0x36:
      case 0x37:
      case 0x38:
      case 0x39:
        this._tokenMeta = 1;
        this._lex = this.$numberInDecimal;
        return;
      default:
        this._reconsume(this.$numberPossibleUnit, 3);
    }
  }

  $numberInDecimal(cp) {
    switch (cp) {
      case 0x30:
      case 0x31:
      case 0x32:
      case 0x33:
      case 0x34:
      case 0x35:
      case 0x36:
      case 0x37:
      case 0x38:
      case 0x39:
        return;
      default:
        this._reconsume(this.$numberPossibleUnit, 1);
    }
  }

  $numberPossibleUnit(cp) {
    if (cp === 0x25)
      this._token(PERCENTAGE_TOKEN);
    else if (cp === 0x2D)
      this._lex = this.$numberPossibleUnitHyphen;
    else if (isNameStart(cp))
      this._beginTokenUnit(cp),
      this._lex = this.$numberUnit;
    else if (cp === 0x5C)
      this._lex = this.$numberPossibleUnitEscape;
    else
      this._token(NUMBER_TOKEN, 1);
  }

  $numberPossibleUnitEscape(cp) {
    if (cp === 0x0A)
      this._token(NUMBER_TOKEN, 2);
    else
      this._beginTokenUnit(),
      this._lexAfterEscape = this.$numberUnit,
      this._reconsume(this.$escape, 1);
  }

  $numberPossibleUnitHyphen(cp) {
    if (cp === 0x5C)
      this._lex = this.$numberPossibleUnitHyphenEscape;
    else if (isNameStart(cp))
      this._beginTokenUnit(0x2D, cp),
      this._lex = this.$numberUnit;
    else
      this._token(NUMBER_TOKEN, 2);
  }

  $numberPossibleUnitHyphenEscape(cp) {
    if (cp === 0x0A)
      this._token(NUMBER_TOKEN, 3);
    else
      this._beginTokenUnit(0x2D),
      this._lexAfterEscape = this.$numberUnit,
      this._reconsume(this.$escape, 1);
  }

  $numberUnit(cp) {
    if (cp === 0x5C)
      this._lex = this.$numberUnitEscape;
    else if (isNameContinue(cp))
      this._tokenValue.push(cp);
    else
      this._token(DIMENSION_TOKEN, 1);
  }

  $numberUnitEscape(cp) {
    if (cp === 0x0A)
      this._token(DIMENSION_TOKEN, 2);
    else
      this._lexAfterEscape = this.$numberUnit,
      this._reconsume(this.$escape, 1);
  }

  $string(cp) {
    switch (cp) {
      case this._stringDelimiter:
      case -1:
        this._token(STRING_TOKEN);
        return;
      case 0x0A:
        this._fail(`String may not contain unescaped line terminator`);
        return;
      case 0x5C:
        this._lex = this.$stringEscape;
        return;
      default:
        this._tokenValue.push(cp);
    }
  }

  $stringEscape(cp) {
    switch (cp) {
      case -1:
        this._token(STRING_TOKEN);
        return;
      case 0x0A:
        this._tokenValue.push(cp);
        return;
      default:
        this._lexAfterEscape = this.$string;
        this._reconsume(this.$escape, 1);
    }
  }

  $unicodeRange(cp) {
    if (cp === 0x2D)
      this._lex = this.$unicodeRangeContinueOrDelim;
    else if (this._rangeCount === 6)
      this._tokenMeta[1] = this._tokenMeta[0],
      this._token(UNICODE_RANGE_TOKEN, 1);
    else if (cp === 0x3F)
      this._rangeCount++,
      this._wildBits = 4,
      this._lex = this.$unicodeRangeWildcard;
    else if (isHex(cp))
      this._rangeCount++,
      this._tokenMeta[0] <<= 4,
      this._tokenMeta[0] += toHexValue(cp);
    else
      this._tokenMeta[1] = this._tokenMeta[0],
      this._token(UNICODE_RANGE_TOKEN, 1);
  }

  $unicodeRangeContinueOrDelim(cp) {
    if (isHex(cp))
      this._rangeCount = 1,
      this._tokenMeta[1] = toHexValue(cp),
      this._lex = this.$unicodeRangeContinue;
    else
      this._tokenMeta[1] = this._tokenMeta[0],
      this._token(UNICODE_RANGE_TOKEN, 2);
  }

  $unicodeRangeOrIdent(cp) {
    if (cp === 0x2B)
      this._lex = this.$unicodeRangeOrIdentPlus;
    else
      this._reconsume(this.$ident, 2);
  }

  $unicodeRangeOrIdentPlus(cp) {
    if (cp === 0x3F)
      this._tokenMeta = [],
      this._rangeCount = 1,
      this._wildBits = 4,
      this._lex = this.$unicodeRangeWildcard;
    else if (isHex(cp))
      this._tokenMeta = [ toHexValue(cp) ],
      this._rangeCount = 1,
      this._lex = this.$unicodeRange;
    else
      this._reconsume(this.$ident, 3);
  }

  $unicodeRangeWildcard(cp) {
    if (cp === 0x3F && this._rangeCount !== 6)
      this._rangeCount++,
      this._wildBits += 4;
    else
      this._tokenMeta[1] = this._tokenMeta[0] <<= this._wildBits,
      this._tokenMeta[1] &= 2 ** this._wildBits - 1,
      this._token(UNICODE_RANGE_TOKEN, 1);
  }

  $url(cp) {
    switch (cp) {
      case 0x0A:
      case 0x09:
      case 0x20:
        return;
      default:
        this._reconsume(this.$urlAfterWhitespace, 1);
    }
  }

  $urlAfterWhitespace(cp) {
    if (cp === 0x22 || cp === 0x27)
      this._stringDelimiter = cp,
      this._lex = this.$urlString;
    else if (cp === 0x29 || cp === -1)
      this._token(URL_TOKEN);
    else if (isNonPrintable(cp))
      this._fail(`"Non-printable" characters are illegal in URL literals`);
    else if (cp === 0x28)
      this._fail(`Illegal character in URL literal`);
    else if (cp === 0x5C)
      this._lex = this.$urlLiteralEscape;
    else
      this._tokenValue.push(cp),
      this._lex = this.$urlLiteral;
  }

  $urlLiteral(cp) {
    if (cp === 0x29 || cp === -1)
      this._token(URL_TOKEN);
    else if (cp === 0x22 || cp === 0x27 || cp === 0x28)
      this._fail(`Illegal character in URL literal`);
    else if (isNonPrintable(cp))
      this._fail(`"Non-printable" characters are illegal in URL literals`);
    else if (cp === 0x5C)
      this._lex = this.$urlLiteralEscape;
    else if (cp === 0x0A || cp === 0x09 || cp === 0x20)
      this._lex = this.$urlTail;
    else
      this._tokenValue.push(cp);
  }

  $urlLiteralEscape(cp) {
    if (cp === 0x0A)
      this._fail(`Illegal line terminator escape in URL literal`);
    else
      this._lexAfterEscape = this.$urlLiteral,
      this._reconsume(this.$escape, 1);
  }

  $urlString(cp) {
    switch (cp) {
      case -1:
        this._token(URL_TOKEN);
        return;
      case this._stringDelimiter:
        this._lex = this.$urlTail;
        return;
      case 0x0A:
        this._fail(`String may not contain unescaped line terminator`);
        return;
      case 0x5C:
        this._lex = this.$urlStringEscape;
        return;
      default:
        this._tokenValue.push(cp);
    }
  }

  $urlStringEscape(cp) {
    switch (cp) {
      case -1:
        this._token(URL_TOKEN);
        return;
      case 0x0A:
        this._tokenValue.push(cp);
        return;
      default:
        this._lexAfterEscape = this.$urlString;
        this._reconsume(this.$escape, 1);
    }
  }

  $urlTail(cp) {
    switch (cp) {
      case 0x0A:
      case 0x09:
      case 0x20:
        return;
      case 0x29:
      case -1:
        this._token(URL_TOKEN);
        return;
      default:
        this._fail(`Illegal content in URL token after value portion`);
    }
  }

  $whitespace(cp) {
    switch (cp) {
      case 0x0A:
      case 0x09:
      case 0x20:
        return;
      default:
        this._token(WHITESPACE_TOKEN, 1);
    }
  }
}

CSSLexer.defineTokens([
  'AT_KEYWORD_TOKEN',
  'CDC_TOKEN',
  'CDO_TOKEN',
  'COLON_TOKEN',
  'COLUMN_TOKEN',
  'COMMA_TOKEN',
  'COMMENT_TOKEN',
  'DASH_MATCH_TOKEN',
  'DELIM_TOKEN',
  'DIMENSION_TOKEN',
  'FUNCTION_TOKEN',
  'HASH_TOKEN',
  'IDENT_TOKEN',
  'INCLUDE_MATCH_TOKEN',
  'LEFT_BRACE_TOKEN',
  'LEFT_BRACKET_TOKEN',
  'LEFT_PARENTHESIS_TOKEN',
  'NUMBER_TOKEN',
  'PERCENTAGE_TOKEN',
  'PREFIX_MATCH_TOKEN',
  'RIGHT_BRACE_TOKEN',
  'RIGHT_BRACKET_TOKEN',
  'RIGHT_PARENTHESIS_TOKEN',
  'SEMICOLON_TOKEN',
  'STRING_TOKEN',
  'SUBSTRING_MATCH_TOKEN',
  'SUFFIX_MATCH_TOKEN',
  'UNICODE_RANGE_TOKEN',
  'URL_TOKEN',
  'WHITESPACE_TOKEN'
]);

const {
  AT_KEYWORD_TOKEN,
  CDC_TOKEN,
  CDO_TOKEN,
  COLON_TOKEN,
  COLUMN_TOKEN,
  COMMA_TOKEN,
  COMMENT_TOKEN,
  DASH_MATCH_TOKEN,
  DELIM_TOKEN,
  DIMENSION_TOKEN,
  FUNCTION_TOKEN,
  HASH_TOKEN,
  IDENT_TOKEN,
  INCLUDE_MATCH_TOKEN,
  LEFT_BRACE_TOKEN,
  LEFT_BRACKET_TOKEN,
  LEFT_PARENTHESIS_TOKEN,
  NUMBER_TOKEN,
  PERCENTAGE_TOKEN,
  PREFIX_MATCH_TOKEN,
  RIGHT_BRACE_TOKEN,
  RIGHT_BRACKET_TOKEN,
  RIGHT_PARENTHESIS_TOKEN,
  SEMICOLON_TOKEN,
  STRING_TOKEN,
  SUBSTRING_MATCH_TOKEN,
  SUFFIX_MATCH_TOKEN,
  UNICODE_RANGE_TOKEN,
  URL_TOKEN,
  WHITESPACE_TOKEN
} = CSSLexer.TOKENS;
