import zlib from 'zlib';
import fs from 'fs';
import fontkit from 'fontkit';
import { EventEmitter } from 'events';
import LineBreaker from 'linebreak';
import PNG from 'png-js';
import stream from 'stream';

/*
PDFAbstractReference - abstract class for PDF reference
*/

class PDFAbstractReference {
  toString() {
    throw new Error('Must be implemented by subclasses');
  }
}

/*
PDFObject - converts JavaScript types into their corresponding PDF types.
By Devon Govett
*/

const pad = (str, length) => (Array(length + 1).join('0') + str).slice(-length);

const escapableRe = /[\n\r\t\b\f\(\)\\]/g;
const escapable = {
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
  '\b': '\\b',
  '\f': '\\f',
  '\\': '\\\\',
  '(': '\\(',
  ')': '\\)'
};

// Convert little endian UTF-16 to big endian
const swapBytes = function swapBytes(buff) {
  const l = buff.length;
  if (l & 0x01) {
    throw new Error("Buffer length must be even");
  } else {
    for (let i = 0, end = l - 1; i < end; i += 2) {
      const a = buff[i];
      buff[i] = buff[i + 1];
      buff[i + 1] = a;
    }
  }

  return buff;
};

class PDFObject {
  static convert(object) {
    // String literals are converted to the PDF name type
    if (typeof object === 'string') {
      return `/${object}`;

      // String objects are converted to PDF strings (UTF-16)
    } else if (object instanceof String) {
      let string = object;
      // Detect if this is a unicode string
      let isUnicode = false;
      for (let i = 0, end = string.length; i < end; i++) {
        if (string.charCodeAt(i) > 0x7f) {
          isUnicode = true;
          break;
        }
      }

      // If so, encode it as big endian UTF-16
      if (isUnicode) {
        string = swapBytes(new Buffer(`\ufeff${string}`, 'utf16le')).toString('binary');
      }

      // Escape characters as required by the spec
      string = string.replace(escapableRe, c => escapable[c]);

      return `(${string})`;

      // Buffers are converted to PDF hex strings
    } else if (Buffer.isBuffer(object)) {
      return `<${object.toString('hex')}>`;
    } else if (object instanceof PDFAbstractReference) {
      return object.toString();
    } else if (object instanceof Date) {
      return `(D:${pad(object.getUTCFullYear(), 4)}` + pad(object.getUTCMonth() + 1, 2) + pad(object.getUTCDate(), 2) + pad(object.getUTCHours(), 2) + pad(object.getUTCMinutes(), 2) + pad(object.getUTCSeconds(), 2) + 'Z)';
    } else if (Array.isArray(object)) {
      const items = object.map(e => PDFObject.convert(e)).join(' ');
      return `[${items}]`;
    } else if ({}.toString.call(object) === '[object Object]') {
      const out = ['<<'];
      for (let key in object) {
        const val = object[key];
        out.push(`/${key} ${PDFObject.convert(val)}`);
      }

      out.push('>>');
      return out.join('\n');
    } else if (typeof object === 'number') {
      return PDFObject.number(object);
    } else {
      return `${object}`;
    }
  }

  static number(n) {
    if (n > -1e21 && n < 1e21) {
      return Math.round(n * 1e6) / 1e6;
    }

    throw new Error(`unsupported number: ${n}`);
  }
}

/*
PDFReference - represents a reference to another object in the PDF object heirarchy
By Devon Govett
*/

class PDFReference extends PDFAbstractReference {
  constructor(document, id, data) {
    super();
    this.document = document;
    this.id = id;
    if (data == null) {
      data = {};
    }
    this.data = data;
    this.gen = 0;
    this.compress = this.document.compress && !this.data.Filter;
    this.uncompressedLength = 0;
    this.buffer = [];
  }

  write(chunk) {
    if (!Buffer.isBuffer(chunk)) {
      chunk = new Buffer(chunk + '\n', 'binary');
    }

    this.uncompressedLength += chunk.length;
    if (this.data.Length == null) {
      this.data.Length = 0;
    }
    this.buffer.push(chunk);
    this.data.Length += chunk.length;
    if (this.compress) {
      return this.data.Filter = 'FlateDecode';
    }
  }

  end(chunk) {
    if (chunk) {
      this.write(chunk);
    }
    return this.finalize();
  }

  finalize() {
    return setTimeout(() => {
      this.offset = this.document._offset;

      this.document._write(`${this.id} ${this.gen} obj`);
      this.document._write(PDFObject.convert(this.data));

      if (this.buffer.length) {
        this.buffer = Buffer.concat(this.buffer);
        if (this.compress) {
          this.buffer = zlib.deflateSync(this.buffer);
          this.data.Length = this.buffer.length;
        }
        this.document._write('stream');
        this.document._write(this.buffer);

        this.buffer = []; // free up memory
        this.document._write('\nendstream');
      }

      this.document._write('endobj');
      return this.document._refEnd(this);
    }, 0);
  }
  toString() {
    return `${this.id} ${this.gen} R`;
  }
}

/*
PDFPage - represents a single page in the PDF document
By Devon Govett
*/

const DEFAULT_MARGINS = {
  top: 72,
  left: 72,
  bottom: 72,
  right: 72
};

const SIZES = {
  '4A0': [4767.87, 6740.79],
  '2A0': [3370.39, 4767.87],
  A0: [2383.94, 3370.39],
  A1: [1683.78, 2383.94],
  A2: [1190.55, 1683.78],
  A3: [841.89, 1190.55],
  A4: [595.28, 841.89],
  A5: [419.53, 595.28],
  A6: [297.64, 419.53],
  A7: [209.76, 297.64],
  A8: [147.40, 209.76],
  A9: [104.88, 147.40],
  A10: [73.70, 104.88],
  B0: [2834.65, 4008.19],
  B1: [2004.09, 2834.65],
  B2: [1417.32, 2004.09],
  B3: [1000.63, 1417.32],
  B4: [708.66, 1000.63],
  B5: [498.90, 708.66],
  B6: [354.33, 498.90],
  B7: [249.45, 354.33],
  B8: [175.75, 249.45],
  B9: [124.72, 175.75],
  B10: [87.87, 124.72],
  C0: [2599.37, 3676.54],
  C1: [1836.85, 2599.37],
  C2: [1298.27, 1836.85],
  C3: [918.43, 1298.27],
  C4: [649.13, 918.43],
  C5: [459.21, 649.13],
  C6: [323.15, 459.21],
  C7: [229.61, 323.15],
  C8: [161.57, 229.61],
  C9: [113.39, 161.57],
  C10: [79.37, 113.39],
  RA0: [2437.80, 3458.27],
  RA1: [1729.13, 2437.80],
  RA2: [1218.90, 1729.13],
  RA3: [864.57, 1218.90],
  RA4: [609.45, 864.57],
  SRA0: [2551.18, 3628.35],
  SRA1: [1814.17, 2551.18],
  SRA2: [1275.59, 1814.17],
  SRA3: [907.09, 1275.59],
  SRA4: [637.80, 907.09],
  EXECUTIVE: [521.86, 756.00],
  FOLIO: [612.00, 936.00],
  LEGAL: [612.00, 1008.00],
  LETTER: [612.00, 792.00],
  TABLOID: [792.00, 1224.00]
};

class PDFPage {
  constructor(document, options) {
    this.document = document;
    if (options == null) {
      options = {};
    }
    this.size = options.size || 'letter';
    this.layout = options.layout || 'portrait';

    // process margins
    if (typeof options.margin === 'number') {
      this.margins = {
        top: options.margin,
        left: options.margin,
        bottom: options.margin,
        right: options.margin
      };

      // default to 1 inch margins
    } else {
      this.margins = options.margins || DEFAULT_MARGINS;
    }

    // calculate page dimensions
    const dimensions = Array.isArray(this.size) ? this.size : SIZES[this.size.toUpperCase()];
    this.width = dimensions[this.layout === 'portrait' ? 0 : 1];
    this.height = dimensions[this.layout === 'portrait' ? 1 : 0];

    this.content = this.document.ref();

    // Initialize the Font, XObject, and ExtGState dictionaries
    this.resources = this.document.ref({
      ProcSet: ['PDF', 'Text', 'ImageB', 'ImageC', 'ImageI'] });

    // Lazily create these dictionaries
    Object.defineProperties(this, {
      fonts: {
        get: () => this.resources.data.Font != null ? this.resources.data.Font : this.resources.data.Font = {}
      },
      xobjects: {
        get: () => this.resources.data.XObject != null ? this.resources.data.XObject : this.resources.data.XObject = {}
      },
      ext_gstates: {
        get: () => this.resources.data.ExtGState != null ? this.resources.data.ExtGState : this.resources.data.ExtGState = {}
      },
      patterns: {
        get: () => this.resources.data.Pattern != null ? this.resources.data.Pattern : this.resources.data.Pattern = {}
      },
      annotations: {
        get: () => this.dictionary.data.Annots != null ? this.dictionary.data.Annots : this.dictionary.data.Annots = []
      }
    });

    // The page dictionary
    this.dictionary = this.document.ref({
      Type: 'Page',
      Parent: this.document._root.data.Pages,
      MediaBox: [0, 0, this.width, this.height],
      Contents: this.content,
      Resources: this.resources
    });
  }

  maxY() {
    return this.height - this.margins.bottom;
  }

  write(chunk) {
    return this.content.write(chunk);
  }

  end() {
    this.dictionary.end();
    this.resources.end();
    return this.content.end();
  }
}

var slicedToArray = function () {
  function sliceIterator(arr, i) {
    var _arr = [];
    var _n = true;
    var _d = false;
    var _e = undefined;

    try {
      for (var _i = arr[Symbol.iterator](), _s; !(_n = (_s = _i.next()).done); _n = true) {
        _arr.push(_s.value);

        if (i && _arr.length === i) break;
      }
    } catch (err) {
      _d = true;
      _e = err;
    } finally {
      try {
        if (!_n && _i["return"]) _i["return"]();
      } finally {
        if (_d) throw _e;
      }
    }

    return _arr;
  }

  return function (arr, i) {
    if (Array.isArray(arr)) {
      return arr;
    } else if (Symbol.iterator in Object(arr)) {
      return sliceIterator(arr, i);
    } else {
      throw new TypeError("Invalid attempt to destructure non-iterable instance");
    }
  };
}();

const number = PDFObject.number;


class PDFGradient {
  constructor(doc) {
    this.doc = doc;
    this.stops = [];
    this.embedded = false;
    this.transform = [1, 0, 0, 1, 0, 0];
  }

  stop(pos, color, opacity) {
    if (opacity == null) {
      opacity = 1;
    }
    color = this.doc._normalizeColor(color);

    if (this.stops.length === 0) {
      if (color.length === 3) {
        this._colorSpace = 'DeviceRGB';
      } else if (color.length === 4) {
        this._colorSpace = 'DeviceCMYK';
      } else if (color.length === 1) {
        this._colorSpace = 'DeviceGray';
      } else {
        throw new Error('Unknown color space');
      }
    } else if (this._colorSpace === 'DeviceRGB' && color.length !== 3 || this._colorSpace === 'DeviceCMYK' && color.length !== 4 || this._colorSpace === 'DeviceGray' && color.length !== 1) {
      throw new Error('All gradient stops must use the same color space');
    }

    opacity = Math.max(0, Math.min(1, opacity));
    this.stops.push([pos, color, opacity]);
    return this;
  }

  setTransform(m11, m12, m21, m22, dx, dy) {
    this.transform = [m11, m12, m21, m22, dx, dy];
    return this;
  }

  embed(m) {
    let asc, i;
    let end, fn;
    if (this.stops.length === 0) {
      return;
    }
    this.embedded = true;
    this.matrix = m;

    // if the last stop comes before 100%, add a copy at 100%
    const last = this.stops[this.stops.length - 1];
    if (last[0] < 1) {
      this.stops.push([1, last[1], last[2]]);
    }

    const bounds = [];
    const encode = [];
    const stops = [];

    for (i = 0, end = this.stops.length - 1, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      encode.push(0, 1);
      if (i + 2 !== this.stops.length) {
        bounds.push(this.stops[i + 1][0]);
      }

      fn = this.doc.ref({
        FunctionType: 2,
        Domain: [0, 1],
        C0: this.stops[i + 0][1],
        C1: this.stops[i + 1][1],
        N: 1
      });

      stops.push(fn);
      fn.end();
    }

    // if there are only two stops, we don't need a stitching function
    if (stops.length === 1) {
      fn = stops[0];
    } else {
      fn = this.doc.ref({
        FunctionType: 3, // stitching function
        Domain: [0, 1],
        Functions: stops,
        Bounds: bounds,
        Encode: encode
      });

      fn.end();
    }

    this.id = `Sh${++this.doc._gradCount}`;

    const shader = this.shader(fn);
    shader.end();

    const pattern = this.doc.ref({
      Type: 'Pattern',
      PatternType: 2,
      Shading: shader,
      Matrix: this.matrix.map(v => number(v))
    });

    pattern.end();

    if (this.stops.some(stop => stop[2] < 1)) {
      let grad = this.opacityGradient();
      grad._colorSpace = 'DeviceGray';

      for (let stop of this.stops) {
        grad.stop(stop[0], [stop[2]]);
      }

      grad = grad.embed(this.matrix);

      const pageBBox = [0, 0, this.doc.page.width, this.doc.page.height];

      const form = this.doc.ref({
        Type: 'XObject',
        Subtype: 'Form',
        FormType: 1,
        BBox: pageBBox,
        Group: {
          Type: 'Group',
          S: 'Transparency',
          CS: 'DeviceGray'
        },
        Resources: {
          ProcSet: ['PDF', 'Text', 'ImageB', 'ImageC', 'ImageI'],
          Pattern: {
            Sh1: grad
          }
        }
      });

      form.write("/Pattern cs /Sh1 scn");
      form.end(`${pageBBox.join(" ")} re f`);

      const gstate = this.doc.ref({
        Type: 'ExtGState',
        SMask: {
          Type: 'Mask',
          S: 'Luminosity',
          G: form
        }
      });

      gstate.end();

      const opacityPattern = this.doc.ref({
        Type: 'Pattern',
        PatternType: 1,
        PaintType: 1,
        TilingType: 2,
        BBox: pageBBox,
        XStep: pageBBox[2],
        YStep: pageBBox[3],
        Resources: {
          ProcSet: ['PDF', 'Text', 'ImageB', 'ImageC', 'ImageI'],
          Pattern: {
            Sh1: pattern
          },
          ExtGState: {
            Gs1: gstate
          }
        }
      });

      opacityPattern.write("/Gs1 gs /Pattern cs /Sh1 scn");
      opacityPattern.end(`${pageBBox.join(" ")} re f`);

      this.doc.page.patterns[this.id] = opacityPattern;
    } else {
      this.doc.page.patterns[this.id] = pattern;
    }

    return pattern;
  }

