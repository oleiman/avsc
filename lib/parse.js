/* jshint node: true */

// TODO: Implement `typeHook`. (Called after each type is instantiated.)
// TODO: Move type subclasses' methods to prototypes.
// TODO: Add aliases support.
// TODO: Add `equals` and `compare` method to each type.
// TODO: Implement `toJSON` method on Avro types, to recover a schema.
// TODO: Fail when writing or reading fails with an error other than out of
// bounds. (Maybe use custom decode and encode errors?)

'use strict';

var Tap = require('./tap'),
    util = require('util');


// Avro primitive types.
var PRIMITIVES = [
  'null',
  'boolean',
  'int',
  'long',
  'float',
  'double',
  'bytes',
  'string'
];


/**
 * Custom error, thrown when an invalid schema is encountered.
 *
 * @param message {String} Something useful. Any further arguments will be used
 * to format the message.
 *
 */
function AvscError(message) {

  Error.call(this);
  var l = arguments.length;
  if (l > 1) {
    var args = [];
    var i;
    for(i = 1; i < l; i++) {
      args[i] = arguments[i];
    }
    this.message = util.format(message, args);
  } else {
    this.message = message;
  }

}
util.inherits(AvscError, Error);


/**
 * Parse a schema.
 *
 * @param schema {Object|String} Schema (type object or type name string).
 * @param opts {Object} Parsing options. The following keys are currently
 * supported:
 *
 * + `namespace` Optional parent namespace.
 * + `registry` Optional registry of predefined type names.
 * + `unwrapUnions` By default, Avro expects all unions to be wrapped inside an
 *   object with a single key. Setting this to `true` will prevent this.
 *   (Defaults to `false`.)
 *
 */
function parse(schema, opts) {

  opts = getOpts(schema, opts);

  var Type, type;

  if (typeof schema == 'string') { // Type reference.
    if (
      opts.namespace &&
      !~schema.indexOf('.') &&
      !~PRIMITIVES.indexOf(schema) // Primitives can't be namespaced.
    ) {
      schema = opts.namespace + '.' + schema;
    }
    type = opts.registry[schema];
    if (type) {
      return type;
    }
    throw new Error('missing name: ' + schema);
  }

  if (schema instanceof Array) { // Union.
    Type = opts.unwrapUnions ? UnwrappedUnionType : WrappedUnionType;
    return new Type(schema, opts);
  }

  type = schema.type;
  switch (type) { // Non-union complex types.
    case 'null':
    case 'boolean':
    case 'int':
    case 'long':
    case 'float':
    case 'double':
    case 'bytes':
    case 'string':
      return opts.registry[type]; // Reuse primitive instances.
    case 'array':
      return new ArrayType(schema, opts);
    case 'enum':
      return new EnumType(schema, opts);
    case 'fixed':
      return new FixedType(schema, opts);
    case 'map':
      return new MapType(schema, opts);
    case 'record':
      return new RecordType(schema, opts);
    default:
      throw new AvscError('unknown type: %j', type);
  }

}


/**
 * "Abstract" base Avro type class.
 *
 * Not meant to be instantiated directly, but via the `parse` function above.
 *
 */
function Type() {}

/**
 * Initialize registry, defining all primitives.
 *
 */
Type.createRegistry = function () {

  var registry = {};
  var i, l, name;
  for (i = 0, l = PRIMITIVES.length; i < l; i++) {
    name = PRIMITIVES[i];
    registry[name] = new PrimitiveType(name);
  }
  return registry;

};

/**
 * Base decoding method.
 *
 * This method should always be called with a tap as context. For example:
 * `type._read.call(tap)`. It is also important to remember to check that the
 * tap is valid after a read.
 *
 */
Type.prototype._read = function () { throw new Error('abstract'); };

/**
 * Encode a type instance.
 *
 * @param obj {Object} The object to encode.
 *
 * Similarly to `_read` above, this method should be called with a tap as
 * context: `type._write.call(tap, obj)`. The tap should be checked for
 * validity afterwards as well.
 *
 */
Type.prototype._write = function (obj) {

  throw new Error('abstract'); // jshint unused: false

};

