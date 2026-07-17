// Polyfills for React Native (Hermes) environment to support standard web APIs
// required by cryptography and secure socket transport functions.

if (typeof global.TextEncoder === 'undefined') {
  class TextEncoder {
    encode(str: string): Uint8Array {
      const utf8 = [];
      for (let i = 0; i < str.length; i++) {
        let charcode = str.charCodeAt(i);
        if (charcode < 0x80) {
          utf8.push(charcode);
        } else if (charcode < 0x800) {
          utf8.push(0xc0 | (charcode >> 6), 0x80 | (charcode & 0x3f));
        } else if (charcode < 0xd800 || charcode >= 0xe000) {
          utf8.push(
            0xe0 | (charcode >> 12),
            0x80 | ((charcode >> 6) & 0x3f),
            0x80 | (charcode & 0x3f)
          );
        } else {
          i++;
          charcode = 0x10000 + (((charcode & 0x3ff) << 10) | (str.charCodeAt(i) & 0x3ff));
          utf8.push(
            0xf0 | (charcode >> 18),
            0x80 | ((charcode >> 12) & 0x3f),
            0x80 | ((charcode >> 6) & 0x3f),
            0x80 | (charcode & 0x3f)
          );
        }
      }
      return new Uint8Array(utf8);
    }
  }
  global.TextEncoder = TextEncoder as any;
}

if (typeof global.TextDecoder === 'undefined') {
  class TextDecoder {
    decode(bytes?: Uint8Array | null): string {
      if (!bytes) return '';
      let out = '', i = 0;
      const len = bytes.length;
      while (i < len) {
        const c = bytes[i++];
        if (c < 0x80) {
          out += String.fromCharCode(c);
        } else if (c > 0xbf && c < 0xe0) {
          const char2 = bytes[i++];
          out += String.fromCharCode(((c & 0x1f) << 6) | (char2 & 0x3f));
        } else if (c > 0xdf && c < 0xf0) {
          const char2 = bytes[i++];
          const char3 = bytes[i++];
          out += String.fromCharCode(
            ((c & 0x0f) << 12) | ((char2 & 0x3f) << 6) | (char3 & 0x3f)
          );
        } else {
          const char2 = bytes[i++];
          const char3 = bytes[i++];
          const char4 = bytes[i++];
          let codepoint =
            ((c & 0x07) << 18) |
            ((char2 & 0x3f) << 12) |
            ((char3 & 0x3f) << 6) |
            (char4 & 0x3f);
          codepoint -= 0x10000;
          out += String.fromCharCode(
            0xd800 + (codepoint >> 10),
            0xdc00 + (codepoint & 0x3ff)
          );
        }
      }
      return out;
    }
  }
  global.TextDecoder = TextDecoder as any;
}

if (typeof global.btoa === 'undefined') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  global.btoa = function (str: string): string {
    let output = '';
    const len = str.length;
    for (let i = 0; i < len; i += 3) {
      const c1 = str.charCodeAt(i);
      const c2 = i + 1 < len ? str.charCodeAt(i + 1) : NaN;
      const c3 = i + 2 < len ? str.charCodeAt(i + 2) : NaN;

      const byte1 = c1 >> 2;
      const byte2 = ((c1 & 3) << 4) | (isNaN(c2) ? 0 : c2 >> 4);
      const byte3 = isNaN(c2) ? 64 : ((c2 & 15) << 2) | (isNaN(c3) ? 0 : c3 >> 6);
      const byte4 = isNaN(c3) ? 64 : c3 & 63;

      output += chars.charAt(byte1) + chars.charAt(byte2) + 
                (byte3 === 64 ? '=' : chars.charAt(byte3)) + 
                (byte4 === 64 ? '=' : chars.charAt(byte4));
    }
    return output;
  };
}

if (typeof global.atob === 'undefined') {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  // Pre-compute lookup table for high-performance decoding
  const lookup = new Uint8Array(256);
  for (let i = 0; i < chars.length; i++) {
    lookup[chars.charCodeAt(i)] = i;
  }

  global.atob = function (input: string): string {
    const str = input.replace(/=+$/, '');
    const len = str.length;
    if (len % 4 === 1) {
      throw new Error("'atob' failed: The string to be decoded is not correctly encoded.");
    }
    
    let output = '';
    for (let i = 0; i < len; i += 4) {
      const w1 = lookup[str.charCodeAt(i)];
      const w2 = i + 1 < len ? lookup[str.charCodeAt(i + 1)] : 0;
      const w3 = i + 2 < len ? lookup[str.charCodeAt(i + 2)] : 0;
      const w4 = i + 3 < len ? lookup[str.charCodeAt(i + 3)] : 0;

      const byte1 = (w1 << 2) | (w2 >> 4);
      const byte2 = ((w2 & 15) << 4) | (w3 >> 2);
      const byte3 = ((w3 & 3) << 6) | w4;

      output += String.fromCharCode(byte1);
      if (i + 2 < len) output += String.fromCharCode(byte2);
      if (i + 3 < len) output += String.fromCharCode(byte3);
    }
    return output;
  };
}