  apply(op) {
    // apply gradient transform to existing document ctm
    var _doc$_ctm = slicedToArray(this.doc._ctm, 6);

    const m0 = _doc$_ctm[0],
          m1 = _doc$_ctm[1],
          m2 = _doc$_ctm[2],
          m3 = _doc$_ctm[3],
          m4 = _doc$_ctm[4],
          m5 = _doc$_ctm[5];

    var _transform = slicedToArray(this.transform, 6);

    const m11 = _transform[0],
          m12 = _transform[1],
          m21 = _transform[2],
          m22 = _transform[3],
          dx = _transform[4],
          dy = _transform[5];

    const m = [m0 * m11 + m2 * m12, m1 * m11 + m3 * m12, m0 * m21 + m2 * m22, m1 * m21 + m3 * m22, m0 * dx + m2 * dy + m4, m1 * dx + m3 * dy + m5];

    if (!this.embedded || m.join(" ") !== this.matrix.join(" ")) {
      this.embed(m);
    }
    return this.doc.addContent(`/${this.id} ${op}`);
  }
}

class PDFLinearGradient extends PDFGradient {
  constructor(doc, x1, y1, x2, y2) {
    super(doc);
    this.x1 = x1;
    this.y1 = y1;
    this.x2 = x2;
    this.y2 = y2;
  }

  shader(fn) {
    return this.doc.ref({
      ShadingType: 2,
      ColorSpace: this._colorSpace,
      Coords: [this.x1, this.y1, this.x2, this.y2],
      Function: fn,
      Extend: [true, true] });
  }

  opacityGradient() {
    return new PDFLinearGradient(this.doc, this.x1, this.y1, this.x2, this.y2);
  }
}

class PDFRadialGradient extends PDFGradient {
  constructor(doc, x1, y1, r1, x2, y2, r2) {
    super(doc);
    this.doc = doc;
    this.x1 = x1;
    this.y1 = y1;
    this.r1 = r1;
    this.x2 = x2;
    this.y2 = y2;
    this.r2 = r2;
  }

  shader(fn) {
    return this.doc.ref({
      ShadingType: 3,
      ColorSpace: this._colorSpace,
      Coords: [this.x1, this.y1, this.r1, this.x2, this.y2, this.r2],
      Function: fn,
      Extend: [true, true] });
  }

  opacityGradient() {
    return new PDFRadialGradient(this.doc, this.x1, this.y1, this.r1, this.x2, this.y2, this.r2);
  }
}

var Gradient = { PDFGradient, PDFLinearGradient, PDFRadialGradient };

const PDFGradient$1 = Gradient.PDFGradient,
      PDFLinearGradient$1 = Gradient.PDFLinearGradient,
      PDFRadialGradient$1 = Gradient.PDFRadialGradient;


var ColorMixin = {
  initColor() {
    // The opacity dictionaries
    this._opacityRegistry = {};
    this._opacityCount = 0;
    return this._gradCount = 0;
  },

  _normalizeColor(color) {
    if (color instanceof PDFGradient$1) {
      return color;
    }

    if (typeof color === 'string') {
      if (color.charAt(0) === '#') {
        if (color.length === 4) {
          color = color.replace(/#([0-9A-F])([0-9A-F])([0-9A-F])/i, "#$1$1$2$2$3$3");
        }
        const hex = parseInt(color.slice(1), 16);
        color = [hex >> 16, hex >> 8 & 0xff, hex & 0xff];
      } else if (namedColors[color]) {
        color = namedColors[color];
      }
    }

    if (Array.isArray(color)) {
      // RGB
      if (color.length === 3) {
        color = color.map(part => part / 255);
        // CMYK
      } else if (color.length === 4) {
        color = color.map(part => part / 100);
      }
      return color;
    }

    return null;
  },

  _setColor(color, stroke) {
    color = this._normalizeColor(color);
    if (!color) {
      return false;
    }

    const op = stroke ? 'SCN' : 'scn';

    if (color instanceof PDFGradient$1) {
      this._setColorSpace('Pattern', stroke);
      color.apply(op);
    } else {
      const space = color.length === 4 ? 'DeviceCMYK' : 'DeviceRGB';
      this._setColorSpace(space, stroke);

      color = color.join(' ');
      this.addContent(`${color} ${op}`);
    }

    return true;
  },

  _setColorSpace(space, stroke) {
    const op = stroke ? 'CS' : 'cs';
    return this.addContent(`/${space} ${op}`);
  },

  fillColor(color, opacity) {
    const set$$1 = this._setColor(color, false);
    if (set$$1) {
      this.fillOpacity(opacity);
    }

    // save this for text wrapper, which needs to reset
    // the fill color on new pages
    this._fillColor = [color, opacity];
    return this;
  },

  strokeColor(color, opacity) {
    const set$$1 = this._setColor(color, true);
    if (set$$1) {
      this.strokeOpacity(opacity);
    }
    return this;
  },

  opacity(opacity) {
    this._doOpacity(opacity, opacity);
    return this;
  },

  fillOpacity(opacity) {
    this._doOpacity(opacity, null);
    return this;
  },

  strokeOpacity(opacity) {
    this._doOpacity(null, opacity);
    return this;
  },

  _doOpacity(fillOpacity, strokeOpacity) {
    let dictionary, name;
    if (fillOpacity == null && strokeOpacity == null) {
      return;
    }

    if (fillOpacity != null) {
      fillOpacity = Math.max(0, Math.min(1, fillOpacity));
    }
    if (strokeOpacity != null) {
      strokeOpacity = Math.max(0, Math.min(1, strokeOpacity));
    }
    const key = `${fillOpacity}_${strokeOpacity}`;

    if (this._opacityRegistry[key]) {
      var _opacityRegistry$key = slicedToArray(this._opacityRegistry[key], 2);

      dictionary = _opacityRegistry$key[0];
      name = _opacityRegistry$key[1];
    } else {
      dictionary = { Type: 'ExtGState' };

      if (fillOpacity != null) {
        dictionary.ca = fillOpacity;
      }
      if (strokeOpacity != null) {
        dictionary.CA = strokeOpacity;
      }

      dictionary = this.ref(dictionary);
      dictionary.end();
      const id = ++this._opacityCount;
      name = `Gs${id}`;
      this._opacityRegistry[key] = [dictionary, name];
    }

    this.page.ext_gstates[name] = dictionary;
    return this.addContent(`/${name} gs`);
  },

  linearGradient(x1, y1, x2, y2) {
    return new PDFLinearGradient$1(this, x1, y1, x2, y2);
  },

  radialGradient(x1, y1, r1, x2, y2, r2) {
    return new PDFRadialGradient$1(this, x1, y1, r1, x2, y2, r2);
  }
};

var namedColors = {
  aliceblue: [240, 248, 255],
  antiquewhite: [250, 235, 215],
  aqua: [0, 255, 255],
  aquamarine: [127, 255, 212],
  azure: [240, 255, 255],
  beige: [245, 245, 220],
  bisque: [255, 228, 196],
  black: [0, 0, 0],
  blanchedalmond: [255, 235, 205],
  blue: [0, 0, 255],
  blueviolet: [138, 43, 226],
  brown: [165, 42, 42],
  burlywood: [222, 184, 135],
  cadetblue: [95, 158, 160],
  chartreuse: [127, 255, 0],
  chocolate: [210, 105, 30],
  coral: [255, 127, 80],
  cornflowerblue: [100, 149, 237],
  cornsilk: [255, 248, 220],
  crimson: [220, 20, 60],
  cyan: [0, 255, 255],
  darkblue: [0, 0, 139],
  darkcyan: [0, 139, 139],
  darkgoldenrod: [184, 134, 11],
  darkgray: [169, 169, 169],
  darkgreen: [0, 100, 0],
  darkgrey: [169, 169, 169],
  darkkhaki: [189, 183, 107],
  darkmagenta: [139, 0, 139],
  darkolivegreen: [85, 107, 47],
  darkorange: [255, 140, 0],
  darkorchid: [153, 50, 204],
  darkred: [139, 0, 0],
  darksalmon: [233, 150, 122],
  darkseagreen: [143, 188, 143],
  darkslateblue: [72, 61, 139],
  darkslategray: [47, 79, 79],
  darkslategrey: [47, 79, 79],
  darkturquoise: [0, 206, 209],
  darkviolet: [148, 0, 211],
  deeppink: [255, 20, 147],
  deepskyblue: [0, 191, 255],
  dimgray: [105, 105, 105],
  dimgrey: [105, 105, 105],
  dodgerblue: [30, 144, 255],
  firebrick: [178, 34, 34],
  floralwhite: [255, 250, 240],
  forestgreen: [34, 139, 34],
  fuchsia: [255, 0, 255],
  gainsboro: [220, 220, 220],
  ghostwhite: [248, 248, 255],
  gold: [255, 215, 0],
  goldenrod: [218, 165, 32],
  gray: [128, 128, 128],
  grey: [128, 128, 128],
  green: [0, 128, 0],
  greenyellow: [173, 255, 47],
  honeydew: [240, 255, 240],
  hotpink: [255, 105, 180],
  indianred: [205, 92, 92],
  indigo: [75, 0, 130],
  ivory: [255, 255, 240],
  khaki: [240, 230, 140],
  lavender: [230, 230, 250],
  lavenderblush: [255, 240, 245],
  lawngreen: [124, 252, 0],
  lemonchiffon: [255, 250, 205],
  lightblue: [173, 216, 230],
  lightcoral: [240, 128, 128],
  lightcyan: [224, 255, 255],
  lightgoldenrodyellow: [250, 250, 210],
  lightgray: [211, 211, 211],
  lightgreen: [144, 238, 144],
  lightgrey: [211, 211, 211],
  lightpink: [255, 182, 193],
  lightsalmon: [255, 160, 122],
  lightseagreen: [32, 178, 170],
  lightskyblue: [135, 206, 250],
  lightslategray: [119, 136, 153],
  lightslategrey: [119, 136, 153],
  lightsteelblue: [176, 196, 222],
  lightyellow: [255, 255, 224],
  lime: [0, 255, 0],
  limegreen: [50, 205, 50],
  linen: [250, 240, 230],
  magenta: [255, 0, 255],
  maroon: [128, 0, 0],
  mediumaquamarine: [102, 205, 170],
  mediumblue: [0, 0, 205],
  mediumorchid: [186, 85, 211],
  mediumpurple: [147, 112, 219],
  mediumseagreen: [60, 179, 113],
  mediumslateblue: [123, 104, 238],
  mediumspringgreen: [0, 250, 154],
  mediumturquoise: [72, 209, 204],
  mediumvioletred: [199, 21, 133],
  midnightblue: [25, 25, 112],
  mintcream: [245, 255, 250],
  mistyrose: [255, 228, 225],
  moccasin: [255, 228, 181],
  navajowhite: [255, 222, 173],
  navy: [0, 0, 128],
  oldlace: [253, 245, 230],
  olive: [128, 128, 0],
  olivedrab: [107, 142, 35],
  orange: [255, 165, 0],
  orangered: [255, 69, 0],
  orchid: [218, 112, 214],
  palegoldenrod: [238, 232, 170],
  palegreen: [152, 251, 152],
  paleturquoise: [175, 238, 238],
  palevioletred: [219, 112, 147],
  papayawhip: [255, 239, 213],
  peachpuff: [255, 218, 185],
  peru: [205, 133, 63],
  pink: [255, 192, 203],
  plum: [221, 160, 221],
  powderblue: [176, 224, 230],
  purple: [128, 0, 128],
  red: [255, 0, 0],
  rosybrown: [188, 143, 143],
  royalblue: [65, 105, 225],
  saddlebrown: [139, 69, 19],
  salmon: [250, 128, 114],
  sandybrown: [244, 164, 96],
  seagreen: [46, 139, 87],
  seashell: [255, 245, 238],
  sienna: [160, 82, 45],
  silver: [192, 192, 192],
  skyblue: [135, 206, 235],
  slateblue: [106, 90, 205],
  slategray: [112, 128, 144],
  slategrey: [112, 128, 144],
  snow: [255, 250, 250],
  springgreen: [0, 255, 127],
  steelblue: [70, 130, 180],
  tan: [210, 180, 140],
  teal: [0, 128, 128],
  thistle: [216, 191, 216],
  tomato: [255, 99, 71],
  turquoise: [64, 224, 208],
  violet: [238, 130, 238],
  wheat: [245, 222, 179],
  white: [255, 255, 255],
  whitesmoke: [245, 245, 245],
  yellow: [255, 255, 0],
  yellowgreen: [154, 205, 50]
};

let cx, cy, px, py, sx, sy;

cx = cy = px = py = sx = sy = 0;

const parameters = {
  A: 7,
  a: 7,
  C: 6,
  c: 6,
  H: 1,
  h: 1,
  L: 2,
  l: 2,
  M: 2,
  m: 2,
  Q: 4,
  q: 4,
  S: 4,
  s: 4,
  T: 2,
  t: 2,
  V: 1,
  v: 1,
  Z: 0,
  z: 0
};

const parse = function parse(path) {
  let cmd;
  const ret = [];
  let args = [];
  let curArg = "";
  let foundDecimal = false;
  let params = 0;

  for (let c of path) {
    if (parameters[c] != null) {
      params = parameters[c];
      if (cmd) {
        // save existing command
        if (curArg.length > 0) {
          args[args.length] = +curArg;
        }
        ret[ret.length] = { cmd, args };

        args = [];
        curArg = "";
        foundDecimal = false;
      }

      cmd = c;
    } else if ([" ", ","].includes(c) || c === "-" && curArg.length > 0 && curArg[curArg.length - 1] !== 'e' || c === "." && foundDecimal) {
      if (curArg.length === 0) {
        continue;
      }

      if (args.length === params) {
        // handle reused commands
        ret[ret.length] = { cmd, args };
        args = [+curArg];

        // handle assumed commands
        if (cmd === "M") {
          cmd = "L";
        }
        if (cmd === "m") {
          cmd = "l";
        }
      } else {
        args[args.length] = +curArg;
      }

      foundDecimal = c === ".";

      // fix for negative numbers or repeated decimals with no delimeter between commands
      curArg = ['-', '.'].includes(c) ? c : '';
    } else {
      curArg += c;
      if (c === '.') {
        foundDecimal = true;
      }
    }
  }

  // add the last command
  if (curArg.length > 0) {
    if (args.length === params) {
      // handle reused commands
      ret[ret.length] = { cmd, args };
      args = [+curArg];

      // handle assumed commands
      if (cmd === "M") {
        cmd = "L";
      }
      if (cmd === "m") {
        cmd = "l";
      }
    } else {
      args[args.length] = +curArg;
    }
  }

  ret[ret.length] = { cmd, args };

  return ret;
};

const apply = function apply(commands, doc) {
  // current point, control point, and subpath starting point
  cx = cy = px = py = sx = sy = 0;

  // run the commands
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    if (typeof runners[c.cmd] === 'function') {
      runners[c.cmd](doc, c.args);
    }
  }
};

