import Lexer from './lexer';

const isHex = cp =>
  (cp >= 0x30 && cp <= 0x39) ||
  (cp >= 0x41 && cp <= 0x46) ||
  (cp >= 0x61 && cp <= 0x66);

const isNameStart = cp =>
  (cp >= 0x41 && cp <= 0x5A) ||
  (cp >= 0x61 && cp <= 0x7A) ||
  (cp === 0x5F) ||
  (cp >= 0x80);

export default class CSSLexer extends Lexer {
  constructor(opts) {
    super(opts);

    this._codepoint = this.$input;
    this._stringDelimiter = undefined;
  }

  advancePosition(tokenType, consumedCurrent=true) {
    this._codepoint = this.$input;
    super.advancePosition(tokenType, consumedCurrent);
  }

  // CSS requires stream preprocessing, so there's an extra step here

  codepoint(cp) {
    if (this.lastCPWasCR && cp !== 0x000A) {
      this._codepoint(0x000A);
      if (this.error) return;
    }

    switch (cp) {
      case 0x0000: cp = 0xFFFD; break;
      case 0x000C: cp = 0x000A; break;
    }

    this._codepoint(cp);
  }

  // Lexical states

  $delimOrAtKeyword(cp) {}

  $delimOrCDO(cp) {}

  $delimOrComment(cp) {}

  $delimOrDashMatchOrColumn(cp) {}

  $delimOrFractionalNumber(cp) {}

  $delimOrHash(cp) {}

  $delimOrIncludeMatch(cp) {}

  $delimOrNegativeSignedNumberOrCDCOrIdent(cp) {}

  $delimOrPositiveSignedNumber(cp) {}

  $delimOrPrefixMatch(cp) {}

  $delimOrSubstringMatch(cp) {}

  $delimOrSuffixMatch(cp) {}

  $escape(cp) {}

  $ident(cp) {}

  $input(cp) {
    switch (cp) {
      case 0x0A:
      case 0x09:
      case 0x20:
        this._codepoint = this.$whitespace;
        return;
      case 0x22:
        this._stringDelimiter = 0x22;
        this._codepoint = this.$string;
        return;
      case 0x23:
        this._codepoint = this.$delimOrHash;
        return;
      case 0x24:
        this._codepoint = this.$delimOrSuffixMatch;
        return;
      case 0x27:
        this._stringDelimiter = 0x27;
        this._codepoint = this.$string;
        return;
      case 0x28:
        this.advancePosition(LEFT_PARENTHESIS_TOKEN);
        return;
      case 0x29:
        this.advancePosition(RIGHT_PARENTHESIS_TOKEN);
        return;
      case 0x2A:
        this._codepoint = this.$delimOrSubstringMatch;
        return;
      case 0x2B:
        this._codepoint = this.$delimOrPositiveSignedNumber;
        return;
      case 0x2C:
        this.advancePosition(COMMA_TOKEN);
        return;
      case 0x2D:
        this._codepoint = this.$delimOrNegativeSignedNumberOrCDCOrIdent;
        return;
      case 0x2E:
        this._codepoint = this.$delimOrFractionalNumber;
        return;
      case 0x2F:
        this._codepoint = this.$delimOrComment;
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
        this._codepoint = this.$number;
        return;
      case 0x3A:
        this.advancePosition(COLON_TOKEN);
        return;
      case 0x3B:
        this.advancePosition(SEMICOLON_TOKEN);
        return;
      case 0x3C:
        this._codepoint = this.$delimOrCDO;
        return;
      case 0x40:
        this._codepoint = this.$delimOrAtKeyword;
        return;
      case 0x55:
      case 0x75:
        this._codepoint = this.$unicodeRangeOrIdent;
        return;
      case 0x5B:
        this.advancePosition(LEFT_BRACKET_TOKEN);
        return;
      case 0x5C:
        this._codepoint = this.$escape;
        return;
      case 0x5D:
        this.advancePosition(RIGHT_BRACKET_TOKEN);
        return;
      case 0x5E:
        this._codepoint = this.$delimOrPrefixMatch;
        return;
      case 0x7B:
        this.advancePosition(LEFT_BRACE_TOKEN);
        return;
      case 0x7C:
        this._codepoint = this.$delimOrDashMatchOrColumn;
        return;
      case 0x7D:
        this.advancePosition(RIGHT_BRACE_TOKEN);
        return;
      case 0x7E:
        this._codepoint = this.$delimOrIncludeMatch;
        return;
      case -1:
        return;
      default:
        if (isNameStart(cp)) {
          this._codepoint = this.$ident;
          this._codepoint(cp);
          return;
        } else {
          this.advancePosition(DELIM_TOKEN);
          return;
        }
    }
  }

  $number(cp) {}

  $string(cp) {}

  $unicodeRangeOrIdent(cp) {
    if (cp === 0x2B) {
      this._codepoint = this.$unicodeRangeOrIdent2;
      return;
    }

    this._codepoint = this.$ident;
    this.reconsume(2);
  }

  $unicodeRangeOrIdent2(cp) {
    if (cp === 0x3F || isHex(cp)) {
      this._codepoint = $$unicodeRange;
      this._codepoint(cp);
      return;
    }

    this.reconsume(3);
  }

