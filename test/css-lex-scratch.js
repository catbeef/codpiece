const { CSSLexer } = require('../dist');

const stream = new CSSLexer.TokenStream(`${ __dirname }/fodder/short.css`);

stream.on('error', console.log);
stream.on('data', token => {
  console.log(Object.entries(token).map(([ key, val='' ]) => `${ key }=${ val }`.padEnd(30)).join(''));
});
