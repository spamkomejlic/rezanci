// Moderator page. Cloudflare Access guards this path. The API checks the login again.
const who = document.getElementById('who');
try {
  const r = await fetch('/api/mod/whoami');
  const j = await r.json();
  who.textContent = r.ok
    ? `Logged in as ${j.email}.${j.amr ? ` Login steps: ${[].concat(j.amr).join(', ')}.` : ''}`
    : `No moderator login: ${j.error}.`;
  who.className = r.ok ? 'good' : 'bad';
} catch {
  who.textContent = 'The server gave no answer.';
  who.className = 'bad';
}
