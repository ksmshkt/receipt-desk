// Logged-in visitors get a direct link to the app instead of the login CTA.
// No auto-redirect: the LP is the site's top page and should stay viewable.
client.auth.getSession().then(({ data: { session } }) => {
  if (!session) return;
  const cta = document.getElementById('lp-header-cta');
  cta.href = 'app.html';
  cta.textContent = 'アプリを開く';
});

// Tap/click a screenshot to view it full-size (reuses app.html's lightbox pattern/styles).
document.querySelectorAll('.lp-shot').forEach(btn => {
  btn.addEventListener('click', () => {
    document.getElementById('lightbox-image').src = btn.querySelector('img').src;
    document.getElementById('image-lightbox').classList.remove('hidden');
  });
});

document.getElementById('image-lightbox').addEventListener('click', () => {
  document.getElementById('image-lightbox').classList.add('hidden');
  document.getElementById('lightbox-image').src = '';
});
