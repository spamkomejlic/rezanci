// Start of each help page: adds the help texts to the texts of the app, fills the page,
// and loads each screenshot in the language of the page.
import { boot } from '/ui.js';
import { TEXT, lang } from '/i18n.js';
import { HELP } from '/help/text.js';

for (const language of ['en', 'sr']) Object.assign(TEXT[language], HELP[language]);
boot();
// The slides load all screenshots at the start, so a slide change shows no empty frame. A guide loads them as the reader scrolls.
const slides = document.querySelector('.deck') !== null;
for (const img of document.querySelectorAll('img[data-shot]')) {
  img.loading = slides ? 'eager' : 'lazy';
  img.alt = img.closest('.step, .slide')?.querySelector('h2')?.textContent ?? '';
  img.src = `/help/shots/${lang}/${img.dataset.shot}.webp`;
}