const runners = {
  M(doc, a) {
    cx = a[0];
    cy = a[1];
    px = py = null;
    sx = cx;
    sy = cy;
    return doc.moveTo(cx, cy);
  },

  m(doc, a) {
    cx += a[0];
    cy += a[1];
    px = py = null;
    sx = cx;
    sy = cy;
    return doc.moveTo(cx, cy);
  },

  C(doc, a) {
    cx = a[4];
    cy = a[5];
    px = a[2];
    py = a[3];
    return doc.bezierCurveTo(...(a || []));
  },

  c(doc, a) {
    doc.bezierCurveTo(a[0] + cx, a[1] + cy, a[2] + cx, a[3] + cy, a[4] + cx, a[5] + cy);
    px = cx + a[2];
    py = cy + a[3];
    cx += a[4];
    return cy += a[5];
  },

  S(doc, a) {
    if (px === null) {
      px = cx;
      py = cy;
    }

    doc.bezierCurveTo(cx - (px - cx), cy - (py - cy), a[0], a[1], a[2], a[3]);
    px = a[0];
    py = a[1];
    cx = a[2];
    return cy = a[3];
  },

  s(doc, a) {
    if (px === null) {
      px = cx;
      py = cy;
    }

    doc.bezierCurveTo(cx - (px - cx), cy - (py - cy), cx + a[0], cy + a[1], cx + a[2], cy + a[3]);
    px = cx + a[0];
    py = cy + a[1];
    cx += a[2];
    return cy += a[3];
  },

  Q(doc, a) {
    px = a[0];
    py = a[1];
    cx = a[2];
    cy = a[3];
    return doc.quadraticCurveTo(a[0], a[1], cx, cy);
  },

  q(doc, a) {
    doc.quadraticCurveTo(a[0] + cx, a[1] + cy, a[2] + cx, a[3] + cy);
    px = cx + a[0];
    py = cy + a[1];
    cx += a[2];
    return cy += a[3];
  },

  T(doc, a) {
    if (px === null) {
      px = cx;
      py = cy;
    } else {
      px = cx - (px - cx);
      py = cy - (py - cy);
    }

    doc.quadraticCurveTo(px, py, a[0], a[1]);
    px = cx - (px - cx);
    py = cy - (py - cy);
    cx = a[0];
    return cy = a[1];
  },

  t(doc, a) {
    if (px === null) {
      px = cx;
      py = cy;
    } else {
      px = cx - (px - cx);
      py = cy - (py - cy);
    }

    doc.quadraticCurveTo(px, py, cx + a[0], cy + a[1]);
    cx += a[0];
    return cy += a[1];
  },

  A(doc, a) {
    solveArc(doc, cx, cy, a);
    cx = a[5];
    return cy = a[6];
  },

  a(doc, a) {
    a[5] += cx;
    a[6] += cy;
    solveArc(doc, cx, cy, a);
    cx = a[5];
    return cy = a[6];
  },

  L(doc, a) {
    cx = a[0];
    cy = a[1];
    px = py = null;
    return doc.lineTo(cx, cy);
  },

  l(doc, a) {
    cx += a[0];
    cy += a[1];
    px = py = null;
    return doc.lineTo(cx, cy);
  },

  H(doc, a) {
    cx = a[0];
    px = py = null;
    return doc.lineTo(cx, cy);
  },

  h(doc, a) {
    cx += a[0];
    px = py = null;
    return doc.lineTo(cx, cy);
  },

  V(doc, a) {
    cy = a[0];
    px = py = null;
    return doc.lineTo(cx, cy);
  },

  v(doc, a) {
    cy += a[0];
    px = py = null;
    return doc.lineTo(cx, cy);
  },

  Z(doc) {
    doc.closePath();
    cx = sx;
    return cy = sy;
  },

  z(doc) {
    doc.closePath();
    cx = sx;
    return cy = sy;
  }
};

const solveArc = function solveArc(doc, x, y, coords) {
  var _coords = slicedToArray(coords, 7);

  const rx = _coords[0],
        ry = _coords[1],
        rot = _coords[2],
        large = _coords[3],
        sweep = _coords[4],
        ex = _coords[5],
        ey = _coords[6];

  const segs = arcToSegments(ex, ey, rx, ry, large, sweep, rot, x, y);

  for (let seg of segs) {
    const bez = segmentToBezier(...(seg || []));
    doc.bezierCurveTo(...(bez || []));
  }
};

// from Inkscape svgtopdf, thanks!
const arcToSegments = function arcToSegments(x, y, rx, ry, large, sweep, rotateX, ox, oy) {
  const th = rotateX * (Math.PI / 180);
  const sin_th = Math.sin(th);
  const cos_th = Math.cos(th);
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  px = cos_th * (ox - x) * 0.5 + sin_th * (oy - y) * 0.5;
  py = cos_th * (oy - y) * 0.5 - sin_th * (ox - x) * 0.5;
  let pl = px * px / (rx * rx) + py * py / (ry * ry);
  if (pl > 1) {
    pl = Math.sqrt(pl);
    rx *= pl;
    ry *= pl;
  }

  const a00 = cos_th / rx;
  const a01 = sin_th / rx;
  const a10 = -sin_th / ry;
  const a11 = cos_th / ry;
  const x0 = a00 * ox + a01 * oy;
  const y0 = a10 * ox + a11 * oy;
  const x1 = a00 * x + a01 * y;
  const y1 = a10 * x + a11 * y;

  const d = (x1 - x0) * (x1 - x0) + (y1 - y0) * (y1 - y0);
  let sfactor_sq = 1 / d - 0.25;
  if (sfactor_sq < 0) {
    sfactor_sq = 0;
  }
  let sfactor = Math.sqrt(sfactor_sq);
  if (sweep === large) {
    sfactor = -sfactor;
  }

  const xc = 0.5 * (x0 + x1) - sfactor * (y1 - y0);
  const yc = 0.5 * (y0 + y1) + sfactor * (x1 - x0);

  const th0 = Math.atan2(y0 - yc, x0 - xc);
  const th1 = Math.atan2(y1 - yc, x1 - xc);

  let th_arc = th1 - th0;
  if (th_arc < 0 && sweep === 1) {
    th_arc += 2 * Math.PI;
  } else if (th_arc > 0 && sweep === 0) {
    th_arc -= 2 * Math.PI;
  }

  const segments = Math.ceil(Math.abs(th_arc / (Math.PI * 0.5 + 0.001)));
  const result = [];

  for (let i = 0, end = segments, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
    const th2 = th0 + i * th_arc / segments;
    const th3 = th0 + (i + 1) * th_arc / segments;
    result[i] = [xc, yc, th2, th3, rx, ry, sin_th, cos_th];
  }

  return result;
};

const segmentToBezier = function segmentToBezier(cx, cy, th0, th1, rx, ry, sin_th, cos_th) {
  const a00 = cos_th * rx;
  const a01 = -sin_th * ry;
  const a10 = sin_th * rx;
  const a11 = cos_th * ry;

  const th_half = 0.5 * (th1 - th0);
  const t = 8 / 3 * Math.sin(th_half * 0.5) * Math.sin(th_half * 0.5) / Math.sin(th_half);
  const x1 = cx + Math.cos(th0) - t * Math.sin(th0);
  const y1 = cy + Math.sin(th0) + t * Math.cos(th0);
  const x3 = cx + Math.cos(th1);
  const y3 = cy + Math.sin(th1);
  const x2 = x3 + t * Math.sin(th1);
  const y2 = y3 - t * Math.cos(th1);

  return [a00 * x1 + a01 * y1, a10 * x1 + a11 * y1, a00 * x2 + a01 * y2, a10 * x2 + a11 * y2, a00 * x3 + a01 * y3, a10 * x3 + a11 * y3];
};

class SVGPath {
  static apply(doc, path) {
    const commands = parse(path);
    apply(commands, doc);
  }
}

const number$1 = PDFObject.number;

// This constant is used to approximate a symmetrical arc using a cubic
// Bezier curve.

