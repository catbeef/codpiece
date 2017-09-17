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

export const formatNeutral = format('\x1B[38;5;248m', '\x1B[38;5;240m');
export const formatRed = format('\x1B[38;5;197m', '\x1B[38;5;203m');
