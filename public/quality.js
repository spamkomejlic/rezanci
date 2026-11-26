// Quality numbers of one photo: sharpness and exposure. The browser decodes the photo one time.
// This code then reads a small copy (exposure, and where the content is) and a few tiles at full size (sharpness).

const TILE = 512;      // edge of one full-size tile, in photo pixels
const TILES = 8;       // the tiles with the most content get a sharpness score
const SCALE = 16;      // the small copy has 1/16 of the photo size in each direction

const luma = (d, i) => (d[i] * 77 + d[i + 1] * 150 + d[i + 2] * 29) >> 8;

// Mean of the strongest 1 % of the values in a histogram with 256 bins.
function strongest(hist, total) {
  const need = Math.max(1, Math.round(total / 100));
  let sum = 0, used = 0;
  for (let v = 255; v >= 0 && used < need; v--) {
    const take = Math.min(hist[v], need - used);
    sum += take * v;
    used += take;
  }
  return sum / used;
}

// Sharpness of one square tile (RGBA bytes): the strength of its strongest edges, 0 to 255.
// The score uses the strongest edges only, so a tile with little content does not get a low score for that reason.
// Focus blur makes the edges weak in both directions. Motion blur makes them weak in one direction.
// The weaker direction is the score, so both show.
export function tileSharpness(data, size) {
  const l = new Uint8Array(size * size);
  for (let i = 0; i < l.length; i++) l[i] = luma(data, i * 4);
  const across = new Uint32Array(256), down = new Uint32Array(256);
  for (let y = 1; y < size - 1; y++)
    for (let x = 1, i = y * size + 1; x < size - 1; x++, i++) {
      across[Math.abs(l[i + 1] - l[i - 1])]++;
      down[Math.abs(l[i + size] - l[i - size])]++;
    }
  const count = (size - 2) * (size - 2);
  return Math.min(strongest(across, count), strongest(down, count));
}

// Numbers of one photo file:
//   sharp    sharpness of the best tile, 0 to 255
//   clipped  share of the photo that is pure white, 0 to 1
//   dark     share of the photo that is pure black, 0 to 1
//   crop     the best tile at full size (ImageData), to show to the operator
// Returns null if this phone cannot decode the photo (not enough memory). The photo is valid in that case too.
export async function measure(file) {
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { return null; }
  try {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const sw = canvas.width = Math.max(1, Math.round(bitmap.width / SCALE));
    const sh = canvas.height = Math.max(1, Math.round(bitmap.height / SCALE));
    ctx.drawImage(bitmap, 0, 0, sw, sh);
    const small = ctx.getImageData(0, 0, sw, sh).data;

    // One block of the small copy is one tile of the photo. A block with a wide spread of brightness holds content.
    const block = TILE / SCALE, cols = Math.floor(sw / block), rows = Math.floor(sh / block);
    const sum = new Float64Array(cols * rows), squares = new Float64Array(cols * rows);
    let clipped = 0, dark = 0;
    for (let y = 0; y < sh; y++)
      for (let x = 0; x < sw; x++) {
        const v = luma(small, (y * sw + x) * 4);
        if (v >= 250) clipped++; else if (v <= 5) dark++;
        const bx = Math.floor(x / block), by = Math.floor(y / block);
        if (bx < cols && by < rows) { sum[by * cols + bx] += v; squares[by * cols + bx] += v * v; }
      }
    const n = block * block;
    const busiest = Array.from(sum, (s, i) => ({ i, spread: squares[i] / n - (s / n) ** 2 }))
      .sort((a, b) => b.spread - a.spread).slice(0, TILES);

    canvas.width = canvas.height = TILE;
    let sharp = 0, crop = null;
    for (const { i } of busiest) {
      ctx.drawImage(bitmap, (i % cols) * TILE, Math.floor(i / cols) * TILE, TILE, TILE, 0, 0, TILE, TILE);
      const tile = ctx.getImageData(0, 0, TILE, TILE);
      const score = tileSharpness(tile.data, TILE);
      if (!crop || score > sharp) { sharp = score; crop = tile; }
    }
    return { sharp, clipped: clipped / (sw * sh), dark: dark / (sw * sh), crop };
  } catch {
    return null;
  } finally {
    bitmap.close();
  }
}