const KAPPA = 4.0 * ((Math.sqrt(2) - 1.0) / 3.0);
var VectorMixin = {
  initVector() {
    this._ctm = [1, 0, 0, 1, 0, 0]; // current transformation matrix
    return this._ctmStack = [];
  },

  save() {
    this._ctmStack.push(this._ctm.slice());
    // TODO: save/restore colorspace and styles so not setting it unnessesarily all the time?
    return this.addContent('q');
  },

  restore() {
    this._ctm = this._ctmStack.pop() || [1, 0, 0, 1, 0, 0];
    return this.addContent('Q');
  },

  closePath() {
    return this.addContent('h');
  },

  lineWidth(w) {
    return this.addContent(`${number$1(w)} w`);
  },

  _CAP_STYLES: {
    BUTT: 0,
    ROUND: 1,
    SQUARE: 2
  },

  lineCap(c) {
    if (typeof c === 'string') {
      c = this._CAP_STYLES[c.toUpperCase()];
    }
    return this.addContent(`${c} J`);
  },

  _JOIN_STYLES: {
    MITER: 0,
    ROUND: 1,
    BEVEL: 2
  },

  lineJoin(j) {
    if (typeof j === 'string') {
      j = this._JOIN_STYLES[j.toUpperCase()];
    }
    return this.addContent(`${j} j`);
  },

  miterLimit(m) {
    return this.addContent(`${number$1(m)} M`);
  },

  dash(length, options) {
    let phase;
    if (options == null) {
      options = {};
    }
    if (length == null) {
      return this;
    }
    if (Array.isArray(length)) {
      length = length.map(v => number$1(v)).join(' ');
      phase = options.phase || 0;
      return this.addContent(`[${length}] ${number$1(phase)} d`);
    } else {
      const space = options.space != null ? options.space : length;
      phase = options.phase || 0;
      return this.addContent(`[${number$1(length)} ${number$1(space)}] ${number$1(phase)} d`);
    }
  },

  undash() {
    return this.addContent("[] 0 d");
  },

  moveTo(x, y) {
    return this.addContent(`${number$1(x)} ${number$1(y)} m`);
  },

  lineTo(x, y) {
    return this.addContent(`${number$1(x)} ${number$1(y)} l`);
  },

  bezierCurveTo(cp1x, cp1y, cp2x, cp2y, x, y) {
    return this.addContent(`${number$1(cp1x)} ${number$1(cp1y)} ${number$1(cp2x)} ${number$1(cp2y)} ${number$1(x)} ${number$1(y)} c`);
  },

  quadraticCurveTo(cpx, cpy, x, y) {
    return this.addContent(`${number$1(cpx)} ${number$1(cpy)} ${number$1(x)} ${number$1(y)} v`);
  },

  rect(x, y, w, h) {
    return this.addContent(`${number$1(x)} ${number$1(y)} ${number$1(w)} ${number$1(h)} re`);
  },

  roundedRect(x, y, w, h, r) {
    if (r == null) {
      r = 0;
    }
    r = Math.min(r, 0.5 * w, 0.5 * h);

    // amount to inset control points from corners (see `ellipse`)
    const c = r * (1.0 - KAPPA);

    this.moveTo(x + r, y);
    this.lineTo(x + w - r, y);
    this.bezierCurveTo(x + w - c, y, x + w, y + c, x + w, y + r);
    this.lineTo(x + w, y + h - r);
    this.bezierCurveTo(x + w, y + h - c, x + w - c, y + h, x + w - r, y + h);
    this.lineTo(x + r, y + h);
    this.bezierCurveTo(x + c, y + h, x, y + h - c, x, y + h - r);
    this.lineTo(x, y + r);
    this.bezierCurveTo(x, y + c, x + c, y, x + r, y);
    return this.closePath();
  },

  ellipse(x, y, r1, r2) {
    // based on http://stackoverflow.com/questions/2172798/how-to-draw-an-oval-in-html5-canvas/2173084#2173084
    if (r2 == null) {
      r2 = r1;
    }
    x -= r1;
    y -= r2;
    const ox = r1 * KAPPA;
    const oy = r2 * KAPPA;
    const xe = x + r1 * 2;
    const ye = y + r2 * 2;
    const xm = x + r1;
    const ym = y + r2;

    this.moveTo(x, ym);
    this.bezierCurveTo(x, ym - oy, xm - ox, y, xm, y);
    this.bezierCurveTo(xm + ox, y, xe, ym - oy, xe, ym);
    this.bezierCurveTo(xe, ym + oy, xm + ox, ye, xm, ye);
    this.bezierCurveTo(xm - ox, ye, x, ym + oy, x, ym);
    return this.closePath();
  },

  circle(x, y, radius) {
    return this.ellipse(x, y, radius);
  },

  arc(x, y, radius, startAngle, endAngle, anticlockwise) {
    if (anticlockwise == null) {
      anticlockwise = false;
    }
    const TWO_PI = 2.0 * Math.PI;
    const HALF_PI = 0.5 * Math.PI;

    let deltaAng = endAngle - startAngle;

    if (Math.abs(deltaAng) > TWO_PI) {
      // draw only full circle if more than that is specified
      deltaAng = TWO_PI;
    } else if (deltaAng !== 0 && anticlockwise !== deltaAng < 0) {
      // necessary to flip direction of rendering
      const dir = anticlockwise ? -1 : 1;
      deltaAng = dir * TWO_PI + deltaAng;
    }

    const numSegs = Math.ceil(Math.abs(deltaAng) / HALF_PI);
    const segAng = deltaAng / numSegs;
    const handleLen = segAng / HALF_PI * KAPPA * radius;
    let curAng = startAngle;

    // component distances between anchor point and control point
    let deltaCx = -Math.sin(curAng) * handleLen;
    let deltaCy = Math.cos(curAng) * handleLen;

    // anchor point
    let ax = x + Math.cos(curAng) * radius;
    let ay = y + Math.sin(curAng) * radius;

    // calculate and render segments
    this.moveTo(ax, ay);

    for (let segIdx = 0, end = numSegs, asc = 0 <= end; asc ? segIdx < end : segIdx > end; asc ? segIdx++ : segIdx--) {
      // starting control point
      const cp1x = ax + deltaCx;
      const cp1y = ay + deltaCy;

      // step angle
      curAng += segAng;

      // next anchor point
      ax = x + Math.cos(curAng) * radius;
      ay = y + Math.sin(curAng) * radius;

      // next control point delta
      deltaCx = -Math.sin(curAng) * handleLen;
      deltaCy = Math.cos(curAng) * handleLen;

      // ending control point
      const cp2x = ax - deltaCx;
      const cp2y = ay - deltaCy;

      // render segment
      this.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, ax, ay);
    }

    return this;
  },

  polygon(...points) {
    this.moveTo(...(points.shift() || []));
    for (let point of points) {
      this.lineTo(...(point || []));
    }
    return this.closePath();
  },

  path(path) {
    SVGPath.apply(this, path);
    return this;
  },

  _windingRule(rule) {
    if (/even-?odd/.test(rule)) {
      return '*';
    }

    return '';
  },

  fill(color, rule) {
    if (/(even-?odd)|(non-?zero)/.test(color)) {
      rule = color;
      color = null;
    }

    if (color) {
      this.fillColor(color);
    }
    return this.addContent(`f${this._windingRule(rule)}`);
  },

  stroke(color) {
    if (color) {
      this.strokeColor(color);
    }
    return this.addContent('S');
  },

  fillAndStroke(fillColor, strokeColor, rule) {
    if (strokeColor == null) {
      strokeColor = fillColor;
    }
    const isFillRule = /(even-?odd)|(non-?zero)/;
    if (isFillRule.test(fillColor)) {
      rule = fillColor;
      fillColor = null;
    }

    if (isFillRule.test(strokeColor)) {
      rule = strokeColor;
      strokeColor = fillColor;
    }

    if (fillColor) {
      this.fillColor(fillColor);
      this.strokeColor(strokeColor);
    }

    return this.addContent(`B${this._windingRule(rule)}`);
  },

  clip(rule) {
    return this.addContent(`W${this._windingRule(rule)} n`);
  },

  transform(m11, m12, m21, m22, dx, dy) {
    // keep track of the current transformation matrix
    const m = this._ctm;

    var _m = slicedToArray(m, 6);

    const m0 = _m[0],
          m1 = _m[1],
          m2 = _m[2],
          m3 = _m[3],
          m4 = _m[4],
          m5 = _m[5];

    m[0] = m0 * m11 + m2 * m12;
    m[1] = m1 * m11 + m3 * m12;
    m[2] = m0 * m21 + m2 * m22;
    m[3] = m1 * m21 + m3 * m22;
    m[4] = m0 * dx + m2 * dy + m4;
    m[5] = m1 * dx + m3 * dy + m5;

    const values = [m11, m12, m21, m22, dx, dy].map(v => number$1(v)).join(' ');
    return this.addContent(`${values} cm`);
  },

  translate(x, y) {
    return this.transform(1, 0, 0, 1, x, y);
  },

  rotate(angle, options) {
    let y;
    if (options == null) {
      options = {};
    }
    const rad = angle * Math.PI / 180;
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    let x = y = 0;

    if (options.origin != null) {
      var _options$origin = slicedToArray(options.origin, 2);

      x = _options$origin[0];
      y = _options$origin[1];

      const x1 = x * cos - y * sin;
      const y1 = x * sin + y * cos;
      x -= x1;
      y -= y1;
    }

    return this.transform(cos, sin, -sin, cos, x, y);
  },

  scale(xFactor, yFactor, options) {
    let y;
    if (yFactor == null) {
      yFactor = xFactor;
    }
    if (options == null) {
      options = {};
    }
    if (typeof yFactor === "object") {
      options = yFactor;
      yFactor = xFactor;
    }

    let x = y = 0;
    if (options.origin != null) {
      var _options$origin2 = slicedToArray(options.origin, 2);

      x = _options$origin2[0];
      y = _options$origin2[1];

      x -= xFactor * x;
      y -= yFactor * y;
    }

    return this.transform(xFactor, 0, 0, yFactor, x, y);
  }
};

const WIN_ANSI_MAP = {
  402: 131,
  8211: 150,
  8212: 151,
  8216: 145,
  8217: 146,
  8218: 130,
  8220: 147,
  8221: 148,
  8222: 132,
  8224: 134,
  8225: 135,
  8226: 149,
  8230: 133,
  8364: 128,
  8240: 137,
  8249: 139,
  8250: 155,
  710: 136,
  8482: 153,
  338: 140,
  339: 156,
  732: 152,
  352: 138,
  353: 154,
  376: 159,
  381: 142,
  382: 158
};

const characters = `\
.notdef       .notdef        .notdef        .notdef
.notdef       .notdef        .notdef        .notdef
.notdef       .notdef        .notdef        .notdef
.notdef       .notdef        .notdef        .notdef
.notdef       .notdef        .notdef        .notdef
.notdef       .notdef        .notdef        .notdef
.notdef       .notdef        .notdef        .notdef
.notdef       .notdef        .notdef        .notdef
  
space         exclam         quotedbl       numbersign
dollar        percent        ampersand      quotesingle
parenleft     parenright     asterisk       plus
comma         hyphen         period         slash
zero          one            two            three
four          five           six            seven
eight         nine           colon          semicolon
less          equal          greater        question
  
at            A              B              C
D             E              F              G
H             I              J              K
L             M              N              O
P             Q              R              S
T             U              V              W
X             Y              Z              bracketleft
backslash     bracketright   asciicircum    underscore
  
grave         a              b              c
d             e              f              g
h             i              j              k
l             m              n              o
p             q              r              s
t             u              v              w
x             y              z              braceleft
bar           braceright     asciitilde     .notdef
  
Euro          .notdef        quotesinglbase florin
quotedblbase  ellipsis       dagger         daggerdbl
circumflex    perthousand    Scaron         guilsinglleft
OE            .notdef        Zcaron         .notdef
.notdef       quoteleft      quoteright     quotedblleft
quotedblright bullet         endash         emdash
tilde         trademark      scaron         guilsinglright
oe            .notdef        zcaron         ydieresis
  
space         exclamdown     cent           sterling
currency      yen            brokenbar      section
dieresis      copyright      ordfeminine    guillemotleft
logicalnot    hyphen         registered     macron
degree        plusminus      twosuperior    threesuperior
acute         mu             paragraph      periodcentered
cedilla       onesuperior    ordmasculine   guillemotright
onequarter    onehalf        threequarters  questiondown
  
Agrave        Aacute         Acircumflex    Atilde
Adieresis     Aring          AE             Ccedilla
Egrave        Eacute         Ecircumflex    Edieresis
Igrave        Iacute         Icircumflex    Idieresis
Eth           Ntilde         Ograve         Oacute
Ocircumflex   Otilde         Odieresis      multiply
Oslash        Ugrave         Uacute         Ucircumflex
Udieresis     Yacute         Thorn          germandbls
  
agrave        aacute         acircumflex    atilde
adieresis     aring          ae             ccedilla
egrave        eacute         ecircumflex    edieresis
igrave        iacute         icircumflex    idieresis
eth           ntilde         ograve         oacute
ocircumflex   otilde         odieresis      divide
oslash        ugrave         uacute         ucircumflex
udieresis     yacute         thorn          ydieresis\
`.split(/\s+/);

class AFMFont {
  static open(filename) {
    return new AFMFont(fs.readFileSync(filename, 'utf8'));
  }

  constructor(contents) {
    this.contents = contents;
    this.attributes = {};
    this.glyphWidths = {};
    this.boundingBoxes = {};
    this.kernPairs = {};

    this.parse();
    // todo: remove charWidths since appears to not be used
    this.charWidths = new Array(256);
    for (let char = 0; char <= 255; char++) {
      this.charWidths[char] = this.glyphWidths[characters[char]];
    }

    this.bbox = this.attributes['FontBBox'].split(/\s+/).map(e => +e);
    this.ascender = +(this.attributes['Ascender'] || 0);
    this.descender = +(this.attributes['Descender'] || 0);
    this.xHeight = +(this.attributes['XHeight'] || 0);
    this.capHeight = +(this.attributes['CapHeight'] || 0);
    this.lineGap = this.bbox[3] - this.bbox[1] - (this.ascender - this.descender);
  }

  parse() {
    let section = '';
    for (let line of this.contents.split('\n')) {
      var match;
      var a;
      if (match = line.match(/^Start(\w+)/)) {
        section = match[1];
        continue;
      } else if (match = line.match(/^End(\w+)/)) {
        section = '';
        continue;
      }

      switch (section) {
        case 'FontMetrics':
          match = line.match(/(^\w+)\s+(.*)/);
          var key = match[1];
          var value = match[2];

          if (a = this.attributes[key]) {
            if (!Array.isArray(a)) {
              a = this.attributes[key] = [a];
            }
            a.push(value);
          } else {
            this.attributes[key] = value;
          }
          break;

        case 'CharMetrics':
          if (!/^CH?\s/.test(line)) {
            continue;
          }
          var name = line.match(/\bN\s+(\.?\w+)\s*;/)[1];
          this.glyphWidths[name] = +line.match(/\bWX\s+(\d+)\s*;/)[1];
          break;

        case 'KernPairs':
          match = line.match(/^KPX\s+(\.?\w+)\s+(\.?\w+)\s+(-?\d+)/);
          if (match) {
            this.kernPairs[match[1] + '\0' + match[2]] = parseInt(match[3]);
          }
          break;
      }
    }
  }

  encodeText(text) {
    const res = [];
    for (let i = 0, end = text.length, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      let char = text.charCodeAt(i);
      char = WIN_ANSI_MAP[char] || char;
      res.push(char.toString(16));
    }

    return res;
  }

  glyphsForString(string) {
    const glyphs = [];

    for (let i = 0, end = string.length, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
      const charCode = string.charCodeAt(i);
      glyphs.push(this.characterToGlyph(charCode));
    }

    return glyphs;
  }

  characterToGlyph(character) {
    return characters[WIN_ANSI_MAP[character] || character] || '.notdef';
  }

  widthOfGlyph(glyph) {
    return this.glyphWidths[glyph] || 0;
  }

  getKernPair(left, right) {
    return this.kernPairs[left + '\0' + right] || 0;
  }

  advancesForGlyphs(glyphs) {
    const advances = [];

    for (let index = 0; index < glyphs.length; index++) {
      const left = glyphs[index];
      const right = glyphs[index + 1];
      advances.push(this.widthOfGlyph(left) + this.getKernPair(left, right));
    }

    return advances;
  }
}

class PDFFont {
  constructor() {}

  encode() {
    throw new Error('Must be implemented by subclasses');
  }

  widthOfString() {
    throw new Error('Must be implemented by subclasses');
  }

  ref() {
    return this.dictionary != null ? this.dictionary : this.dictionary = this.document.ref();
  }

  finalize() {
    if (this.embedded || this.dictionary == null) {
      return;
    }

    this.embed();
    return this.embedded = true;
  }

  embed() {
    throw new Error('Must be implemented by subclasses');
  }

  lineHeight(size, includeGap) {
    if (includeGap == null) {
      includeGap = false;
    }
    const gap = includeGap ? this.lineGap : 0;
    return (this.ascender + gap - this.descender) / 1000 * size;
  }
}

// This insanity is so bundlers can inline the font files
const STANDARD_FONTS = {
  "Courier"() {
    return fs.readFileSync(__dirname + "/font/data/Courier.afm", 'utf8');
  },
  "Courier-Bold"() {
    return fs.readFileSync(__dirname + "/font/data/Courier-Bold.afm", 'utf8');
  },
  "Courier-Oblique"() {
    return fs.readFileSync(__dirname + "/font/data/Courier-Oblique.afm", 'utf8');
  },
  "Courier-BoldOblique"() {
    return fs.readFileSync(__dirname + "/font/data/Courier-BoldOblique.afm", 'utf8');
  },
  "Helvetica"() {
    return fs.readFileSync(__dirname + "/font/data/Helvetica.afm", 'utf8');
  },
  "Helvetica-Bold"() {
    return fs.readFileSync(__dirname + "/font/data/Helvetica-Bold.afm", 'utf8');
  },
  "Helvetica-Oblique"() {
    return fs.readFileSync(__dirname + "/font/data/Helvetica-Oblique.afm", 'utf8');
  },
  "Helvetica-BoldOblique"() {
    return fs.readFileSync(__dirname + "/font/data/Helvetica-BoldOblique.afm", 'utf8');
  },
  "Times-Roman"() {
    return fs.readFileSync(__dirname + "/font/data/Times-Roman.afm", 'utf8');
  },
  "Times-Bold"() {
    return fs.readFileSync(__dirname + "/font/data/Times-Bold.afm", 'utf8');
  },
  "Times-Italic"() {
    return fs.readFileSync(__dirname + "/font/data/Times-Italic.afm", 'utf8');
  },
  "Times-BoldItalic"() {
    return fs.readFileSync(__dirname + "/font/data/Times-BoldItalic.afm", 'utf8');
  },
  "Symbol"() {
    return fs.readFileSync(__dirname + "/font/data/Symbol.afm", 'utf8');
  },
  "ZapfDingbats"() {
    return fs.readFileSync(__dirname + "/font/data/ZapfDingbats.afm", 'utf8');
  }
};

