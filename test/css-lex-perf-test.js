const { CSSParser } = require('../dist');
const fs = require('fs');
const buf = fs.readFileSync(`${ __dirname }/fodder/generic.css`);

// Let it get hot ... (I wish I could tell the engine to "preoptimize" pathways
// somehow)

let i = 100;

const run = () => {
  const parser = CSSParser.fromBuffer(buf);
  console.time('lex time');

  parser.on('finish', () => {
    console.timeEnd('lex time');
    console.log(`${ parser._tokens.length } tokens`);

    if (i--) run();
  });
};

run();