/**
 * Validity check.
 *
 * @param obj {Object} The object to check for validity.
 *
 */
Type.prototype._check = function (obj) {

  throw new Error('abstract'); // jshint unused: false

};

/**
 * Decode Avro bytes.
 *
 * @param buf {Buffer} Avro representation of an object.
 *
 */
Type.prototype.decode = function (buf) {

  var tap = new Tap(buf);
  var obj = this._read.call(tap);
  if (!tap.isValid()) {
    throw new Error('truncated buffer');
  }
  return obj;

};

/**
 * Encode object.
 *
 * @param obj {Object} The object to encode. Depending on the type, it can be a
 * number, a string, an array, or an object.
 * @param opts {Object} Optional encoding options:
 *
 *  + `size`, used to initialize the buffer. Defaults to 1024 bytes.
 *  + `unsafe`, bypass validity checks.
 *
 */
Type.prototype.encode = function (obj, opts) {

  if ((!opts || !opts.unsafe) && !this.isValid(obj)) {
    throw new Error('invalid object');
  }

  var size = (opts ? opts.size : 0) || 1024;
  var tap = new Tap(new Buffer(size));
  this._write.call(tap, obj);
  if (!tap.isValid) {
    // We overflowed the buffer, need to resize.
    tap.buf = new Buffer(tap.pos);
    tap.pos = 0;
    this._write.call(tap, obj);
  }

  return tap.buf.slice(0, tap.pos);

};

/**
 * Check that the object can be encoded by this type.
 *
 * @param obj {Object} The object to check.
 *
 */
Type.prototype.isValid = function (obj) { return this._check(obj); };

/**
 * Generate a random instance of this type.
 *
 */
Type.prototype.random = function () { return new Error('abstract'); };

/**
 * Get Avro name for this type.
 *
 */
Type.prototype.getTypeName = function () { return new Error('abstract'); };


// Implementations.

/**
 * Primitive Avro types.
 *
 * These are grouped together and all instances are typically shared across a
 * single schema (since the default registry defines their name).
 *
 */
function PrimitiveType(name) {

  this.getTypeName = function () { return name; };
  this._read = Tap.prototype['read' + capitalize(name)];
  this._write = Tap.prototype['write' + capitalize(name)];

  switch (name) {
    case 'null':
      this._check = function (o) { return o === null; };
      this.random = function () { return null; };
      break;
    case 'boolean': // jshint -W018
      this._check = function (o) { return o !== !o; };
      this.random = function () { return !!(Math.random() < 0.5); };
      break; // jshint +W018
    case 'int':
      this._check = function (o) { return o === (o | 0); };
      this.random = function () { return randomDouble(-1e3, 1e3) | 0; };
      break;
    case 'long':
      this._check = function (o) {
        return typeof o == 'number' &&
          o % 1 === 0 &&
          o <= Number.MAX_SAFE_INTEGER &&
          o >= Number.MIN_SAFE_INTEGER; // Can't capture full range sadly.
      };
      this.random = function () {
        return Math.floor(randomDouble(-1e6, 1e6));
      };
      break;
    case 'float':
      this._check = function (o) {
        return typeof o == 'number' && Math.abs(o) < 3.4028234e38;
      };
      this.random = function () { return randomDouble(-1e3, 1e3); };
      break;
    case 'double':
      this._check = function (o) { return typeof o == 'number'; };
      this.random = function () { return randomDouble(-1e6, 1e6); };
      break;
    case 'string':
      this._check = function (o) { return typeof o == 'string'; };
      this.random = function () {
        return randomString(randomDouble(1, 16));
      };
      break;
    case 'bytes':
      this._check = Buffer.isBuffer;
      this.random = function () {
        return new Buffer(randomString(randomDouble(1, 32)));
      };
      break;
    default:
      throw new AvscError('invalid primitive type: %j', name);
  }

}
util.inherits(PrimitiveType, Type);


/**
 * Abstract base Avro union type.
 *
 */
function UnionType(schema, opts) {

  if (!(schema instanceof Array)) {
    throw new AvscError('non-array union schema: %j', schema);
  }
  if (!schema.length) {
    throw new AvscError('empty union');
  }

  opts = getOpts(schema, opts);

  this.types = schema.map(function (o) { return parse(o, opts); });

}
util.inherits(UnionType, Type);