class StandardFont extends PDFFont {
  constructor(document, name, id) {
    super();
    this.document = document;
    this.name = name;
    this.id = id;
    this.font = new AFMFont(STANDARD_FONTS[this.name]());
    var _font = this.font;
    this.ascender = _font.ascender;
    this.descender = _font.descender;
    this.bbox = _font.bbox;
    this.lineGap = _font.lineGap;
    this.xHeight = _font.xHeight;
    this.capHeight = _font.capHeight;
  }

  embed() {
    this.dictionary.data = {
      Type: 'Font',
      BaseFont: this.name,
      Subtype: 'Type1',
      Encoding: 'WinAnsiEncoding'
    };

    return this.dictionary.end();
  }

  encode(text) {
    const encoded = this.font.encodeText(text);
    const glyphs = this.font.glyphsForString(`${text}`);
    const advances = this.font.advancesForGlyphs(glyphs);
    const positions = [];
    for (let i = 0; i < glyphs.length; i++) {
      const glyph = glyphs[i];
      positions.push({
        xAdvance: advances[i],
        yAdvance: 0,
        xOffset: 0,
        yOffset: 0,
        advanceWidth: this.font.widthOfGlyph(glyph)
      });
    }

    return [encoded, positions];
  }

  widthOfString(string, size) {
    const glyphs = this.font.glyphsForString(`${string}`);
    const advances = this.font.advancesForGlyphs(glyphs);

    let width = 0;
    for (let advance of advances) {
      width += advance;
    }

    const scale = size / 1000;
    return width * scale;
  }

  static isStandardFont(name) {
    return name in STANDARD_FONTS;
  }
}

const toHex = function toHex(num) {
  return `0000${num.toString(16)}`.slice(-4);
};

class EmbeddedFont extends PDFFont {
  constructor(document, font, id) {
    super();
    this.document = document;
    this.font = font;
    this.id = id;
    this.subset = this.font.createSubset();
    this.unicode = [[0]];
    this.widths = [this.font.getGlyph(0).advanceWidth];

    this.name = this.font.postscriptName;
    this.scale = 1000 / this.font.unitsPerEm;
    this.ascender = this.font.ascent * this.scale;
    this.descender = this.font.descent * this.scale;
    this.xHeight = this.font.xHeight * this.scale;
    this.capHeight = this.font.capHeight * this.scale;
    this.lineGap = this.font.lineGap * this.scale;
    this.bbox = this.font.bbox;

    this.layoutCache = Object.create(null);
  }

  layoutRun(text, features) {
    const run = this.font.layout(text, features);

    // Normalize position values
    for (let i = 0; i < run.positions.length; i++) {
      const position = run.positions[i];
      for (let key in position) {
        position[key] *= this.scale;
      }

      position.advanceWidth = run.glyphs[i].advanceWidth * this.scale;
    }

    return run;
  }

  layoutCached(text) {
    let cached;
    if (cached = this.layoutCache[text]) {
      return cached;
    }

    const run = this.layoutRun(text);
    this.layoutCache[text] = run;
    return run;
  }

  layout(text, features, onlyWidth) {
    // Skip the cache if any user defined features are applied
    if (onlyWidth == null) {
      onlyWidth = false;
    }
    if (features) {
      return this.layoutRun(text, features);
    }

    const glyphs = onlyWidth ? null : [];
    const positions = onlyWidth ? null : [];
    let advanceWidth = 0;

    // Split the string by words to increase cache efficiency.
    // For this purpose, spaces and tabs are a good enough delimeter.
    let last = 0;
    let index = 0;
    while (index <= text.length) {
      var needle;
      if (index === text.length && last < index || (needle = text.charAt(index), [' ', '\t'].includes(needle))) {
        const run = this.layoutCached(text.slice(last, ++index));
        if (!onlyWidth) {
          glyphs.push(...(run.glyphs || []));
          positions.push(...(run.positions || []));
        }

        advanceWidth += run.advanceWidth;
        last = index;
      } else {
        index++;
      }
    }

    return { glyphs, positions, advanceWidth };
  }

  encode(text, features) {
    var _layout = this.layout(text, features);

    const glyphs = _layout.glyphs,
          positions = _layout.positions;


    const res = [];
    for (let i = 0; i < glyphs.length; i++) {
      const glyph = glyphs[i];
      const gid = this.subset.includeGlyph(glyph.id);
      res.push(`0000${gid.toString(16)}`.slice(-4));

      if (this.widths[gid] == null) {
        this.widths[gid] = glyph.advanceWidth * this.scale;
      }
      if (this.unicode[gid] == null) {
        this.unicode[gid] = glyph.codePoints;
      }
    }

    return [res, positions];
  }

  widthOfString(string, size, features) {
    const width = this.layout(string, features, true).advanceWidth;
    const scale = size / 1000;
    return width * scale;
  }

  embed() {
    const isCFF = this.subset.cff != null;
    const fontFile = this.document.ref();

    if (isCFF) {
      fontFile.data.Subtype = 'CIDFontType0C';
    }

    this.subset.encodeStream().on('data', data => fontFile.write(data)).on('end', () => fontFile.end());

    const familyClass = ((this.font['OS/2'] != null ? this.font['OS/2'].sFamilyClass : undefined) || 0) >> 8;
    let flags = 0;
    if (this.font.post.isFixedPitch) {
      flags |= 1 << 0;
    }
    if (1 <= familyClass && familyClass <= 7) {
      flags |= 1 << 1;
    }
    flags |= 1 << 2; // assume the font uses non-latin characters
    if (familyClass === 10) {
      flags |= 1 << 3;
    }
    if (this.font.head.macStyle.italic) {
      flags |= 1 << 6;
    }

    // generate a tag (6 uppercase letters. 16 is the char code offset from '1' to 'A'. 74 will map to 'Z')
    const tag = [1, 2, 3, 4, 5, 6].map(i => String.fromCharCode((this.id.charCodeAt(i) || 74) + 16)).join('');
    const name = tag + '+' + this.font.postscriptName;

    const bbox = this.font.bbox;

    const descriptor = this.document.ref({
      Type: 'FontDescriptor',
      FontName: name,
      Flags: flags,
      FontBBox: [bbox.minX * this.scale, bbox.minY * this.scale, bbox.maxX * this.scale, bbox.maxY * this.scale],
      ItalicAngle: this.font.italicAngle,
      Ascent: this.ascender,
      Descent: this.descender,
      CapHeight: (this.font.capHeight || this.font.ascent) * this.scale,
      XHeight: (this.font.xHeight || 0) * this.scale,
      StemV: 0
    }); // not sure how to calculate this

    if (isCFF) {
      descriptor.data.FontFile3 = fontFile;
    } else {
      descriptor.data.FontFile2 = fontFile;
    }

    descriptor.end();

    const descendantFont = this.document.ref({
      Type: 'Font',
      Subtype: isCFF ? 'CIDFontType0' : 'CIDFontType2',
      BaseFont: name,
      CIDSystemInfo: {
        Registry: new String('Adobe'),
        Ordering: new String('Identity'),
        Supplement: 0
      },
      FontDescriptor: descriptor,
      W: [0, this.widths] });

    descendantFont.end();

    this.dictionary.data = {
      Type: 'Font',
      Subtype: 'Type0',
      BaseFont: name,
      Encoding: 'Identity-H',
      DescendantFonts: [descendantFont],
      ToUnicode: this.toUnicodeCmap()
    };

    return this.dictionary.end();
  }

  // Maps the glyph ids encoded in the PDF back to unicode strings
  // Because of ligature substitutions and the like, there may be one or more
  // unicode characters represented by each glyph.
  toUnicodeCmap() {
    const cmap = this.document.ref();

    const entries = [];
    for (let codePoints of this.unicode) {
      const encoded = [];

      // encode codePoints to utf16
      for (let value of codePoints) {
        if (value > 0xffff) {
          value -= 0x10000;
          encoded.push(toHex(value >>> 10 & 0x3ff | 0xd800));
          value = 0xdc00 | value & 0x3ff;
        }

        encoded.push(toHex(value));
      }

      entries.push(`<${encoded.join(' ')}>`);
    }

    cmap.end(`\
/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo <<
  /Registry (Adobe)
  /Ordering (UCS)
  /Supplement 0
>> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000><ffff>
endcodespacerange
1 beginbfrange
<0000> <${toHex(entries.length - 1)}> [${entries.join(' ')}]
endbfrange
endcmap
CMapName currentdict /CMap defineresource pop
end
end\
`);

    return cmap;
  }
}

class PDFFontFactory {
  static open(document, src, family, id) {
    let font;
    if (typeof src === 'string') {
      if (StandardFont.isStandardFont(src)) {
        return new StandardFont(document, src, id);
      }

      font = fontkit.openSync(src, family);
    } else if (Buffer.isBuffer(src)) {
      font = fontkit.create(src, family);
    } else if (src instanceof Uint8Array) {
      font = fontkit.create(new Buffer(src), family);
    } else if (src instanceof ArrayBuffer) {
      font = fontkit.create(new Buffer(new Uint8Array(src)), family);
    }

    if (font == null) {
      throw new Error('Not a supported font format or standard PDF font.');
    }

    return new EmbeddedFont(document, font, id);
  }
}

var FontsMixin = {
  initFonts() {
    // Lookup table for embedded fonts
    this._fontFamilies = {};
    this._fontCount = 0;

    // Font state
    this._fontSize = 12;
    this._font = null;

    this._registeredFonts = {};

    // Set the default font
    return this.font('Helvetica');
  },

  font(src, family, size) {
    let cacheKey, font;
    if (typeof family === 'number') {
      size = family;
      family = null;
    }

    // check registered fonts if src is a string
    if (typeof src === 'string' && this._registeredFonts[src]) {
      cacheKey = src;
      var _registeredFonts$src = this._registeredFonts[src];
      src = _registeredFonts$src.src;
      family = _registeredFonts$src.family;
    } else {
      cacheKey = family || src;
      if (typeof cacheKey !== 'string') {
        cacheKey = null;
      }
    }

    if (size != null) {
      this.fontSize(size);
    }

    // fast path: check if the font is already in the PDF
    if (font = this._fontFamilies[cacheKey]) {
      this._font = font;
      return this;
    }

    // load the font
    const id = `F${++this._fontCount}`;
    this._font = PDFFontFactory.open(this, src, family, id);

    // check for existing font familes with the same name already in the PDF
    // useful if the font was passed as a buffer
    if (font = this._fontFamilies[this._font.name]) {
      this._font = font;
      return this;
    }

    // save the font for reuse later
    if (cacheKey) {
      this._fontFamilies[cacheKey] = this._font;
    }

    if (this._font.name) {
      this._fontFamilies[this._font.name] = this._font;
    }

    return this;
  },

  fontSize(_fontSize) {
    this._fontSize = _fontSize;
    return this;
  },

  currentLineHeight(includeGap) {
    if (includeGap == null) {
      includeGap = false;
    }
    return this._font.lineHeight(this._fontSize, includeGap);
  },

  registerFont(name, src, family) {
    this._registeredFonts[name] = {
      src,
      family
    };

    return this;
  }
};

class LineWrapper extends EventEmitter {
  constructor(document, options) {
    super();
    this.document = document;
    this.indent = options.indent || 0;
    this.characterSpacing = options.characterSpacing || 0;
    this.wordSpacing = options.wordSpacing === 0;
    this.columns = options.columns || 1;
    this.columnGap = options.columnGap != null ? options.columnGap : 18; // 1/4 inch
    this.lineWidth = (options.width - this.columnGap * (this.columns - 1)) / this.columns;
    this.spaceLeft = this.lineWidth;
    this.startX = this.document.x;
    this.startY = this.document.y;
    this.column = 1;
    this.ellipsis = options.ellipsis;
    this.continuedX = 0;
    this.features = options.features;

    // calculate the maximum Y position the text can appear at
    if (options.height != null) {
      this.height = options.height;
      this.maxY = this.startY + options.height;
    } else {
      this.maxY = this.document.page.maxY();
    }

    // handle paragraph indents
    this.on('firstLine', options => {
      // if this is the first line of the text segment, and
      // we're continuing where we left off, indent that much
      // otherwise use the user specified indent option
      const indent = this.continuedX || this.indent;
      this.document.x += indent;
      this.lineWidth -= indent;

      return this.once('line', () => {
        this.document.x -= indent;
        this.lineWidth += indent;
        if (options.continued && !this.continuedX) {
          this.continuedX = this.indent;
        }
        if (!options.continued) {
          return this.continuedX = 0;
        }
      });
    });

    // handle left aligning last lines of paragraphs
    this.on('lastLine', options => {
      const align = options.align;

      if (align === 'justify') {
        options.align = 'left';
      }
      this.lastLine = true;

      return this.once('line', () => {
        this.document.y += options.paragraphGap || 0;
        options.align = align;
        return this.lastLine = false;
      });
    });
  }

  wordWidth(word) {
    return this.document.widthOfString(word, this) + this.characterSpacing + this.wordSpacing;
  }

