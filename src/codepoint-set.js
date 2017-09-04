import assert from 'assert';
import unicode from 'unicode-10.0.0';

const clearPriv = set => {
  PRIV.set(this, { hasASCII: undefined, hasNonASCII: undefined });
};

const getPropertyArr = propertyName => {
  const entry = PROPERTIES.get(propertyName);

  if (!entry.arr) entry.arr = require(entry.specifier);

  return entry.arr;
};

const getPropertySet = propertyName => {
  const entry = PROPERTIES.get(propertyName);

  if (!entry.arr) entry.arr = require(entry.specifier);

  if (!entry.set) entry.set = new CodePointSet(entry.arr);

  return entry.set;
};

const range = function * (a, b) {
  while (a <= b) yield a++;
};

const toSpecifierEntries = key => unicode[key].map(category => [
  category,
  { specifier: `unicode-10.0.0/${ key }/${ category }/code-points.js` }
]);

const validateCodePoint = cp => {
  assert(Number.isInteger(cp), 'codepoint must be finite integer');
  assert(cp >= 0, 'codepoint cannot be negative');
  assert(cp <= 0x10FFFF, 'codepoint cannot be greater than 0x10FFFF');
};

const validatePropertyName = propertyName => {
  assert(typeof propertyName === 'string', 'property name must be a string');
  assert(PROPERTIES.has(propertyName), `${ propertyName } not recognized`);
};

const validateRange = (cpA, cpB) => {
  validateCodePoint(cpA);
  validateCodePoint(cpB);
  assert(cpA <= cpB, 'codepoint range direction must be ascending');
};

const validateSet = set => {
  assert(set instanceof CodePointSet, 'set must be a CodepointSet');
};

const PRIV = new WeakMap();

const PROPERTIES = new Map([
  ...toSpecifierEntries('Binary_Property'),
  ...toSpecifierEntries('General_Category')
]);

export default class CodePointSet extends Set {
  constructor(seed) {
    super();

    if (typeof seed === 'number') {
      validateCodePoint(seed);
      super([ seed ]);
    } else if (typeof seed === 'string') {
      validatePropertyName(seed);
      super();
      this.addProperty(seed);
    } else if (seed && seed[Symbol.iterator]) {
      const cps = Array.from(seed);
      cps.forEach(validateCodePoint);
      super(cps);
    } else {
      throw new TypeError(`CodepointSet cannot be initialized with ${ seed }`);
    }

    PRIV.set(this, { hasASCII: undefined, hasNonASCII: undefined });
  }

  get hasASCII() {
    const priv = PRIV.get(this);

    if (priv.hasASCII === undefined) {
      priv.hasASCII = false;

      for (let i = 0; i < 0x80; i++) {
        if (super.has(i)) {
          priv.hasASCII = true;
          break;
        }
      }
    }

    return priv.hasASCII;
  }

  get hasNonASCII() {
    const priv = PRIV.get(this);

    if (priv.hasNonASCII === undefined) {
      const asciiCount = 0;

      for (let i = 0; i < 0x80; i++) {
        asciiCount += Number(super.has(i));
      }

      priv.hasNonASCII = this.size > asciiCount;
    }

    return priv.hasNonASCII;
  }

  add(cp) {
    validateCodePoint(cp);
    clearPriv(this);
    return super.add(cp);
  }

  addProperty(propertyName) {
    validatePropertyName(propertyName);
    clearPriv(this);
    return this.addSet(getPropertySet(propertyName));
  }

  addRange(cpA, cpB) {
    validateRange(cpA, cpB);
    clearPriv(this);
    return this.addSet(new this(range(cpA, cpB)));
  }

  addSet(set) {
    validateSet(set);
    clearPriv(this);
    set.forEach(cp => super.add(cp));
    return this;
  }

  delete(cp) {
    validateCodePoint(cp);
    clearPriv(this);
    return super.delete(cp);
  }

  deleteProperty(propertyName) {
    validatePropertyName(propertyName);
    clearPriv(this);
    return this.deleteSet(getPropertySet(propertyName));
  }

  deleteRange(cpA, cpB) {
    validateRange(cpA, cpB);
    clearPriv(this);
    return this.deleteSet(new this(range(cpA, cpB)));
  }

  deleteSet(set) {
    validateSet(set);
    clearPriv(this);
    set.forEach(cp => super.delete(cp));
    return this;
  }

  has(cp) {
    validateCodePoint(cp);
    return super.has(cp);
  }

  hasProperty(propertyName) {
    validatePropertyName(propertyName);
    return getPropertyArr(propertyName).every(cp => super.has(cp));
  }

  hasRange(cpA, cpB) {
    validateRange(cpA, cpB);

    for (const cp of range(cpA, cpB)) {
      if (!super.has(cp)) return false;
    }

    return true;
  }

  hasSet(set) {
    validateSet(set);

    for (const cp of set) {
      if (!super.has(cp)) return false;
    }

    return true;
  }
}
