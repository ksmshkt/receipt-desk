client.auth.getSession().then(({ data: { session } }) => {
  if (session) window.location.href = 'app.html';
});

let isLogin = true;

document.querySelectorAll('.auth-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    isLogin = tab.dataset.tab === 'login';
    document.getElementById('auth-btn').textContent = isLogin ? 'ログイン' : '新規登録';
    document.getElementById('auth-error').classList.add('hidden');
  });
});

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('email').value;
  const password = document.getElementById('password').value;
  const errorEl = document.getElementById('auth-error');
  const btn = document.getElementById('auth-btn');

  btn.disabled = true;
  errorEl.classList.add('hidden');

  const { error } = isLogin
    ? await client.auth.signInWithPassword({ email, password })
    : await client.auth.signUp({ email, password });

  if (error) {
    errorEl.textContent = error.message;
    errorEl.classList.remove('hidden');
    btn.disabled = false;
  } else {
    window.location.href = 'app.html';
  }
});
