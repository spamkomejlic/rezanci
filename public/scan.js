// QR scanner inside the page. It uses the camera of the phone and the code reader of the browser
// (Chrome on Android has one). A browser with no code reader gets no scan button:
// there the camera app of the phone reads the code and opens the same address.
import { t } from '/ui.js';

const el = (tag, className, text = '') => Object.assign(document.createElement(tag), { className, textContent: text });

// Shows the scan button if this browser can scan. A code counts only if it is an address of this site
// with the given path and the given name in its last part: "/join" and "c", or "/mod/" and "bag".
// Each other code is ignored, so a foreign code cannot send the phone to a different site.
export async function scanButton(button, path, name) {
  if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) return;
  if (!(await BarcodeDetector.getSupportedFormats().catch(() => [])).includes('qr_code')) return;
  const ours = text => {
    try {
      const u = new URL(text);
      return u.origin === location.origin && u.pathname === path && u.hash.startsWith(`#${name}=`) ? u.href : null;
    } catch { return null; }
  };
  button.hidden = false;
  button.onclick = () => scan(ours);
}

async function scan(ours) {
  const root = el('div', 'scanner'), video = el('video', ''), hint = el('p', '', t('scan.hint'));
  const cancel = Object.assign(el('button', 'btn soft wide', t('scan.cancel')), { type: 'button' });
  const bar = el('div', 'bar');
  video.playsInline = video.muted = true;
  bar.append(hint, cancel);
  root.append(video, el('div', 'aim'), bar);
  document.body.append(root);

  let stream;
  const close = () => {
    stream?.getTracks().forEach(track => track.stop());        // camera off
    root.remove();
  };
  cancel.onclick = close;
  document.addEventListener('visibilitychange', close, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false });
    if (!root.isConnected) return close();                     // cancelled while the camera started
    video.srcObject = stream;
    await video.play();
    const reader = new BarcodeDetector({ formats: ['qr_code'] });
    while (root.isConnected) {
      for (const code of await reader.detect(video)) {
        const address = ours(code.rawValue);
        if (address) { close(); location.href = address; return; }
        hint.textContent = t('scan.other');
      }
      await new Promise(done => setTimeout(done, 150));
    }
  } catch {
    if (root.isConnected) hint.textContent = t('scan.failed');   // the view stays, with the reason and Cancel
  }
}
