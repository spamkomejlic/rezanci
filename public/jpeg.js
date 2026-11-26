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

// A copy of a photo file that holds the picture and nothing about the phone, the place or the time.
// A camera writes much more than the picture into the file: the phone model, the lens, the place (GPS), the time,
// serial numbers, a small copy of the picture, and often more data after the end marker. Only this copy goes to the archive.
// Kept: the tables, the frame and the image data, byte for byte, so the picture does not change. Also the color
// profile and the Adobe color mark, which a reader needs to show the right colors, and one value of the camera
// record: the turn of the picture (orientation), written again as a record with this one value.
// Dropped: each other record and comment, and all bytes after the end marker.
// Returns null if the data is not a complete JPEG: the end marker must come after the image data.
// A copy of a copy is the same file, so the name of the photo (its SHA-256) is stable.
export function jpegClean(buf) {
  const b = new Uint8Array(buf), n = b.length;
  if (n < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;
  const starts = (at, text) => [...text].every((c, i) => b[at + i] === c.charCodeAt(0));
  const parts = [];                                            // ranges of the file that go into the copy
  let turn = 1, hadData = false, o = 2;
  while (o + 1 < n) {
    if (b[o] !== 0xFF) return null;
    const m = b[o + 1];
    if (m === 0xFF) { o++; continue; }                         // fill byte before a marker
    if (m === 0xD9) {                                          // end marker
      if (!hadData) return null;
      // Record with one value, the turn of the picture. Not needed for a picture that is not turned.
      const record = turn >= 2 && turn <= 8
        ? [0xFF, 0xE1, 0, 34, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4D, 0x4D, 0, 42, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, turn, 0, 0, 0, 0, 0, 0] : [];
      const out = new Uint8Array(2 + record.length + parts.reduce((sum, [from, to]) => sum + to - from, 0) + 2);
      out.set([0xFF, 0xD8, ...record]);
      let at = 2 + record.length;
      for (const [from, to] of parts) { out.set(b.subarray(from, to), at); at += to - from; }
      out.set([0xFF, 0xD9], at);
      return out;
    }
    if (o + 3 >= n) return null;
    let end = o + 2 + ((b[o + 2] << 8) | b[o + 3]);            // each other part states its length
    if (end > n) return null;
    if (m === 0xDA) {
      // Image data runs to the next marker. FF00 is a data byte, FFD0 to FFD7 are restart marks, FFFF is fill.
      for (;;) {
        const at = b.indexOf(0xFF, end);
        if (at < 0 || at + 1 >= n) return null;
        const next = b[at + 1];
        if (next === 0x00 || (next >= 0xD0 && next <= 0xD7)) end = at + 2;
        else if (next === 0xFF) end = at + 1;
        else { end = at; break; }
      }
      hadData = true;
    }
    if (m === 0xE1 && starts(o + 4, 'Exif')) {
      try {                                                    // turn of the picture: tag 0x0112 of the first directory
        const v = new DataView(b.buffer, b.byteOffset, n), t = o + 10, le = v.getUint16(t) === 0x4949, ifd = t + v.getUint32(t + 4, le);
        for (let i = 0, count = v.getUint16(ifd, le); i < count; i++)
          if (v.getUint16(ifd + 2 + i * 12, le) === 0x0112) turn = v.getUint16(ifd + 10 + i * 12, le);
      } catch { /* damaged record: the picture counts as not turned */ }
    }
    // Records of the camera (APP0 to APP15) and comments stay out, but for the two that hold color data.
    const record = (m >= 0xE0 && m <= 0xEF) || m === 0xFE;
    if (!record || (m === 0xE2 && starts(o + 4, 'ICC_PROFILE')) || (m === 0xEE && starts(o + 4, 'Adobe'))) parts.push([o, end]);
    o = end;
  }
  return null;
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

// The capture time of exifTime() ("2026:11:26 10:15:30", clock of the phone) as milliseconds, or NaN if there is none.
export function localTime(text) {
  const m = /^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)$/.exec(text ?? '');
  return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : NaN;
}

// SHA-256 of the file as lower-case hex. This value is the name of the image in the archive.
export async function sha256Hex(buf) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
  return Array.from(d, b => b.toString(16).padStart(2, '0')).join('');
}