  eachWord(text, fn) {
    // setup a unicode line breaker
    let bk;
    const breaker = new LineBreaker(text);
    let last = null;
    const wordWidths = Object.create(null);

    while (bk = breaker.nextBreak()) {
      var shouldContinue;
      let word = text.slice((last != null ? last.position : undefined) || 0, bk.position);
      let w = wordWidths[word] != null ? wordWidths[word] : wordWidths[word] = this.wordWidth(word);

      // if the word is longer than the whole line, chop it up
      // TODO: break by grapheme clusters, not JS string characters
      if (w > this.lineWidth + this.continuedX) {
        // make some fake break objects
        let lbk = last;
        const fbk = {};

        while (word.length) {
          // fit as much of the word as possible into the space we have
          var l, mightGrow;
          if (w > this.spaceLeft) {
            // start our check at the end of our available space - this method is faster than a loop of each character and it resolves
            // an issue with long loops when processing massive words, such as a huge number of spaces
            l = Math.ceil(this.spaceLeft / (w / word.length));
            w = this.wordWidth(word.slice(0, l));
            mightGrow = w <= this.spaceLeft && l < word.length;
          } else {
            l = word.length;
          }
          let mustShrink = w > this.spaceLeft && l > 0;
          // shrink or grow word as necessary after our near-guess above
          while (mustShrink || mightGrow) {
            if (mustShrink) {
              w = this.wordWidth(word.slice(0, --l));
              mustShrink = w > this.spaceLeft && l > 0;
            } else {
              w = this.wordWidth(word.slice(0, ++l));
              mustShrink = w > this.spaceLeft && l > 0;
              mightGrow = w <= this.spaceLeft && l < word.length;
            }
          }

          // send a required break unless this is the last piece and a linebreak is not specified
          fbk.required = bk.required || l < word.length;
          shouldContinue = fn(word.slice(0, l), w, fbk, lbk);
          lbk = { required: false };

          // get the remaining piece of the word
          word = word.slice(l);
          w = this.wordWidth(word);

          if (shouldContinue === false) {
            break;
          }
        }
      } else {
        // otherwise just emit the break as it was given to us
        shouldContinue = fn(word, w, bk, last);
      }

      if (shouldContinue === false) {
        break;
      }
      last = bk;
    }
  }

  wrap(text, options) {
    // override options from previous continued fragments
    if (options.indent != null) {
      this.indent = options.indent;
    }
    if (options.characterSpacing != null) {
      this.characterSpacing = options.characterSpacing;
    }
    if (options.wordSpacing != null) {
      this.wordSpacing = options.wordSpacing;
    }
    if (options.ellipsis != null) {
      this.ellipsis = options.ellipsis;
    }

    // make sure we're actually on the page 
    // and that the first line of is never by 
    // itself at the bottom of a page (orphans)
    const nextY = this.document.y + this.document.currentLineHeight(true);
    if (this.document.y > this.maxY || nextY > this.maxY) {
      this.nextSection();
    }

    let buffer = '';
    let textWidth = 0;
    let wc = 0;
    let lc = 0;

    let y = this.document.y; // used to reset Y pos if options.continued (below)

    const emitLine = () => {
      options.textWidth = textWidth + this.wordSpacing * (wc - 1);
      options.wordCount = wc;
      options.lineWidth = this.lineWidth;
      y = this.document.y;

      this.emit('line', buffer, options, this);
      return lc++;
    };

    this.emit('sectionStart', options, this);

    this.eachWord(text, (word, w, bk, last) => {
      if (last == null || last.required) {
        this.emit('firstLine', options, this);
        this.spaceLeft = this.lineWidth;
      }

      if (w <= this.spaceLeft) {
        buffer += word;
        textWidth += w;
        wc++;
      }

      if (bk.required || w > this.spaceLeft) {
        // if the user specified a max height and an ellipsis, and is about to pass the
        // max height and max columns after the next line, append the ellipsis
        const lh = this.document.currentLineHeight(true);
        if (this.height != null && this.ellipsis && this.document.y + lh * 2 > this.maxY && this.column >= this.columns) {
          if (this.ellipsis === true) {
            this.ellipsis = '…';
          } // map default ellipsis character
          buffer = buffer.replace(/\s+$/, '');
          textWidth = this.wordWidth(buffer + this.ellipsis);

          // remove characters from the buffer until the ellipsis fits
          // to avoid inifinite loop need to stop while-loop if buffer is empty string
          while (buffer && textWidth > this.lineWidth) {
            buffer = buffer.slice(0, -1).replace(/\s+$/, '');
            textWidth = this.wordWidth(buffer + this.ellipsis);
          }
          // need to add ellipsis only if there is enough space for it
          if (textWidth <= this.lineWidth) {
            buffer = buffer + this.ellipsis;
          }

          textWidth = this.wordWidth(buffer);
        }

        if (bk.required) {
          if (w > this.spaceLeft) {
            emitLine();
            buffer = word;
            textWidth = w;
            wc = 1;
          }

          this.emit('lastLine', options, this);
        }

        emitLine();

        // if we've reached the edge of the page, 
        // continue on a new page or column
        if (this.document.y + lh > this.maxY) {
          const shouldContinue = this.nextSection();

          // stop if we reached the maximum height
          if (!shouldContinue) {
            wc = 0;
            buffer = '';
            return false;
          }
        }

        // reset the space left and buffer
        if (bk.required) {
          this.spaceLeft = this.lineWidth;
          buffer = '';
          textWidth = 0;
          return wc = 0;
        } else {
          // reset the space left and buffer
          this.spaceLeft = this.lineWidth - w;
          buffer = word;
          textWidth = w;
          return wc = 1;
        }
      } else {
        return this.spaceLeft -= w;
      }
    });

    if (wc > 0) {
      this.emit('lastLine', options, this);
      emitLine();
    }

    this.emit('sectionEnd', options, this);

    // if the wrap is set to be continued, save the X position
    // to start the first line of the next segment at, and reset
    // the y position
    if (options.continued === true) {
      if (lc > 1) {
        this.continuedX = 0;
      }
      this.continuedX += options.textWidth || 0;
      return this.document.y = y;
    } else {
      return this.document.x = this.startX;
    }
  }

  nextSection(options) {
    this.emit('sectionEnd', options, this);

    if (++this.column > this.columns) {
      // if a max height was specified by the user, we're done.
      // otherwise, the default is to make a new page at the bottom.
      if (this.height != null) {
        return false;
      }

      this.document.addPage();
      this.column = 1;
      this.startY = this.document.page.margins.top;
      this.maxY = this.document.page.maxY();
      this.document.x = this.startX;
      if (this.document._fillColor) {
        this.document.fillColor(...(this.document._fillColor || []));
      }
      this.emit('pageBreak', options, this);
    } else {
      this.document.x += this.lineWidth + this.columnGap;
      this.document.y = this.startY;
      this.emit('columnBreak', options, this);
    }

    this.emit('sectionStart', options, this);
    return true;
  }
}

const number$2 = PDFObject.number;


var TextMixin = {
  initText() {
    this._line = this._line.bind(this);
    // Current coordinates
    this.x = 0;
    this.y = 0;
    return this._lineGap = 0;
  },

  lineGap(_lineGap) {
    this._lineGap = _lineGap;
    return this;
  },

  moveDown(lines) {
    if (lines == null) {
      lines = 1;
    }
    this.y += this.currentLineHeight(true) * lines + this._lineGap;
    return this;
  },

  moveUp(lines) {
    if (lines == null) {
      lines = 1;
    }
    this.y -= this.currentLineHeight(true) * lines + this._lineGap;
    return this;
  },

  _text(text, x, y, options, lineCallback) {
    options = this._initOptions(x, y, options);

    // Convert text to a string
    text = text == null ? '' : `${text}`;

    // if the wordSpacing option is specified, remove multiple consecutive spaces
    if (options.wordSpacing) {
      text = text.replace(/\s{2,}/g, ' ');
    }

    // word wrapping
    if (options.width) {
      let wrapper = this._wrapper;
      if (!wrapper) {
        wrapper = new LineWrapper(this, options);
        wrapper.on('line', lineCallback);
      }

      this._wrapper = options.continued ? wrapper : null;
      this._textOptions = options.continued ? options : null;
      wrapper.wrap(text, options);

      // render paragraphs as single lines
    } else {
      for (let line of text.split('\n')) {
        lineCallback(line, options);
      }
    }

    return this;
  },

  text(text, x, y, options) {
    return this._text(text, x, y, options, this._line);
  },

  widthOfString(string, options) {
    if (options == null) {
      options = {};
    }
    return this._font.widthOfString(string, this._fontSize, options.features) + (options.characterSpacing || 0) * (string.length - 1);
  },

  heightOfString(text, options) {
    if (options == null) {
      options = {};
    }
    const x = this.x,
          y = this.y;


    options = this._initOptions(options);
    options.height = Infinity; // don't break pages

    const lineGap = options.lineGap || this._lineGap || 0;
    this._text(text, this.x, this.y, options, (line, options) => {
      return this.y += this.currentLineHeight(true) + lineGap;
    });

    const height = this.y - y;
    this.x = x;
    this.y = y;

    return height;
  },

  list(list, x, y, options, wrapper) {
    options = this._initOptions(x, y, options);

    const listType = options.listType || 'bullet';
    const unit = Math.round(this._font.ascender / 1000 * this._fontSize);
    const midLine = unit / 2;
    const r = options.bulletRadius || unit / 3;
    const indent = options.textIndent || (listType === 'bullet' ? r * 5 : unit * 2);
    const itemIndent = options.bulletIndent || (listType === 'bullet' ? r * 8 : unit * 2);

    let level = 1;
    const items = [];
    const levels = [];
    const numbers = [];

    var flatten = function flatten(list) {
      let n = 1;
      for (let i = 0; i < list.length; i++) {
        const item = list[i];
        if (Array.isArray(item)) {
          level++;
          flatten(item);
          level--;
        } else {
          items.push(item);
          levels.push(level);
          if (listType !== 'bullet') {
            numbers.push(n++);
          }
        }
      }
    };

    flatten(list);

    const label = function label(n) {
      switch (listType) {
        case 'numbered':
          return `${n}.`;
        case 'lettered':
          var letter = String.fromCharCode((n - 1) % 26 + 65);
          var times = Math.floor((n - 1) / 26 + 1);
          var text = Array(times + 1).join(letter);
          return `${text}.`;
      }
    };

    wrapper = new LineWrapper(this, options);
    wrapper.on('line', this._line);

    level = 1;
    let i = 0;
    wrapper.on('firstLine', () => {
      let l;
      if ((l = levels[i++]) !== level) {
        const diff = itemIndent * (l - level);
        this.x += diff;
        wrapper.lineWidth -= diff;
        level = l;
      }

      switch (listType) {
        case 'bullet':
          this.circle(this.x - indent + r, this.y + midLine, r);
          return this.fill();
        case 'numbered':case 'lettered':
          var text = label(numbers[i - 1]);
          return this._fragment(text, this.x - indent, this.y, options);
      }
    });

    wrapper.on('sectionStart', () => {
      const pos = indent + itemIndent * (level - 1);
      this.x += pos;
      return wrapper.lineWidth -= pos;
    });

    wrapper.on('sectionEnd', () => {
      const pos = indent + itemIndent * (level - 1);
      this.x -= pos;
      return wrapper.lineWidth += pos;
    });

    wrapper.wrap(items.join('\n'), options);

    return this;
  },

  _initOptions(x, y, options) {
    if (x == null) {
      x = {};
    }
    if (options == null) {
      options = {};
    }
    if (typeof x === 'object') {
      options = x;
      x = null;
    }

    // clone options object
    options = function () {
      const opts = {};
      for (let k in options) {
        const v = options[k];opts[k] = v;
      }
      return opts;
    }();

    // extend options with previous values for continued text
    if (this._textOptions) {
      for (let key in this._textOptions) {
        const val = this._textOptions[key];
        if (key !== 'continued') {
          if (options[key] == null) {
            options[key] = val;
          }
        }
      }
    }

    // Update the current position
    if (x != null) {
      this.x = x;
    }
    if (y != null) {
      this.y = y;
    }

    // wrap to margins if no x or y position passed
    if (options.lineBreak !== false) {
      if (options.width == null) {
        options.width = this.page.width - this.x - this.page.margins.right;
      }
    }

    if (!options.columns) {
      options.columns = 0;
    }
    if (options.columnGap == null) {
      options.columnGap = 18;
    } // 1/4 inch

    return options;
  },

  _line(text, options, wrapper) {
    if (options == null) {
      options = {};
    }
    this._fragment(text, this.x, this.y, options);
    const lineGap = options.lineGap || this._lineGap || 0;

    if (!wrapper) {
      return this.x += this.widthOfString(text);
    } else {
      return this.y += this.currentLineHeight(true) + lineGap;
    }
  },

  _fragment(text, x, y, options) {
    let dy, encoded, i, positions, textWidth, words;
    text = `${text}`.replace(/\n/g, '');
    if (text.length === 0) {
      return;
    }

    // handle options
    const align = options.align || 'left';
    let wordSpacing = options.wordSpacing || 0;
    const characterSpacing = options.characterSpacing || 0;

    // text alignments
    if (options.width) {
      switch (align) {
        case 'right':
          textWidth = this.widthOfString(text.replace(/\s+$/, ''), options);
          x += options.lineWidth - textWidth;
          break;

        case 'center':
          x += options.lineWidth / 2 - options.textWidth / 2;
          break;

        case 'justify':
          // calculate the word spacing value
          words = text.trim().split(/\s+/);
          textWidth = this.widthOfString(text.replace(/\s+/g, ''), options);
          var spaceWidth = this.widthOfString(' ') + characterSpacing;
          wordSpacing = Math.max(0, (options.lineWidth - textWidth) / Math.max(1, words.length - 1) - spaceWidth);
          break;
      }
    }

    // text baseline alignments based on http://wiki.apache.org/xmlgraphics-fop/LineLayout/AlignmentHandling
    if (typeof options.baseline === 'number') {
      dy = -options.baseline;
    } else {
      switch (options.baseline) {
        case 'svg-middle':
          dy = 0.5 * this._font.xHeight;
          break;
        case 'middle':case 'svg-central':
          dy = 0.5 * (this._font.descender + this._font.ascender);
          break;
        case 'bottom':case 'ideographic':
          dy = this._font.descender;
          break;
        case 'alphabetic':
          dy = 0;
          break;
        case 'mathematical':
          dy = 0.5 * this._font.ascender;
          break;
        case 'hanging':
          dy = 0.8 * this._font.ascender;
          break;
        case 'top':
          dy = this._font.ascender;
          break;
        default:
          dy = this._font.ascender;
      }
      dy = dy / 1000 * this._fontSize;
    }

    // calculate the actual rendered width of the string after word and character spacing
    const renderedWidth = options.textWidth + wordSpacing * (options.wordCount - 1) + characterSpacing * (text.length - 1);

    // create link annotations if the link option is given
    if (options.link != null) {
      this.link(x, y, renderedWidth, this.currentLineHeight(), options.link);
    }

    // create underline or strikethrough line
    if (options.underline || options.strike) {
      this.save();
      if (!options.stroke) {
        this.strokeColor(...(this._fillColor || []));
      }

      const lineWidth = this._fontSize < 10 ? 0.5 : Math.floor(this._fontSize / 10);
      this.lineWidth(lineWidth);

      const d = options.underline ? 1 : 2;
      let lineY = y + this.currentLineHeight() / d;
      if (options.underline) {
        lineY -= lineWidth;
      }

      this.moveTo(x, lineY);
      this.lineTo(x + renderedWidth, lineY);
      this.stroke();
      this.restore();
    }

    this.save();

    // oblique (angle in degrees or boolean)
    if (options.oblique) {
      let skew;
      if (typeof options.oblique === 'number') {
        skew = -Math.tan(options.oblique * Math.PI / 180);
      } else {
        skew = -0.25;
      }
      this.transform(1, 0, 0, 1, x, y);
      this.transform(1, 0, skew, 1, -skew * dy, 0);
      this.transform(1, 0, 0, 1, -x, -y);
    }

    // flip coordinate system
    this.transform(1, 0, 0, -1, 0, this.page.height);
    y = this.page.height - y - dy;

    // add current font to page if necessary
    if (this.page.fonts[this._font.id] == null) {
      this.page.fonts[this._font.id] = this._font.ref();
    }

    // begin the text object
    this.addContent("BT");

    // text position
    this.addContent(`1 0 0 1 ${number$2(x)} ${number$2(y)} Tm`);

    // font and font size
    this.addContent(`/${this._font.id} ${number$2(this._fontSize)} Tf`);

    // rendering mode
    const mode = options.fill && options.stroke ? 2 : options.stroke ? 1 : 0;
    if (mode) {
      this.addContent(`${mode} Tr`);
    }

    // Character spacing
    if (characterSpacing) {
      this.addContent(`${number$2(characterSpacing)} Tc`);
    }

    // Add the actual text
    // If we have a word spacing value, we need to encode each word separately
    // since the normal Tw operator only works on character code 32, which isn't
    // used for embedded fonts.
    if (wordSpacing) {
      words = text.trim().split(/\s+/);
      wordSpacing += this.widthOfString(' ') + characterSpacing;
      wordSpacing *= 1000 / this._fontSize;

      encoded = [];
      positions = [];
      for (let word of words) {
        var _font$encode = this._font.encode(word, options.features),
            _font$encode2 = slicedToArray(_font$encode, 2);

        const encodedWord = _font$encode2[0],
              positionsWord = _font$encode2[1];

        encoded.push(...(encodedWord || []));
        positions.push(...(positionsWord || []));

        // add the word spacing to the end of the word
        // clone object because of cache
        const space = {};
        const object = positions[positions.length - 1];
        for (let key in object) {
          const val = object[key];space[key] = val;
        }
        space.xAdvance += wordSpacing;
        positions[positions.length - 1] = space;
      }
    } else {
      var _font$encode3 = this._font.encode(text, options.features);

      var _font$encode4 = slicedToArray(_font$encode3, 2);

      encoded = _font$encode4[0];
      positions = _font$encode4[1];
    }

    const scale = this._fontSize / 1000;
    const commands = [];
    let last = 0;
    let hadOffset = false;

    // Adds a segment of text to the TJ command buffer
    const addSegment = cur => {
      if (last < cur) {
        const hex = encoded.slice(last, cur).join('');
        const advance = positions[cur - 1].xAdvance - positions[cur - 1].advanceWidth;
        commands.push(`<${hex}> ${number$2(-advance)}`);
      }

      return last = cur;
    };

    // Flushes the current TJ commands to the output stream
    const flush = i => {
      addSegment(i);

      if (commands.length > 0) {
        this.addContent(`[${commands.join(' ')}] TJ`);
        return commands.length = 0;
      }
    };

    for (i = 0; i < positions.length; i++) {
      // If we have an x or y offset, we have to break out of the current TJ command
      // so we can move the text position.
      const pos = positions[i];
      if (pos.xOffset || pos.yOffset) {
        // Flush the current buffer
        flush(i);

        // Move the text position and flush just the current character
        this.addContent(`1 0 0 1 ${number$2(x + pos.xOffset * scale)} ${number$2(y + pos.yOffset * scale)} Tm`);
        flush(i + 1);

        hadOffset = true;
      } else {
        // If the last character had an offset, reset the text position
        if (hadOffset) {
          this.addContent(`1 0 0 1 ${number$2(x)} ${number$2(y)} Tm`);
          hadOffset = false;
        }

        // Group segments that don't have any advance adjustments
        if (pos.xAdvance - pos.advanceWidth !== 0) {
          addSegment(i + 1);
        }
      }

      x += pos.xAdvance * scale;
    }

    // Flush any remaining commands
    flush(i);

    // end the text object
    this.addContent("ET");

    // restore flipped coordinate system
    return this.restore();
  }
};