/**
 * Wrapped Avro union type.
 *
 * This is the type required by the spec.
 *
 */
function WrappedUnionType(schema, opts) {

  UnionType.call(this, schema, opts);

  var self = this;
  var longReader = Tap.prototype.readLong;
  var longWriter = Tap.prototype.writeLong;
  var indices = {};
  var i, l, type, name;
  for (i = 0, l = this.types.length; i < l; i++) {
    type = this.types[i];
    name = type.name || type.getTypeName();
    if (indices[name] !== undefined) {
      throw new AvscError('duplicate union name: %j', name);
    }
    indices[name] = i;
  }

  var constructors = this.types.map(function (type) {

    // jshint -W054

    var name = type.name || type.getTypeName();
    if (name === 'null') {
      return null;
    }
    var body;
    if (~name.indexOf('.')) { // Qualified name.
      body = 'this[\'' + name + '\'] = obj;';
    } else {
      body = 'this.' + name + ' = obj;';
    }
    return new Function('obj', body);

  });

  this._read = function () {
    var index = longReader.call(this);
    var Class = constructors[index];
    if (Class) {
      return new Class(self.types[index]._read.call(this));
    } else {
      return null;
    }
  };

  this._write = function (obj) {
    if (typeof obj != 'object') {
      throw new Error('invalid union: ' + obj);
    }
    var name = obj === null ? 'null' : Object.keys(obj)[0];
    var index = indices[name];
    if (index === undefined) {
      throw new Error('no such name in union: ' + name);
    }
    longWriter.call(this, index);
    self.types[index]._write.call(this, obj === null ? null : obj[name]);
  };

  this._check = function (obj) {
    if (typeof obj != 'object') {
      return false;
    }
    if (obj === null) {
      return indices['null'] !== undefined;
    }
    var name = Object.keys(obj)[0];
    var index = indices[name];
    if (index === undefined) {
      return false;
    }
    return self.types[index]._check.call(this, obj[name]);
  };

  this.random = function () {
    var index = Math.floor(randomDouble(0, self.types.length));
    var Class = constructors[index];
    if (!Class) {
      return null;
    }
    return new Class(self.types[index].random());
  };

}
util.inherits(WrappedUnionType, UnionType);


/**
 * Unwrapped Avro union type.
 *
 * This version is slightly more performant and sometimes more convenient (not
 * the default since it doesn't actually adhere to the Avro spec). See
 * `unwrapUnions` option for more information.
 *
 */
function UnwrappedUnionType(schema, opts) {

  UnionType.call(this, schema, opts);

  var self = this;
  var longReader = Tap.prototype.readLong;
  var longWriter = Tap.prototype.writeLong;
  var indices = {};
  var i, l, type, name;
  for (i = 0, l = this.types.length; i < l; i++) {
    type = this.types[i];
    name = type.name || type.getTypeName();
    if (indices[name] !== undefined) {
      throw new AvscError('duplicate union name: %j', name);
    }
    indices[name] = i;
  }

  this._read = function () {
    return self.types[longReader.call(this)]._read.call(this);
  };

  this._write = function (obj) {
    var i, l, type;
    for (i = 0, l = self.types.length; i < l; i++) {
      type = self.types[i];
      if (type._check(obj)) {
        longWriter.call(this, i);
        type._write.call(this, obj);
        return;
      }
    }
    throw new Error('invalid union value: ' + obj);
  };

  this._check = function (obj) {
    return self.types.some(function (type) { return type._check(obj); });
  };

  this.random = function () {
    return self.types[Math.floor(randomDouble(0, self.types.length))].random();
  };

}
util.inherits(UnwrappedUnionType, UnionType);


/**
 * Avro enum type.
 *
 */
