
const NEW_LINES = /(?:\r\n|[\n\r\u2028\u2029])+/g;
const SPACES = / +/g;
const OTHER_CONTROL = /[\0-\x1F\x80-\x9F]/g;

const format = (light, dark) => str => `${ light }${
  str
    .replace(NEW_LINES, ws => `${ dark }${ '¶'.repeat(ws.length) }${ light }`)
    .replace(SPACES, ws => `${ dark }${ '·'.repeat(ws.length) }${ light }`)
    .replace(OTHER_CONTROL, char =>
      `${ dark }\\x${
        char.codePointAt(0).toString(16).toUpperCase().padStart(2, '0')
      }${ light }`
    )
  }\u001b[39m`;

const formatNeutral = format('\x1B[38;5;242m', '\x1B[38;5;241m');
const formatRed = format('\x1B[38;5;197m', '\x1B[38;5;203m');


console.log(`${ formatNeutral('  poop? \n') }${ formatRed('butter hole') }`);
