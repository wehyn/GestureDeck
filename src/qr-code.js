const QR_VERSION = 5;
const QR_SIZE = 17 + QR_VERSION * 4;
const QUIET_ZONE = 4;
const DATA_CODEWORDS = 108;
const ECC_CODEWORDS = 26;
// The ECI and byte-mode headers leave room for 105 UTF-8 bytes in version 5-L.
const MAX_UTF8_BYTES = 105;
const FORMAT_GENERATOR = 0x537;
const FORMAT_MASK = 0x5412;

function appendBits(target, value, length) {
  for (let shift = length - 1; shift >= 0; shift -= 1) {
    target.push((value >>> shift) & 1);
  }
}

function multiplyInField(left, right) {
  let product = 0;
  for (let bit = 7; bit >= 0; bit -= 1) {
    product = (product << 1) ^ ((product >>> 7) * 0x11d);
    product ^= ((right >>> bit) & 1) * left;
  }
  return product;
}

function makeErrorCorrectionCodewords(data) {
  let generator = [1];
  let root = 1;
  for (let degree = 0; degree < ECC_CODEWORDS; degree += 1) {
    const next = Array(generator.length + 1).fill(0);
    for (let index = 0; index < generator.length; index += 1) {
      next[index] ^= generator[index];
      next[index + 1] ^= multiplyInField(generator[index], root);
    }
    generator = next;
    root = multiplyInField(root, 2);
  }

  const remainder = [...data, ...Array(ECC_CODEWORDS).fill(0)];
  for (let index = 0; index < data.length; index += 1) {
    const factor = remainder[index];
    if (factor === 0) continue;
    for (let offset = 0; offset < generator.length; offset += 1) {
      remainder[index + offset] ^= multiplyInField(generator[offset], factor);
    }
  }
  return remainder.slice(data.length);
}

function makeCodewords(text) {
  if (!isWellFormedUnicode(text)) {
    throw new TypeError('QR payload must be well-formed Unicode');
  }
  if (!isXml10LegalText(text)) {
    throw new TypeError('QR payload contains a character forbidden by XML 1.0');
  }
  const bytes = new TextEncoder().encode(text);
  if (bytes.length > MAX_UTF8_BYTES) {
    throw new RangeError(`QR payload exceeds the ${MAX_UTF8_BYTES}-byte capacity`);
  }

  const bits = [];
  // ECI assignment 26 declares UTF-8 so readers decode non-ASCII input correctly.
  appendBits(bits, 0b0111, 4);
  appendBits(bits, 26, 8);
  // A fixed version 5-L symbol uses an 8-bit byte count field.
  appendBits(bits, 0b0100, 4);
  appendBits(bits, bytes.length, 8);
  for (const byte of bytes) appendBits(bits, byte, 8);

  const dataBitCapacity = DATA_CODEWORDS * 8;
  const terminatorLength = Math.min(4, dataBitCapacity - bits.length);
  for (let index = 0; index < terminatorLength; index += 1) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const data = [];
  for (let index = 0; index < bits.length; index += 8) {
    let codeword = 0;
    for (let bit = 0; bit < 8; bit += 1) codeword = (codeword << 1) | bits[index + bit];
    data.push(codeword);
  }
  for (let pad = 0; data.length < DATA_CODEWORDS; pad += 1) {
    data.push(pad % 2 === 0 ? 0xec : 0x11);
  }

  return [...data, ...makeErrorCorrectionCodewords(data)];
}

function isWellFormedUnicode(text) {
  for (let index = 0; index < text.length; index += 1) {
    const codeUnit = text.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= text.length) return false;
      const next = text.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isXml10LegalText(text) {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    const isAllowed = codePoint === 0x9
      || codePoint === 0xa
      || codePoint === 0xd
      || (codePoint >= 0x20 && codePoint <= 0xd7ff)
      || (codePoint >= 0xe000 && codePoint <= 0xfffd)
      || (codePoint >= 0x10000 && codePoint <= 0x10ffff);
    if (!isAllowed) return false;
  }
  return true;
}

function setFunctionModule(matrix, x, y, dark) {
  matrix[y][x] = dark;
}

function drawFinderPattern(matrix, centerX, centerY) {
  for (let y = -4; y <= 4; y += 1) {
    for (let x = -4; x <= 4; x += 1) {
      const moduleX = centerX + x;
      const moduleY = centerY + y;
      if (moduleX < 0 || moduleY < 0 || moduleX >= matrix.length || moduleY >= matrix.length) continue;
      const distance = Math.max(Math.abs(x), Math.abs(y));
      setFunctionModule(matrix, moduleX, moduleY, distance !== 2 && distance !== 4);
    }
  }
}