function EnumType(schema, opts) {

  if (!schema.name) {
    throw new AvscError('missing enum name in schema: %j', schema);
  }
  if (!(schema.symbols instanceof Array) || !schema.symbols.length) {
    throw new AvscError('invalid %j enum symbols: %j', schema.name, schema);
  }

  opts = getOpts(schema, opts);

  var self = this;
  var reader = Tap.prototype.readLong;
  var writer = Tap.prototype.writeLong;
  var indices = {};
  var i, l;
  for (i = 0, l = schema.symbols.length; i < l; i++) {
    indices[schema.symbols[i]] = i;
  }

  this.name = getQualifiedName(schema, opts.namespace);
  opts.registry[this.name] = this;
  this.doc = schema.doc;
  this.symbols = schema.symbols;

  this._read = function () { return self.symbols[reader.call(this)]; };

  this._write = function (s) {
    var index = indices[s];
    if (index === undefined) {
      throw new Error('invalid ' + self.name + ' enum value: ' + s);
    }
    writer.call(this, index);
  };

  this._check = function (s) {
    return typeof s == 'string' && indices[s] !== undefined;
  };

}
util.inherits(EnumType, Type);

EnumType.prototype.getTypeName = function () { return 'enum'; };

EnumType.prototype.random = function () {

  return this.symbols[Math.floor(randomDouble(0, this.symbols.length))];

};


/**
 * Avro fixed type.
 *
 */
function FixedType(schema, opts) {

  if (!schema.name) {
    throw new AvscError('missing fixed name: %j', schema);
  }
  if (schema.size !== (schema.size | 0) || schema.size < 1) {
    throw new AvscError('invalid %j fixed size: %j', schema.name, schema.size);
  }

  opts = getOpts(schema, opts);

  var self = this;
  var reader = Tap.prototype.readFixed;
  var writer = Tap.prototype.writeFixed;

  this.name = getQualifiedName(schema, opts.namespace);
  opts.registry[this.name] = this;
  this.size = schema.size;

  this._read = function () { return reader.call(this, self.size); };

  this._write = function (buf) { writer.call(this, buf, self.size); };

  this._check = function (buf) {
    return Buffer.isBuffer(buf) && buf.length == self.size;
  };

}
util.inherits(FixedType, Type);

FixedType.prototype.getTypeName = function () { return 'fixed'; };

FixedType.prototype.random = function () {

  return new Buffer(randomString(this.size, 'aA#!'));

};


/**
 * Avro map.
 *
 */
function MapType(schema, opts) {

  if (!schema.values) {
    throw new AvscError('missing map values: %j', schema);
  }

  opts = getOpts(schema, opts);

  var self = this;
  var reader = Tap.prototype.readMap;
  var writer = Tap.prototype.writeMap;

  this.valuesType = parse(schema.values, opts);

  this._read = function () {
    return reader.call(this, self.valuesType._read);
  };

  this._write = function (obj) {
    writer.call(this, obj, self.valuesType._write);
  };

  this._check = function (obj) {
    if (typeof obj != 'object' || obj instanceof Array) {
      return false;
    }
    var keys = Object.keys(obj);
    var i, l;
    for (i = 0, l = keys.length; i < l; i++) {
      if (!self.valuesType._check(obj[keys[i]])) {
        return false;
      }
    }
    return true;
  };

}
util.inherits(MapType, Type);

MapType.prototype.getTypeName = function () { return 'map'; };

MapType.prototype.random = function () {

  var obj = {};
  var i, l;
  for (i = 0, l = Math.floor(randomDouble(0, 5)); i < l; i++) {
    obj[randomString(8)] = this.valuesType.random();
  }
  return obj;

};


/**
 * Avro array.
 *
 */
function ArrayType(schema, opts) {

  if (!schema.items) {
    throw new AvscError('missing array items: %j', schema);
  }

  opts = getOpts(schema, opts);

  var self = this;
  var reader = Tap.prototype.readArray;
  var writer = Tap.prototype.writeArray;

  this.itemsType = parse(schema.items, opts);

  this._read = function () {
    return reader.call(this, self.itemsType._read);
  };

  this._write = function (arr) {
    writer.call(this, arr, self.itemsType._write);
  };

  this._check = function (obj) {
    if (!(obj instanceof Array)) {
      return false;
    }
    return obj.every(function (elem) { return self.itemsType._check(elem); });
  };

}
util.inherits(ArrayType, Type);

