// Readers for JPEG files. They read header fields only, so a 50 MP file costs no image memory.

// Width and height from the JPEG frame header. Returns null if the data is not a JPEG.
export function jpegSize(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
  let o = 2;
  while (o + 9 < v.byteLength) {
    if (v.getUint8(o) !== 0xFF) return null;
    const m = v.getUint8(o + 1);
    if (m === 0xFF) { o++; continue; }                       // fill byte before a marker
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC)
      return { w: v.getUint16(o + 7), h: v.getUint16(o + 5) }; // SOFn frame header
    if (m === 0xDA || m === 0xD9) return null;               // image data starts, no frame header found
    o += 2 + v.getUint16(o + 2);
  }
  return null;
}

// True if the file holds the full image: the end marker comes after the image data.
// A phone can add its own data after the end marker, so the last bytes of the file are not the test.
export function jpegComplete(buf) {
  const b = new Uint8Array(buf), n = b.length;
  if (n < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return false;
  let o = 2, inData = false, hadData = false;
  while (o + 1 < n) {
    if (inData) {
      // Image data runs to the next marker. FF00 is a data byte, FFD0 to FFD7 are restart marks, FFFF is fill.
      const at = b.indexOf(0xFF, o);
      if (at < 0 || at + 1 >= n) return false;
      const m = b[at + 1];
      if (m === 0x00 || (m >= 0xD0 && m <= 0xD7)) o = at + 2;
      else if (m === 0xFF) o = at + 1;
      else { o = at; inData = false; }
      continue;
    }
    if (b[o] !== 0xFF) return false;
    const m = b[o + 1];
    if (m === 0xFF) { o++; continue; }
    if (m === 0xD9) return hadData;                            // end marker
    if (o + 3 >= n) return false;
    o += 2 + ((b[o + 2] << 8) | b[o + 3]);                     // each other part states its length
    if (m === 0xDA) inData = hadData = true;                   // image data follows this part
  }
  return false;
}

// Capture time (EXIF DateTimeOriginal) as "YYYY:MM:DD HH:MM:SS". Returns null if there is none.
export function exifTime(buf) {
  try {
    const v = new DataView(buf);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
    let o = 2;
    while (o + 4 < v.byteLength && v.getUint8(o) === 0xFF) {
      const m = v.getUint8(o + 1);
      if (m === 0xDA) return null;
      if (m === 0xE1 && v.getUint32(o + 4) === 0x45786966) {   // APP1 segment that starts with "Exif"
        const t = o + 10, le = v.getUint16(t) === 0x4949;      // TIFF header and its byte order
        const u16 = p => v.getUint16(p, le), u32 = p => v.getUint32(p, le);
        const find = (ifd, tag) => {                           // position of the value field of one tag
          for (let i = 0, n = u16(ifd); i < n; i++) if (u16(ifd + 2 + i * 12) === tag) return ifd + 10 + i * 12;
          return 0;
        };
        const sub = find(t + u32(t + 4), 0x8769);              // pointer to the Exif directory
        const dt = sub && find(t + u32(sub), 0x9003);          // DateTimeOriginal, 19 characters
        return dt ? new TextDecoder().decode(new Uint8Array(buf, t + u32(dt), 19)) : null;
      }
      o += 2 + v.getUint16(o + 2);
    }
    return null;
  } catch {
    return null;                                               // damaged EXIF block
  }
}

// SHA-256 of the file as lower-case hex. This value is the name of the image in the archive.
export async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}
