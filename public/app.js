// Shows the version of the running code, so anyone can compare it with the repository.
const commit = document.getElementById('commit');
fetch('/api/health').then(r => r.json()).then(j => { commit.textContent = j.commit; })
  .catch(() => { commit.textContent = 'not available'; });