function drawAlignmentPattern(matrix, centerX, centerY) {
  for (let y = -2; y <= 2; y += 1) {
    for (let x = -2; x <= 2; x += 1) {
      const distance = Math.max(Math.abs(x), Math.abs(y));
      setFunctionModule(matrix, centerX + x, centerY + y, distance !== 1);
    }
  }
}

function formatInformation() {
  // QR mask 0 is fixed for reproducible output; L has format bits 01.
  const data = (0b01 << 3) | 0;
  let remainder = data << 10;
  for (let bit = 14; bit >= 10; bit -= 1) {
    if (((remainder >>> bit) & 1) !== 0) remainder ^= FORMAT_GENERATOR << (bit - 10);
  }
  return ((data << 10) | remainder) ^ FORMAT_MASK;
}

function formatCoordinates(size) {
  const first = [];
  const second = [];
  for (let index = 0; index <= 5; index += 1) first.push([8, index]);
  first.push([8, 7], [8, 8], [7, 8]);
  for (let index = 9; index < 15; index += 1) first.push([14 - index, 8]);

  for (let index = 0; index < 8; index += 1) second.push([size - 1 - index, 8]);
  for (let index = 8; index < 15; index += 1) second.push([8, size - 15 + index]);
  return [first, second];
}

function drawFunctionPatterns(matrix) {
  const size = matrix.length;
  drawFinderPattern(matrix, 3, 3);
  drawFinderPattern(matrix, size - 4, 3);
  drawFinderPattern(matrix, 3, size - 4);

  for (let index = 8; index < size - 8; index += 1) {
    const dark = index % 2 === 0;
    setFunctionModule(matrix, 6, index, dark);
    setFunctionModule(matrix, index, 6, dark);
  }
  drawAlignmentPattern(matrix, 30, 30);

  for (const coordinates of formatCoordinates(size)) {
    for (const [x, y] of coordinates) setFunctionModule(matrix, x, y, false);
  }
  setFunctionModule(matrix, 8, size - 8, true);
}

function placeData(matrix, codewords) {
  const bits = [];
  for (const codeword of codewords) appendBits(bits, codeword, 8);

  let bitIndex = 0;
  let upward = true;
  for (let right = matrix.length - 1; right >= 1; right -= 2) {
    if (right === 6) right -= 1;
    for (let vertical = 0; vertical < matrix.length; vertical += 1) {
      const y = upward ? matrix.length - 1 - vertical : vertical;
      for (let offset = 0; offset < 2; offset += 1) {
        const x = right - offset;
        if (matrix[y][x] !== null) continue;

        let dark = bits[bitIndex] === 1;
        bitIndex += 1;
        // Fixed QR mask pattern 0: invert data/remainder modules when x + y is even.
        if ((x + y) % 2 === 0) dark = !dark;
        matrix[y][x] = dark;
      }
    }
    upward = !upward;
  }
}

function drawFormatPatterns(matrix) {
  const bits = formatInformation();
  for (const coordinates of formatCoordinates(matrix.length)) {
    for (let index = 0; index < coordinates.length; index += 1) {
      const [x, y] = coordinates[index];
      matrix[y][x] = ((bits >>> index) & 1) !== 0;
    }
  }
  matrix[matrix.length - 8][8] = true;
}

function escapeXml(text) {
  return text.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&apos;',
  })[character]);
}

function encodeQr(text) {
  if (typeof text !== 'string') throw new TypeError('QR payload must be a string');

  const matrix = Array.from({ length: QR_SIZE }, () => Array(QR_SIZE).fill(null));
  drawFunctionPatterns(matrix);
  placeData(matrix, makeCodewords(text));
  drawFormatPatterns(matrix);
  return matrix;
}

/**
 * Create a self-contained version 5, error-correction-L QR SVG for UTF-8 text.
 * Mask pattern 0 is fixed to make the output deterministic; the SVG adds a
 * standards-sized four-module quiet zone around the symbol.
 */
export function createQrSvg(text) {
  const matrix = encodeQr(text);
  const svgSize = QR_SIZE + QUIET_ZONE * 2;
  const path = [];
  for (let y = 0; y < QR_SIZE; y += 1) {
    for (let x = 0; x < QR_SIZE; x += 1) {
      if (matrix[y][x]) path.push(`M${x + QUIET_ZONE} ${y + QUIET_ZONE}h1v1h-1z`);
    }
  }
  const title = escapeXml(text);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgSize}" height="${svgSize}" viewBox="0 0 ${svgSize} ${svgSize}" role="img"><title>${title}</title><rect width="100%" height="100%" fill="#fff"/><path fill="#000" shape-rendering="crispEdges" d="${path.join('')}"/></svg>`;
}

/** Create a base64 data URL for use as an image source. */
export function createQrDataUrl(text) {
  const bytes = new TextEncoder().encode(createQrSvg(text));
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return `data:image/svg+xml;base64,${globalThis.btoa(binary)}`;
}
