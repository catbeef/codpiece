const { CSSParser } = require('../dist');

CSSParser.fromFilename(`${ __dirname }/fodder/generic.css`, { debug: 'LEXING' });
