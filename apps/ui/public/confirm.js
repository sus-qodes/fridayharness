// Friday's own confirmation window (2026-11-18). The desktop app writes what is asked into
// `__FRIDAY_CONFIRM__` before this script runs, and takes the answer through one command that only
// this window may call. Nothing here comes from the page that asked, and everything is shown as
// text. Plain script, no build step: the file is served as it is.
(() => {
  const asked = window.__FRIDAY_CONFIRM__;
  const invoke = window.__TAURI_INTERNALS__?.invoke;
  const byId = (id) => document.getElementById(id);
  const title = byId('title');
  const text = byId('text');
  const yes = byId('yes');
  const no = byId('no');

  /** One paragraph per block of the text; `Label: value` rows, a warning and the closing question each look like what they are. */
  const show = (body) => {
    const blocks = String(body).split(/\n{2,}/);
    blocks.forEach((block, i) => {
      const p = document.createElement('p');
      p.textContent = block;
      const lines = block.split('\n');
      if (lines.length > 1 && lines.every((l) => /^[-A-Z][^:\n]{0,40}:\s|^- /.test(l))) p.className = 'rows';
      else if (/^WARNING/.test(block)) p.className = 'warning';
      else if (i === blocks.length - 1 && /\?\s*$/.test(block)) p.className = 'ask';
      text.append(p);
    });
  };

  if (!asked || typeof invoke !== 'function') {
    title.textContent = 'Friday';
    show('This confirmation could not be shown. Close this window and try again.');
    yes.hidden = true;
    no.textContent = 'Close';
    no.addEventListener('click', () => window.close());
    return;
  }

  title.textContent = String(asked.title).replace(/^Friday:\s*/, '');
  title.textContent = title.textContent.charAt(0).toUpperCase() + title.textContent.slice(1);
  show(asked.text);
  yes.textContent = String(asked.confirm);
  if (asked.danger) yes.classList.add('danger');

  let sent = false;
  const answer = (value) => {
    if (sent) return;
    sent = true;
    yes.disabled = true;
    no.disabled = true;
    Promise.resolve(invoke('confirm_answer', { id: asked.id, yes: value })).catch(() => {
      // The app did not take it (the question is gone): nothing was decided here.
      sent = false;
      no.disabled = false;
    });
  };
  no.addEventListener('click', () => answer(false));
  yes.addEventListener('click', () => answer(true));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      answer(false);
    }
  });
  // A press that was on its way to something else must not decide: the button that says yes
  // answers after a moment, and the keyboard starts on Cancel.
  no.focus();
  setTimeout(() => {
    if (!sent) yes.disabled = false;
  }, 450);
})();
