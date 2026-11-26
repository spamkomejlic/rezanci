// Draws a text as a QR code on a canvas.
import { qrcode } from '/vendor/qrcode.js';

// Dark squares on white with a white margin of 4 squares, as the QR standard asks.
// The colors are fixed, so a phone camera reads the code in light and in dark mode.
export function drawQr(canvas, text, scale = 8) {
  const qr = qrcode(0, 'M');   // 0: smallest size that holds the text. M: medium error correction.
  qr.addData(text);
  qr.make();
  const count = qr.getModuleCount(), margin = 4, size = (count + margin * 2) * scale;
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, size, size);
  g.fillStyle = '#0b1a2b';
  for (let row = 0; row < count; row++)
    for (let col = 0; col < count; col++)
      if (qr.isDark(row, col)) g.fillRect((col + margin) * scale, (row + margin) * scale, scale, scale);
}
