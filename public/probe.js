const $ = id => document.getElementById(id);
const log = s => { $('out').textContent += s + '\n'; };
const mp = (w, h) => `${w}x${h} = ${(w * h / 1e6).toFixed(1)} MP`;
// Async wrapper: f starts inside the tap handler (browsers require that for camera and clipboard),
// and a thrown error goes to the results instead of the console.
const run = f => (async () => f())().catch(e => log(`ERROR ${e.name}: ${e.message}`));

// Reads width and height from the JPEG frame header. No decode, so a 50 MP file costs no image memory.
function jpegSize(buf) {
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

// Self-check: SOI, APP0 (length 4), SOF0 with height 6120 and width 8160.
console.assert((s => s && s.w === 8160 && s.h === 6120)(jpegSize(new Uint8Array(
  [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8, 0x17, 0xE8, 0x1F, 0xE0, 3, 0, 0, 0]).buffer)),
  'jpegSize self-check failed');

// Reads the capture time (EXIF DateTimeOriginal) from a JPEG. An import path needs it to link a photo to a session.
function exifTime(buf) {
  const v = new DataView(buf);
  if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return null;
  let o = 2;
  while (o + 4 < v.byteLength && v.getUint8(o) === 0xFF) {
    const m = v.getUint8(o + 1);
    if (m === 0xDA) return null;                                     // image data starts, no EXIF block found
    if (m === 0xE1 && v.getUint32(o + 4) === 0x45786966) {           // APP1 segment that starts with "Exif"
      const t = o + 10, le = v.getUint16(t) === 0x4949;              // TIFF header and its byte order
      const u16 = p => v.getUint16(p, le), u32 = p => v.getUint32(p, le);
      const find = (ifd, tag) => {                                   // position of the value field of one tag
        for (let i = 0, n = u16(ifd); i < n; i++) if (u16(ifd + 2 + i * 12) === tag) return ifd + 10 + i * 12;
        return 0;
      };
      const sub = find(t + u32(t + 4), 0x8769);                      // pointer to the Exif directory
      const dt = sub && find(t + u32(sub), 0x9003);                  // DateTimeOriginal, 19 characters
      return dt ? new TextDecoder().decode(new Uint8Array(buf, t + u32(dt), 19)) : null;
    }
    o += 2 + v.getUint16(o + 2);
  }
  return null;
}

// Self-check: smallest JPEG start with an EXIF block that holds one capture time.
console.assert(exifTime(new Uint8Array(('FFD8FFE1004845786966000049492A00080000000100' +
  '69870400010000001A0000000000000001000390020014000000' + '2C00000000000000' +
  '323032363A31313A32352031303A30303A303000').match(/../g).map(h => parseInt(h, 16))).buffer) === '2026:11:25 10:00:00',
  'exifTime self-check failed');

// Fallback for formats other than JPEG (HEIC, PNG): the browser decodes the image.
function imgSize(blob) {
  return new Promise((res, rej) => {
    const url = URL.createObjectURL(blob), im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); res({ w: im.naturalWidth, h: im.naturalHeight }); };
    im.onerror = () => { URL.revokeObjectURL(url); rej(new Error('browser cannot decode this image')); };
    im.src = url;
  });
}

async function report(label, blob) {
  const buf = await blob.arrayBuffer();
  let how = 'jpeg header', s = jpegSize(buf);
  if (!s) { how = 'decode'; s = await imgSize(blob).catch(() => null); }
  let taken = null;
  try { taken = exifTime(buf); } catch (e) { /* damaged EXIF block: report no time */ }
  log(`${label}: ${s ? mp(s.w, s.h) : 'size unknown'}, ${blob.type || 'type unknown'}, ` +
      `${(blob.size / 1048576).toFixed(1)} MB, taken ${taken || 'no EXIF time'} (${how})`);
}

for (const [id, label] of [['t1', 'Test 1 system camera'], ['t2', 'Test 2 gallery']])
  $(id).onchange = e => run(async () => {
    const files = [...e.target.files];   // one file at a time, so memory use stays at one photo
    for (const [i, f] of files.entries()) await report(files.length > 1 ? `${label} ${i + 1}/${files.length}` : label, f);
  });