const MARKERS = [0xFFC0, 0xFFC1, 0xFFC2, 0xFFC3, 0xFFC5, 0xFFC6, 0xFFC7, 0xFFC8, 0xFFC9, 0xFFCA, 0xFFCB, 0xFFCC, 0xFFCD, 0xFFCE, 0xFFCF];

const COLOR_SPACE_MAP = {
  1: 'DeviceGray',
  3: 'DeviceRGB',
  4: 'DeviceCMYK'
};

class JPEG {
  constructor(data, label) {
    let marker;
    this.data = data;
    this.label = label;
    if (this.data.readUInt16BE(0) !== 0xFFD8) {
      throw "SOI not found in JPEG";
    }

    let pos = 2;
    while (pos < this.data.length) {
      marker = this.data.readUInt16BE(pos);
      pos += 2;
      if (MARKERS.includes(marker)) {
        break;
      }
      pos += this.data.readUInt16BE(pos);
    }

    if (!MARKERS.includes(marker)) {
      throw "Invalid JPEG.";
    }
    pos += 2;

    this.bits = this.data[pos++];
    this.height = this.data.readUInt16BE(pos);
    pos += 2;

    this.width = this.data.readUInt16BE(pos);
    pos += 2;

    const channels = this.data[pos++];
    this.colorSpace = COLOR_SPACE_MAP[channels];

    this.obj = null;
  }

  embed(document) {
    if (this.obj) {
      return;
    }

    this.obj = document.ref({
      Type: 'XObject',
      Subtype: 'Image',
      BitsPerComponent: this.bits,
      Width: this.width,
      Height: this.height,
      ColorSpace: this.colorSpace,
      Filter: 'DCTDecode'
    });

    // add extra decode params for CMYK images. By swapping the
    // min and max values from the default, we invert the colors. See
    // section 4.8.4 of the spec.  
    if (this.colorSpace === 'DeviceCMYK') {
      this.obj.data['Decode'] = [1.0, 0.0, 1.0, 0.0, 1.0, 0.0, 1.0, 0.0];
    }

    this.obj.end(this.data);

    // free memory
    return this.data = null;
  }
}

class PNGImage {
  constructor(data, label) {
    this.label = label;
    this.image = new PNG(data);
    this.width = this.image.width;
    this.height = this.image.height;
    this.imgData = this.image.imgData;
    this.obj = null;
  }

  embed(document) {
    this.document = document;
    if (this.obj) {
      return;
    }

    this.obj = this.document.ref({
      Type: 'XObject',
      Subtype: 'Image',
      BitsPerComponent: this.image.bits,
      Width: this.width,
      Height: this.height,
      Filter: 'FlateDecode'
    });

    if (!this.image.hasAlphaChannel) {
      const params = this.document.ref({
        Predictor: 15,
        Colors: this.image.colors,
        BitsPerComponent: this.image.bits,
        Columns: this.width
      });

      this.obj.data['DecodeParms'] = params;
      params.end();
    }

    if (this.image.palette.length === 0) {
      this.obj.data['ColorSpace'] = this.image.colorSpace;
    } else {
      // embed the color palette in the PDF as an object stream
      const palette = this.document.ref();
      palette.end(new Buffer(this.image.palette));

      // build the color space array for the image
      this.obj.data['ColorSpace'] = ['Indexed', 'DeviceRGB', this.image.palette.length / 3 - 1, palette];
    }

    // For PNG color types 0, 2 and 3, the transparency data is stored in
    // a dedicated PNG chunk.
    if (this.image.transparency.grayscale) {
      // Use Color Key Masking (spec section 4.8.5)
      // An array with N elements, where N is two times the number of color components.
      const val = this.image.transparency.greyscale;
      return this.obj.data['Mask'] = [val, val];
    } else if (this.image.transparency.rgb) {
      // Use Color Key Masking (spec section 4.8.5)
      // An array with N elements, where N is two times the number of color components.
      const rgb = this.image.transparency.rgb;

      const mask = [];
      for (let x of rgb) {
        mask.push(x, x);
      }

      return this.obj.data['Mask'] = mask;
    } else if (this.image.transparency.indexed) {
      // Create a transparency SMask for the image based on the data
      // in the PLTE and tRNS sections. See below for details on SMasks.
      return this.loadIndexedAlphaChannel();
    } else if (this.image.hasAlphaChannel) {
      // For PNG color types 4 and 6, the transparency data is stored as a alpha
      // channel mixed in with the main image data. Separate this data out into an
      // SMask object and store it separately in the PDF.
      return this.splitAlphaChannel();
    } else {
      return this.finalize();
    }
  }

  finalize() {
    if (this.alphaChannel) {
      const sMask = this.document.ref({
        Type: 'XObject',
        Subtype: 'Image',
        Height: this.height,
        Width: this.width,
        BitsPerComponent: 8,
        Filter: 'FlateDecode',
        ColorSpace: 'DeviceGray',
        Decode: [0, 1] });

      sMask.end(this.alphaChannel);
      this.obj.data['SMask'] = sMask;
    }

    // add the actual image data
    this.obj.end(this.imgData);

    // free memory
    this.image = null;
    return this.imgData = null;
  }

  splitAlphaChannel() {
    return this.image.decodePixels(pixels => {
      let a, p;
      const colorByteSize = this.image.colors * this.image.bits / 8;
      const pixelCount = this.width * this.height;
      const imgData = new Buffer(pixelCount * colorByteSize);
      const alphaChannel = new Buffer(pixelCount);

      let i = p = a = 0;
      const len = pixels.length;
      while (i < len) {
        imgData[p++] = pixels[i++];
        imgData[p++] = pixels[i++];
        imgData[p++] = pixels[i++];
        alphaChannel[a++] = pixels[i++];
      }

      let done = 0;
      zlib.deflate(imgData, (err, imgData1) => {
        this.imgData = imgData1;
        if (err) {
          throw err;
        }
        if (++done === 2) {
          return this.finalize();
        }
      });

      return zlib.deflate(alphaChannel, (err, alphaChannel1) => {
        this.alphaChannel = alphaChannel1;
        if (err) {
          throw err;
        }
        if (++done === 2) {
          return this.finalize();
        }
      });
    });
  }

  loadIndexedAlphaChannel(fn) {
    const transparency = this.image.transparency.indexed;
    return this.image.decodePixels(pixels => {
      const alphaChannel = new Buffer(this.width * this.height);

      let i = 0;
      for (let j = 0, end = pixels.length; j < end; j++) {
        alphaChannel[i++] = transparency[pixels[j]];
      }

      return zlib.deflate(alphaChannel, (err, alphaChannel1) => {
        this.alphaChannel = alphaChannel1;
        if (err) {
          throw err;
        }
        return this.finalize();
      });
    });
  }
}

/*
PDFImage - embeds images in PDF documents
By Devon Govett
*/

class PDFImage {
  static open(src, label) {
    let data;
    if (Buffer.isBuffer(src)) {
      data = src;
    } else if (src instanceof ArrayBuffer) {
      data = new Buffer(new Uint8Array(src));
    } else {
      let match;
      if (match = /^data:.+;base64,(.*)$/.exec(src)) {
        data = new Buffer(match[1], 'base64');
      } else {
        data = fs.readFileSync(src);
        if (!data) {
          return;
        }
      }
    }

    if (data[0] === 0xff && data[1] === 0xd8) {
      return new JPEG(data, label);
    } else if (data[0] === 0x89 && data.toString('ascii', 1, 4) === 'PNG') {
      return new PNGImage(data, label);
    } else {
      throw new Error('Unknown image format.');
    }
  }
}

var ImagesMixin = {
  initImages() {
    this._imageRegistry = {};
    return this._imageCount = 0;
  },

  image(src, x, y, options) {
    let bh, bp, bw, image, ip, left, left1;
    if (options == null) {
      options = {};
    }
    if (typeof x === 'object') {
      options = x;
      x = null;
    }

    x = (left = x != null ? x : options.x) != null ? left : this.x;
    y = (left1 = y != null ? y : options.y) != null ? left1 : this.y;

    if (typeof src === 'string') {
      image = this._imageRegistry[src];
    }

    if (!image) {
      if (src.width && src.height) {
        image = src;
      } else {
        image = this.openImage(src);
      }
    }

    if (!image.obj) {
      image.embed(this);
    }

    if (this.page.xobjects[image.label] == null) {
      this.page.xobjects[image.label] = image.obj;
    }

    let w = options.width || image.width;
    let h = options.height || image.height;

    if (options.width && !options.height) {
      const wp = w / image.width;
      w = image.width * wp;
      h = image.height * wp;
    } else if (options.height && !options.width) {
      const hp = h / image.height;
      w = image.width * hp;
      h = image.height * hp;
    } else if (options.scale) {
      w = image.width * options.scale;
      h = image.height * options.scale;
    } else if (options.fit) {
      var _options$fit = slicedToArray(options.fit, 2);

      bw = _options$fit[0];
      bh = _options$fit[1];

      bp = bw / bh;
      ip = image.width / image.height;
      if (ip > bp) {
        w = bw;
        h = bw / ip;
      } else {
        h = bh;
        w = bh * ip;
      }
    } else if (options.cover) {
      var _options$cover = slicedToArray(options.cover, 2);

      bw = _options$cover[0];
      bh = _options$cover[1];

      bp = bw / bh;
      ip = image.width / image.height;
      if (ip > bp) {
        h = bh;
        w = bh * ip;
      } else {
        w = bw;
        h = bw / ip;
      }
    }

    if (options.fit || options.cover) {
      if (options.align === 'center') {
        x = x + bw / 2 - w / 2;
      } else if (options.align === 'right') {
        x = x + bw - w;
      }

      if (options.valign === 'center') {
        y = y + bh / 2 - h / 2;
      } else if (options.valign === 'bottom') {
        y = y + bh - h;
      }
    }

    // Set the current y position to below the image if it is in the document flow      
    if (this.y === y) {
      this.y += h;
    }

    this.save();
    this.transform(w, 0, 0, -h, x, y + h);
    this.addContent(`/${image.label} Do`);
    this.restore();

    return this;
  },

  openImage(src) {
    let image;
    if (typeof src === 'string') {
      image = this._imageRegistry[src];
    }

    if (!image) {
      image = PDFImage.open(src, `I${++this._imageCount}`);
      if (typeof src === 'string') {
        this._imageRegistry[src] = image;
      }
    }

    return image;
  }
};

