// Training slides: one slide on the screen, 16:9. Arrow keys, space, a tap or the buttons change the slide.
// Print gives one slide per page.
import { $ } from '/ui.js';
import '/help/page.js';

const slides = [...document.querySelectorAll('.slide')];
let at = 0;

function go(n) {
  at = Math.max(0, Math.min(slides.length - 1, n));
  slides.forEach((slide, i) => slide.classList.toggle('on', i === at));
  $('count').textContent = `${at + 1} / ${slides.length}`;
  history.replaceState(null, '', '#' + (at + 1));          // a reload opens the same slide
}

$('prev').onclick = () => go(at - 1);
$('next').onclick = () => go(at + 1);
$('full').onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
// A tap on the slide: the left third goes back, the rest goes on.
$('deck').onclick = event => { if (!event.target.closest('a, button')) go(at + (event.clientX < innerWidth / 3 ? -1 : 1)); };
addEventListener('keydown', event => {
  if (event.target.closest('a, button') && [' ', 'Enter'].includes(event.key)) return;   // the key belongs to the button
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter'].includes(event.key)) go(at + 1);
  if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(event.key)) go(at - 1);
  if (event.key === 'Home') go(0);
  if (event.key === 'End') go(slides.length - 1);
});
go((Number(location.hash.slice(1)) || 1) - 1);