ArrayType.prototype.getTypeName = function () { return 'array'; };

ArrayType.prototype.random = function () {

  var arr = [];
  var i, l;
  for (i = 0, l = Math.floor(randomDouble(0, 10)); i < l; i++) {
    arr.push(this.itemsType.random());
  }
  return arr;

};


/**
 * Avro record.
 *
 * A "specific record class" gets programmatically generated for each record.
 * This gives significant speedups over using generics objects (~3 times
 * faster) and provides a custom constructor.
 *
 */
function RecordType(schema, opts) {

  // jshint -W054

  if (!schema.name) {
    throw new AvscError('missing record name: %j', schema);
  }

  opts = getOpts(schema, opts);

  var self = this;
  this.name = getQualifiedName(schema, opts.namespace);
  this.doc = schema.doc;
  opts.registry[this.name] = this;
  var parts = this.name.split('.');
  var unqualifiedName = parts[parts.length - 1];

  if (!(schema.fields instanceof Array)) {
    throw new AvscError('invalid %j record fields: %j', this.name, schema);
  }

  this.fields = schema.fields.map(function (field) {
    if (typeof field != 'object' || typeof field.name != 'string') {
      throw new AvscError('invalid field in %j: %j', self.name, field);
    }
    var type = parse(field.type, opts);
    var value = field['default'];
    if (value !== undefined) {
      if (type instanceof FixedType || type.getTypeName() === 'bytes') {
        value = new Buffer(value, 'binary');
      }
      // Avro forces the default value to be of the first type in the
      // enum, so we must do a bit of extra logic here.
      if (
        type instanceof UnionType ?
          !type.types[0].isValid(value) :
          !type.isValid(value)
      ) {
        throw new AvscError(
          'invalid default for field %j in %j: %j',
          field.name, self.name, value
        );
      }
    }
    return {
      name: field.name,
      doc: field.doc,
      type: type,
      'default': value
    };
  });

  this._create = generateConstructor();
  this._create.decode = function (obj) { return self.decode(obj); };
  this._create.random = function () { return self.random(); };
  this._create.prototype = {
    $type: this,
    $encode: function (opts) { return self.encode(this, opts); },
    $isValid: function () { return self.isValid(this); }
  };
  // The names of these properties added to the prototype are prefixed with `$`
  // because it is an invalid property name in Avro but not in JavaScript.
  // (This way we are guaranteed not to be stepped over!)

  this._read = generateReader();

  this._write = generateWriter();

  this._check = generateChecker();

  function generateConstructor() {

    var args = [];
    var statements = [];
    var i, l, name;
    for (i = 0, l = self.fields.length; i < l; i++) {
      name = self.fields[i].name;
      args.push(name);
      statements.push('this.' + name + ' = ' + name + ';');
    }
    var body = 'return function ' + unqualifiedName + '(';
    body += args.join(',');
    body += ') {\n';
    body += statements.join('\n');
    body += '\n};';
    return new Function(body).call();

  }

  function generateReader() {

    var names = [];
    var values = [self._create];
    var i, l;
    for (i = 0, l = self.fields.length; i < l; i++) {
      names.push('r' + i);
      values.push(self.fields[i].type._read);
    }
    var body = 'return function read' + unqualifiedName + '() {\n';
    body += 'return new Class(';
    body += names.map(function (r) { return r + '.call(this)'; }).join(',');
    body += ');\n};';
    names.unshift('Class');
    return new Function(names.join(','), body).apply(undefined, values);

  }

  function generateWriter() {

    var names = [];
    var values = [];
    var body = 'return function write' + unqualifiedName + '(obj) {\n';
    var i, l, field;
    for (i = 0, l = self.fields.length; i < l; i++) {
      field = self.fields[i];
      names.push('w' + i);
      values.push(field.type._write);
      if (field['default'] !== undefined) {
        if (
          field.type.getTypeName() === 'bytes' ||
          field.type.getTypeName() === 'fixed'
        ) { // TODO
          throw new Error('bytes and fixed defaults are not supported yet');
        }
        body += 'var v' + i + ' = obj.' + field.name + '; ';
        body += 'if (v' + i + ' === undefined) { ';
        body += 'v' + i + ' = ' + JSON.stringify(field['default']) + ';';
        body += ' } w' + i + '.call(this, v' + i + ');\n';
      } else {
        body += 'w' + i + '.call(this, obj.' + field.name + ');\n';
      }
    }
    body += '}';
    return new Function(names.join(','), body).apply(undefined, values);

  }

  function generateChecker() {

    var names = [];
    var values = [];
    var body = 'return function check' + unqualifiedName + '(obj) {\n';
    body += 'if (typeof obj != \'object\') { return false; }\n';
    var i, l, field;
    for (i = 0, l = self.fields.length; i < l; i++) {
      field = self.fields[i];
      names.push('f' + i);
      values.push(field.type);
      if (field['default'] === undefined) {
        body += 'if (!f' + i + '._check(obj.' + field.name + ')) { ';
        body += 'return false; }\n';
      } else {
        body += 'var v' + i + ' = obj.' + field.name + '; ';
        body += 'if (v' + i + ' !== undefined && ';
        body += '!f' + i + '._check(v' + i + ')) { ';
        body += 'return false; }\n';
      }
    }
    body += 'return true;\n};';
    return new Function(names.join(','), body).apply(undefined, values);

  }

}
util.inherits(RecordType, Type);