var AnnotationsMixin = {
  annotate(x, y, w, h, options) {
    options.Type = 'Annot';
    options.Rect = this._convertRect(x, y, w, h);
    options.Border = [0, 0, 0];
    if (options.Subtype !== 'Link') {
      if (options.C == null) {
        options.C = this._normalizeColor(options.color || [0, 0, 0]);
      }
    } // convert colors
    delete options.color;

    if (typeof options.Dest === 'string') {
      options.Dest = new String(options.Dest);
    }

    // Capitalize keys  
    for (let key in options) {
      const val = options[key];
      options[key[0].toUpperCase() + key.slice(1)] = val;
    }

    const ref = this.ref(options);
    this.page.annotations.push(ref);
    ref.end();
    return this;
  },

  note(x, y, w, h, contents, options) {
    if (options == null) {
      options = {};
    }
    options.Subtype = 'Text';
    options.Contents = new String(contents);
    options.Name = 'Comment';
    if (options.color == null) {
      options.color = [243, 223, 92];
    }
    return this.annotate(x, y, w, h, options);
  },

  link(x, y, w, h, url, options) {
    if (options == null) {
      options = {};
    }
    options.Subtype = 'Link';

    if (typeof url === 'number') {
      // Link to a page in the document (the page must already exist)
      const pages = this._root.data.Pages.data;
      if (url >= 0 && url < pages.Kids.length) {
        options.A = this.ref({
          S: 'GoTo',
          D: [pages.Kids[url], 'XYZ', null, null, null] });
        options.A.end();
      } else {
        throw new Error(`The document has no page ${url}`);
      }
    } else {
      // Link to an external url
      options.A = this.ref({
        S: 'URI',
        URI: new String(url)
      });
      options.A.end();
    }

    return this.annotate(x, y, w, h, options);
  },

  _markup(x, y, w, h, options) {
    if (options == null) {
      options = {};
    }

    var _convertRect = this._convertRect(x, y, w, h),
        _convertRect2 = slicedToArray(_convertRect, 4);

    const x1 = _convertRect2[0],
          y1 = _convertRect2[1],
          x2 = _convertRect2[2],
          y2 = _convertRect2[3];

    options.QuadPoints = [x1, y2, x2, y2, x1, y1, x2, y1];
    options.Contents = new String();
    return this.annotate(x, y, w, h, options);
  },

  highlight(x, y, w, h, options) {
    if (options == null) {
      options = {};
    }
    options.Subtype = 'Highlight';
    if (options.color == null) {
      options.color = [241, 238, 148];
    }
    return this._markup(x, y, w, h, options);
  },

  underline(x, y, w, h, options) {
    if (options == null) {
      options = {};
    }
    options.Subtype = 'Underline';
    return this._markup(x, y, w, h, options);
  },

  strike(x, y, w, h, options) {
    if (options == null) {
      options = {};
    }
    options.Subtype = 'StrikeOut';
    return this._markup(x, y, w, h, options);
  },

  lineAnnotation(x1, y1, x2, y2, options) {
    if (options == null) {
      options = {};
    }
    options.Subtype = 'Line';
    options.Contents = new String();
    options.L = [x1, this.page.height - y1, x2, this.page.height - y2];
    return this.annotate(x1, y1, x2, y2, options);
  },

  rectAnnotation(x, y, w, h, options) {
    if (options == null) {
      options = {};
    }
    options.Subtype = 'Square';
    options.Contents = new String();
    return this.annotate(x, y, w, h, options);
  },

  ellipseAnnotation(x, y, w, h, options) {
    if (options == null) {
      options = {};
    }
    options.Subtype = 'Circle';
    options.Contents = new String();
    return this.annotate(x, y, w, h, options);
  },

  textAnnotation(x, y, w, h, text, options) {
    if (options == null) {
      options = {};
    }
    options.Subtype = 'FreeText';
    options.Contents = new String(text);
    options.DA = new String();
    return this.annotate(x, y, w, h, options);
  },

  _convertRect(x1, y1, w, h) {
    // flip y1 and y2
    let y2 = y1;
    y1 += h;

    // make x2
    let x2 = x1 + w;

    // apply current transformation matrix to points

    var _ctm = slicedToArray(this._ctm, 6);

    const m0 = _ctm[0],
          m1 = _ctm[1],
          m2 = _ctm[2],
          m3 = _ctm[3],
          m4 = _ctm[4],
          m5 = _ctm[5];

    x1 = m0 * x1 + m2 * y1 + m4;
    y1 = m1 * x1 + m3 * y1 + m5;
    x2 = m0 * x2 + m2 * y2 + m4;
    y2 = m1 * x2 + m3 * y2 + m5;

    return [x1, y1, x2, y2];
  }
};

class PDFOutline {
  constructor(document, parent, title, dest, options) {
    this.document = document;
    if (options == null) {
      options = { expanded: false };
    }
    this.options = options;
    this.outlineData = {};

    if (dest !== null) {
      this.outlineData['Dest'] = [dest.dictionary, 'Fit'];
    }

    if (parent !== null) {
      this.outlineData['Parent'] = parent;
    }

    if (title !== null) {
      this.outlineData['Title'] = new String(title);
    }

    this.dictionary = this.document.ref(this.outlineData);
    this.children = [];
  }

  addItem(title, options) {
    if (options == null) {
      options = { expanded: false };
    }
    const result = new PDFOutline(this.document, this.dictionary, title, this.document.page, options);
    this.children.push(result);

    return result;
  }

  endOutline() {
    let end;
    if (this.children.length > 0) {
      let asc, i;
      if (this.options.expanded) {
        this.outlineData.Count = this.children.length;
      }

      const first = this.children[0],
            last = this.children[this.children.length - 1];
      this.outlineData.First = first.dictionary;
      this.outlineData.Last = last.dictionary;

      for (i = 0, end = this.children.length, asc = 0 <= end; asc ? i < end : i > end; asc ? i++ : i--) {
        const child = this.children[i];
        if (i > 0) {
          child.outlineData.Prev = this.children[i - 1].dictionary;
        }
        if (i < this.children.length - 1) {
          child.outlineData.Next = this.children[i + 1].dictionary;
        }
        child.endOutline();
      }
    }

    return this.dictionary.end();
  }
}

var OutlineMixin = {
    initOutline() {
        return this.outline = new PDFOutline(this, null, null, null);
    },

    endOutline() {
        this.outline.endOutline();
        if (this.outline.children.length > 0) {
            this._root.data.Outlines = this.outline.dictionary;
            return this._root.data.PageMode = 'UseOutlines';
        }
    }
};

/*
PDFDocument - represents an entire PDF document
By Devon Govett
*/

class PDFDocument extends stream.Readable {
  constructor(options = {}) {
    super(options);
    this.options = options;

    // PDF version
    this.version = 1.3;

    // Whether streams should be compressed
    this.compress = this.options.compress != null ? this.options.compress : true;

    this._pageBuffer = [];
    this._pageBufferStart = 0;

    // The PDF object store
    this._offsets = [];
    this._waiting = 0;
    this._ended = false;
    this._offset = 0;
    const Pages = this.ref({
      Type: 'Pages',
      Count: 0,
      Kids: [] });

    Pages.finalize = function () {
      this.offset = this.document._offset;
      this.document._write(this.id + " " + this.gen + " obj");
      this.document._write('<<');
      this.document._write('/Type /Pages');
      this.document._write(`/Count ${this.data.Count}`);
      this.document._write(`/Kids [${Buffer.concat(this.data.Kids).slice(0, -1).toString()}]`);
      this.document._write('>>');
      this.document._write('endobj');
      return this.document._refEnd(this);
    };

    this._root = this.ref({
      Type: 'Catalog',
      Pages
    });

    // The current page
    this.page = null;

    // Initialize mixins
    this.initColor();
    this.initVector();
    this.initFonts();
    this.initText();
    this.initImages();
    this.initOutline();

    // Initialize the metadata
    this.info = {
      Producer: 'PDFKit',
      Creator: 'PDFKit',
      CreationDate: new Date()
    };

    if (this.options.info) {
      for (let key in this.options.info) {
        const val = this.options.info[key];
        this.info[key] = val;
      }
    }

    // Write the header
    // PDF version
    this._write(`%PDF-${this.version}`);

    // 4 binary chars, as recommended by the spec
    this._write("%\xFF\xFF\xFF\xFF");

    // Add the first page
    if (this.options.autoFirstPage !== false) {
      this.addPage();
    }
  }

  addPage(options) {
    // end the current page if needed
    if (options == null) {
      options = this.options;
    }
    if (!this.options.bufferPages) {
      this.flushPages();
    }

    // create a page object
    this.page = new PDFPage(this, options);
    this._pageBuffer.push(this.page);

    // add the page to the object store
    const pages = this._root.data.Pages.data;
    pages.Kids.push(new Buffer(this.page.dictionary + ' '));
    pages.Count++;

    // reset x and y coordinates
    this.x = this.page.margins.left;
    this.y = this.page.margins.top;

    // flip PDF coordinate system so that the origin is in
    // the top left rather than the bottom left
    this._ctm = [1, 0, 0, 1, 0, 0];
    this.transform(1, 0, 0, -1, 0, this.page.height);

    this.emit('pageAdded');

    return this;
  }

  bufferedPageRange() {
    return { start: this._pageBufferStart, count: this._pageBuffer.length };
  }

  switchToPage(n) {
    let page;
    if (!(page = this._pageBuffer[n - this._pageBufferStart])) {
      throw new Error(`switchToPage(${n}) out of bounds, current buffer covers pages ${this._pageBufferStart} to ${this._pageBufferStart + this._pageBuffer.length - 1}`);
    }

    return this.page = page;
  }

  flushPages() {
    // this local variable exists so we're future-proof against
    // reentrant calls to flushPages.
    const pages = this._pageBuffer;
    this._pageBuffer = [];
    this._pageBufferStart += pages.length;
    for (let page of pages) {
      page.end();
    }
  }

  ref(data) {
    const ref = new PDFReference(this, this._offsets.length + 1, data);
    this._offsets.push(null); // placeholder for this object's offset once it is finalized
    this._waiting++;
    return ref;
  }

  _read() {}
  // do nothing, but this method is required by node

  _write(data) {
    if (!Buffer.isBuffer(data)) {
      data = new Buffer(data + '\n', 'binary');
    }

    this.push(data);
    return this._offset += data.length;
  }

  addContent(data) {
    this.page.write(data);
    return this;
  }

  _refEnd(ref) {
    this._offsets[ref.id - 1] = ref.offset;
    if (--this._waiting === 0 && this._ended) {
      this._finalize();
      return this._ended = false;
    }
  }

  write(filename, fn) {
    // print a deprecation warning with a stacktrace
    const err = new Error(`\
PDFDocument#write is deprecated, and will be removed in a future version of PDFKit. \
Please pipe the document into a Node stream.\
`);

    console.warn(err.stack);

    this.pipe(fs.createWriteStream(filename));
    this.end();
    return this.once('end', fn);
  }

  output(fn) {
    // more difficult to support this. It would involve concatenating all the buffers together
    throw new Error(`\
PDFDocument#output is deprecated, and has been removed from PDFKit. \
Please pipe the document into a Node stream.\
`);
  }

  end() {
    this.flushPages();
    this._info = this.ref();
    for (let key in this.info) {
      let val = this.info[key];
      if (typeof val === 'string') {
        val = new String(val);
      }

      this._info.data[key] = val;
    }

    this._info.end();

    for (let name in this._fontFamilies) {
      const font = this._fontFamilies[name];
      font.finalize();
    }

    this.endOutline();

    this._root.end();
    this._root.data.Pages.end();

    if (this._waiting === 0) {
      return this._finalize();
    } else {
      return this._ended = true;
    }
  }

  _finalize(fn) {
    // generate xref
    const xRefOffset = this._offset;
    this._write("xref");
    this._write(`0 ${this._offsets.length + 1}`);
    this._write("0000000000 65535 f ");

    for (let offset of this._offsets) {
      offset = `0000000000${offset}`.slice(-10);
      this._write(offset + ' 00000 n ');
    }

    // trailer
    this._write('trailer');
    this._write(PDFObject.convert({
      Size: this._offsets.length + 1,
      Root: this._root,
      Info: this._info
    }));

    this._write('startxref');
    this._write(`${xRefOffset}`);
    this._write('%%EOF');

    // end the stream
    return this.push(null);
  }

  toString() {
    return "[object PDFDocument]";
  }
}
const mixin = methods => {
  Object.assign(PDFDocument.prototype, methods);
};

mixin(ColorMixin);
mixin(VectorMixin);
mixin(FontsMixin);
mixin(TextMixin);
mixin(ImagesMixin);
mixin(AnnotationsMixin);
mixin(OutlineMixin);

export default PDFDocument;
//# sourceMappingURL=pdfkit.esnext.js.map