// Test 4: can the page find new photos in the camera folder with no manual selection?
$('dir').onclick = () => run(async () => {
  if (!window.showDirectoryPicker) return log('Test 4: folder access is not in this browser');
  const dir = await showDirectoryPicker({ mode: 'read' });
  let t0 = performance.now();
  const handles = [];
  for await (const h of dir.values()) if (h.kind === 'file' && /\.(jpe?g|heic|heif)$/i.test(h.name)) handles.push(h);
  log(`Test 4 folder: ${handles.length} photo files listed in ${Math.round(performance.now() - t0)} ms`);
  t0 = performance.now();
  const files = [];
  for (const h of handles) {
    files.push(await h.getFile());
    if (files.length % 500 === 0) log(`  ${files.length} file times read, ${Math.round(performance.now() - t0)} ms`);
  }
  log(`  all file times read in ${Math.round(performance.now() - t0)} ms`);
  files.sort((a, b) => b.lastModified - a.lastModified);
  for (const [i, f] of files.slice(0, 3).entries()) await report(`Test 4 newest ${i + 1}`, f);
});

let track;
async function openCam(deviceId) {
  if (!navigator.mediaDevices) throw new Error('camera API not available, the page needs HTTPS');
  if (track) track.stop();
  const size = { width: { ideal: 9999 }, height: { ideal: 9999 } };   // ask for the largest stream
  const stream = await navigator.mediaDevices.getUserMedia({
    video: deviceId ? { deviceId: { exact: deviceId }, ...size } : { facingMode: { ideal: 'environment' }, ...size } });
  track = stream.getVideoTracks()[0];
  $('v').srcObject = stream;
  await new Promise(r => { $('v').onloadedmetadata = r; });
  log(`Test 3 camera "${track.label}": video frame ${mp($('v').videoWidth, $('v').videoHeight)}`);
  const c = track.getCapabilities ? track.getCapabilities() : null;
  if (c && c.width) log(`  video capability max ${c.width.max}x${c.height.max}`);
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'videoinput');
  const current = track.getSettings().deviceId;
  $('cams').replaceChildren(...cams.map(d => new Option(d.label || d.deviceId, d.deviceId, false, d.deviceId === current)));
}

$('open').onclick = () => run(() => openCam());
$('cams').onchange = e => run(() => openCam(e.target.value));

$('shot').onclick = () => run(async () => {
  if (!track) return log('Test 3: open the camera first');
  if (!('ImageCapture' in window)) return log('Test 3 takePhoto: ImageCapture is not in this browser');
  const ic = new ImageCapture(track);
  const c = await ic.getPhotoCapabilities();
  const max = c.imageWidth && c.imageWidth.max ? { imageWidth: c.imageWidth.max, imageHeight: c.imageHeight.max } : null;
  log(max ? `  photo capability max ${max.imageWidth}x${max.imageHeight}` : '  photo capability: browser reports no size range');
  // Safari reports the video size as capability but selects from a separate photo size list,
  // so a direct 48 MP request can give more than the reported maximum.
  for (const [name, settings] of [['default', undefined], ['max', max], ['48 MP request', { imageWidth: 8064, imageHeight: 6048 }]]) {
    if (name === 'max' && !max) continue;
    try { await report(`Test 3 takePhoto ${name}`, await ic.takePhoto(settings)); }
    catch (e) { log(`Test 3 takePhoto ${name}: ERROR ${e.name}: ${e.message}`); }
  }
});

$('copy').onclick = () => run(async () => {
  if (!navigator.clipboard) throw new Error('clipboard not available, select the text and copy it');
  await navigator.clipboard.writeText($('out').textContent);
  log('(copied)');
});

log(navigator.userAgent);
log(`secure context: ${isSecureContext}, ImageCapture: ${'ImageCapture' in window}, ` +
    `screen ${screen.width}x${screen.height} @${devicePixelRatio}`);