RecordType.prototype.getTypeName = function () { return 'record'; };

RecordType.prototype.random = function () {

  // jshint -W058

  var fields = [undefined];
  var i, l;
  for (i = 0, l = this.fields.length; i < l; i++) {
    fields.push(this.fields[i].type.random());
  }
  return new (this._create.bind.apply(this._create, fields));

};

/**
 * Get class record instances are made of.
 *
 * It can be instantiated and used directly!
 *
 */
RecordType.prototype.getRecordConstructor = function () {

  return this._create;

};

// Helpers.

/**
 * Return a schema's qualified name.
 *
 * @param schema {Object} True schema (can't be a string).
 * @param namespace {String} Optional namespace.
 *
 */
function getQualifiedName(schema, namespace) {

  var name = schema.name;
  namespace = schema.namespace || namespace;
  if (name && !~name.indexOf('.') && namespace) {
    name = namespace + '.' + name;
  }
  return name;

}

/**
 * Create default parsing options.
 *
 * @param opts {Object} Base options.
 *
 */
function getOpts(schema, opts) {

  opts = opts || {};
  opts.registry = opts.registry || Type.createRegistry();
  opts.namespace = schema.namespace || opts.namespace;
  return opts;

}

/**
 * Uppercase the first letter of a string.
 *
 * @param s {String} The string.
 *
 */
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/**
 * Generate a random number.
 *
 * @param min {Number} Lower bound.
 * @param max {Number} Upper bound.
 *
 * The bounds must be small enough to not overflow.
 *
 */
function randomDouble(min, max) { return (max - min) * Math.random() + min; }

/**
 * Generate a random string.
 *
 * @param len {Number} String length.
 * @param flags {String} Type of characters to use.
 *
 */
function randomString(len, flags) {

  len |= 0;
  flags = flags || 'aA';

  var mask = '';
  if (flags.indexOf('a') > -1) {
    mask += 'abcdefghijklmnopqrstuvwxyz';
  }
  if (flags.indexOf('A') > -1) {
    mask += 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  }
  if (flags.indexOf('#') > -1) {
    mask += '0123456789';
  }
  if (flags.indexOf('!') > -1) {
    mask += '~`!@#$%^&*()_+-={}[]:";\'<>?,./|\\';
  }

  var result = '';
  for (var i = 0; i < len; i++) {
    result += mask[Math.round(Math.random() * (mask.length - 1))];
  }
  return result;

}

module.exports = {
  AvscError: AvscError,
  parse: parse,
  types : {
    ArrayType: ArrayType,
    EnumType: EnumType,
    FixedType: FixedType,
    MapType: MapType,
    PrimitiveType: PrimitiveType,
    RecordType: RecordType,
    Type: Type,
    UnionType: UnionType,
    UnwrappedUnionType: UnwrappedUnionType,
    WrappedUnionType: WrappedUnionType
  }
};