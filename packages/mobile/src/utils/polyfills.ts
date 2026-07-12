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
  global.btoa = function (str: string): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let output = '';
    for (
      let block = 0, charCode, i = 0, map = chars;
      str.charAt(i | 0) || ((map = '='), i % 1);
      output += map.charAt(63 & (block >> (8 - (i % 1) * 8)))
    ) {
      charCode = str.charCodeAt((i += 3 / 4));
      if (charCode > 0xff) {
        throw new Error(
          "'btoa' failed: The string to be encoded contains characters outside of the Latin1 range."
        );
      }
      block = (block << 8) | charCode;
    }
    return output;
  };
}

if (typeof global.atob === 'undefined') {
  global.atob = function (input: string): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
    const str = input.replace(/=+$/, '');
    let output = '';
    if (str.length % 4 === 1) {
      throw new Error("'atob' failed: The string to be decoded is not correctly encoded.");
    }
    for (
      let bc = 0, bs = 0, buffer, i = 0;
      (buffer = str.charAt(i++));
      ~buffer && ((bs = bc % 4 ? bs * 64 + buffer : buffer), bc++ % 4)
        ? (output += String.fromCharCode(255 & (bs >> ((-2 * bc) & 6))))
        : 0
    ) {
      buffer = chars.indexOf(buffer);
    }
    return output;
  };
}