  $whitespace(cp) {
    switch (cp) {
      case 0x0A:
      case 0x09:
      case 0x20: return;
      default:
        this.advancePosition(WHITESPACE_TOKEN, false);
        return;
    }
  }
}

const AT_KEYWORD_TOKEN        = Symbol('<at-keyword-token>');
const BAD_STRING_TOKEN        = Symbol('<bad-string-token>');
const BAD_URL_TOKEN           = Symbol('<bad-url-token>');
const CDC_TOKEN               = Symbol('<CDC-token>');
const CDO_TOKEN               = Symbol('<CDO-token>');
const COLON_TOKEN             = Symbol('<colon-token>');
const COLUMN_TOKEN            = Symbol('<column-token>');
const COMMA_TOKEN             = Symbol('<comma-token>');
const COMMENT_TOKEN           = Symbol('COMMENT-TOKEN');
const DASH_MATCH_TOKEN        = Symbol('<dash-match-token>');
const DELIM_TOKEN             = Symbol('<delim-token>');
const DIMENSION_TOKEN         = Symbol('<dimension-token>');
const FUNCTION_TOKEN          = Symbol('<function-token>');
const HASH_TOKEN              = Symbol('<hash-token>');
const IDENT_TOKEN             = Symbol('<ident-token>');
const INCLUDE_MATCH_TOKEN     = Symbol('<include-match-token>');
const LEFT_BRACE_TOKEN        = Symbol('<{-token>');
const LEFT_BRACKET_TOKEN      = Symbol('<[-token>');
const LEFT_PARENTHESIS_TOKEN  = Symbol('<(-token>');
const NUMBER_TOKEN            = Symbol('<number-token>');
const PERCENTAGE_TOKEN        = Symbol('<percentage-token>');
const PREFIX_MATCH_TOKEN      = Symbol('<prefix-match-token>');
const RIGHT_BRACE_TOKEN       = Symbol('<}-token>');
const RIGHT_BRACKET_TOKEN     = Symbol('<]-token>');
const RIGHT_PARENTHESIS_TOKEN = Symbol('<)-token>');
const SEMICOLON_TOKEN         = Symbol('<semicolon-token>');
const STRING_TOKEN            = Symbol('<string-token>');
const SUBSTRING_MATCH_TOKEN   = Symbol('<substring-match-token>');
const SUFFIX_TOKEN            = Symbol('<suffix-match-token>');
const UNICODE_RANGE_TOKEN     = Symbol('<unicode-range-token>');
const URL_TOKEN               = Symbol('<url-token>');
const WHITESPACE_TOKEN        = Symbol('<whitespace-token>');

Object.defineProperties(CSSLexer, {
  AT_KEYWORD_TOKEN:        { value: AT_KEYWORD_TOKEN },
  BAD_STRING_TOKEN:        { value: BAD_STRING_TOKEN },
  BAD_URL_TOKEN:           { value: BAD_URL_TOKEN },
  CDC_TOKEN:               { value: CDC_TOKEN },
  CDO_TOKEN:               { value: CDO_TOKEN },
  COLON_TOKEN:             { value: COLON_TOKEN },
  COLUMN_TOKEN:            { value: COLUMN_TOKEN },
  COMMA_TOKEN:             { value: COMMA_TOKEN },
  COMMENT_TOKEN:           { value: COMMENT_TOKEN },
  DASH_MATCH_TOKEN:        { value: DASH_MATCH_TOKEN },
  DELIM_TOKEN:             { value: DELIM_TOKEN },
  DIMENSION_TOKEN:         { value: DIMENSION_TOKEN },
  FUNCTION_TOKEN:          { value: FUNCTION_TOKEN },
  HASH_TOKEN:              { value: HASH_TOKEN },
  IDENT_TOKEN:             { value: IDENT_TOKEN },
  INCLUDE_MATCH_TOKEN:     { value: INCLUDE_MATCH_TOKEN },
  LEFT_BRACE_TOKEN:        { value: LEFT_BRACE_TOKEN },
  LEFT_BRACKET_TOKEN:      { value: LEFT_BRACKET_TOKEN },
  LEFT_PARENTHESIS_TOKEN:  { value: LEFT_PARENTHESIS_TOKEN },
  NUMBER_TOKEN:            { value: NUMBER_TOKEN },
  PERCENTAGE_TOKEN:        { value: PERCENTAGE_TOKEN },
  PREFIX_MATCH_TOKEN:      { value: PREFIX_MATCH_TOKEN },
  RIGHT_BRACE_TOKEN:       { value: RIGHT_BRACE_TOKEN },
  RIGHT_BRACKET_TOKEN:     { value: RIGHT_BRACKET_TOKEN },
  RIGHT_PARENTHESIS_TOKEN: { value: RIGHT_PARENTHESIS_TOKEN },
  SEMICOLON_TOKEN:         { value: SEMICOLON_TOKEN },
  STRING_TOKEN:            { value: STRING_TOKEN },
  SUBSTRING_MATCH_TOKEN:   { value: SUBSTRING_MATCH_TOKEN },
  SUFFIX_TOKEN:            { value: SUFFIX_TOKEN },
  UNICODE_RANGE_TOKEN:     { value: UNICODE_RANGE_TOKEN },
  URL_TOKEN:               { value: URL_TOKEN },
  WHITESPACE_TOKEN:        { value: WHITESPACE_TOKEN }
});
