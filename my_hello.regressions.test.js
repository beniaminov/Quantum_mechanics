const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createServer } = require('./my_hello');

const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'test-password-long-enough';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let temporaryDirectory;
let dataFile;
let server;
let baseUrl;
let cookie;

before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-service-regressions-'));
  dataFile = path.join(temporaryDirectory, 'pages.json');
  await fs.writeFile(dataFile, JSON.stringify({
    home: { title: 'Главная', content: 'Привет' },
    about: { title: 'О нас', content: '<div>Блок текста</div><p>Абзац</p>' },
  }));
  server = createServer({
    adminUsername: ADMIN_USER,
    adminPassword: ADMIN_PASSWORD,
    dataFile,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;

  const login = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
    redirect: 'manual',
  });
  cookie = login.headers.get('set-cookie').split(';')[0];
});

after(async () => {
  if (server?.listening) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  if (temporaryDirectory) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true });
  }
});

async function csrfFrom(html) {
  return html.match(/name="csrf" value="([^"]+)"/)[1];
}

async function editorCsrf(slug) {
  const response = await fetch(`${baseUrl}/admin/pages/${slug}`, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  return csrfFrom(await response.text());
}

test('creates a page with 10000 cyrillic characters instead of rejecting it as too large', async () => {
  const csrf = await csrfFrom(await (await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie } })).text());
  const response = await fetch(`${baseUrl}/admin/pages`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf,
      title: 'Длинная страница',
      slug: 'long-page',
      content: 'я'.repeat(10000),
    }),
    redirect: 'manual',
  });
  assert.equal(response.status, 303, 'страница с допустимым по maxlength содержимым не должна отклоняться');

  const page = await fetch(`${baseUrl}/long-page`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /я{100}/);

  const deleteResponse = await fetch(`${baseUrl}/admin/pages/long-page/delete`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf }),
    redirect: 'manual',
  });
  assert.equal(deleteResponse.status, 303);
});

test('editor saves 25000 cyrillic characters through multipart form', async () => {
  const form = new FormData();
  form.set('csrf', await editorCsrf('about'));
  form.set('title', 'О нас');
  form.set('content', 'б'.repeat(25000));
  const response = await fetch(`${baseUrl}/admin/pages/about`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
    redirect: 'manual',
  });
  assert.equal(response.status, 303, 'редактор с maxlength=30000 не должен получать 413');

  const saved = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(saved.about.content, 'б'.repeat(25000));

  // Восстанавливаем содержимое для остальных тестов.
  const restore = new FormData();
  restore.set('csrf', await editorCsrf('about'));
  restore.set('title', 'О нас');
  restore.set('content', '<div>Блок текста</div><p>Абзац</p>');
  assert.equal((await fetch(`${baseUrl}/admin/pages/about`, {
    method: 'POST', headers: { Cookie: cookie }, body: restore, redirect: 'manual',
  })).status, 303);
});

test('size limits still reject oversized bodies', async () => {
  const hugeUpload = Buffer.concat([PNG_SIGNATURE, Buffer.alloc(6 * 1024 * 1024)]);
  const form = new FormData();
  form.set('csrf', await editorCsrf('about'));
  form.set('title', 'О нас');
  form.set('content', 'текст');
  form.append('uploads', new Blob([hugeUpload], { type: 'image/png' }), 'huge.png');
  const upload = await fetch(`${baseUrl}/admin/pages/about`, {
    method: 'POST', headers: { Cookie: cookie }, body: form,
  });
  assert.equal(upload.status, 413, 'файл больше 5 МБ по-прежнему должен отклоняться');

  const hugeField = new FormData();
  hugeField.set('csrf', await editorCsrf('about'));
  hugeField.set('title', 'О нас');
  hugeField.set('content', 'x'.repeat(200000));
  const field = await fetch(`${baseUrl}/admin/pages/about`, {
    method: 'POST', headers: { Cookie: cookie }, body: hugeField,
  });
  assert.equal(field.status, 413, 'слишком большое текстовое поле по-прежнему должно отклоняться');
});

test('HEAD /admin redirects to the login page and HEAD /admin/login answers without loops', async () => {
  const headAdmin = await fetch(`${baseUrl}/admin`, { method: 'HEAD', redirect: 'manual' });
  assert.equal(headAdmin.status, 303);
  assert.equal(headAdmin.headers.get('location'), '/admin/login');

  const headLogin = await fetch(`${baseUrl}/admin/login`, { method: 'HEAD', redirect: 'manual' });
  assert.equal(headLogin.status, 200, 'HEAD /admin/login должен отвечать 200, а не порождать редирект');
  assert.equal(await headLogin.text(), '');

  // Клиент, следующий редиректам, должен дойти до входа, а не зациклиться.
  const followed = await fetch(`${baseUrl}/admin`, { method: 'HEAD' });
  assert.equal(followed.status, 200);
});

test('unknown admin pages return 404 regardless of letter case', async () => {
  const lower = await fetch(`${baseUrl}/admin/pages/zzz-missing`, { headers: { Cookie: cookie } });
  assert.equal(lower.status, 404);

  const upper = await fetch(`${baseUrl}/admin/pages/ZZZ-MISSING`, { headers: { Cookie: cookie } });
  assert.equal(upper.status, 404, 'адрес страницы заглавными буквами должен давать 404, а не 405');

  const deleteUpper = await fetch(`${baseUrl}/admin/pages/ZZZ-MISSING/delete`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'anything' }),
  });
  assert.equal(deleteUpper.status, 404);

  const headUpper = await fetch(`${baseUrl}/admin/pages/ZZZ-MISSING`, { method: 'HEAD', headers: { Cookie: cookie } });
  assert.equal(headUpper.status, 404);
});

test('paths that merely start with "admin" stay public and return 404', async () => {
  const anonymous = await fetch(`${baseUrl}/adminfoo`, { redirect: 'manual' });
  assert.equal(anonymous.status, 404, 'путь /adminfoo не должен попадать под админ-маршруты');

  const authenticated = await fetch(`${baseUrl}/adminfoo`, { headers: { Cookie: cookie } });
  assert.equal(authenticated.status, 404);

  // Настоящий админ-маршрут по-прежнему защищён.
  const protectedPage = await fetch(`${baseUrl}/admin/`, { redirect: 'manual' });
  assert.equal(protectedPage.status, 303);
  assert.equal(protectedPage.headers.get('location'), '/admin/login');
});

test('server keeps div blocks and the editor script preserves them too', async () => {
  const publicPage = await (await fetch(`${baseUrl}/about`)).text();
  assert.match(publicPage, /<div>Блок текста<\/div>/, 'сервер должен сохранять <div> из редактора');

  const script = await (await fetch(`${baseUrl}/admin-editor.js`)).text();
  const allowedLine = script.match(/const allowed = new Set\(\[[^\]]+\]\)/)[0];
  assert.match(allowedLine, /'DIV'/, 'клиентский cleanPreview должен допускать <div> как сервер');
});

test('editing through the editor keeps div content intact after a save round-trip', async () => {
  const form = new FormData();
  form.set('csrf', await editorCsrf('about'));
  form.set('title', 'О нас');
  form.set('content', '<div>Блок текста</div><p>Абзац</p>');
  assert.equal((await fetch(`${baseUrl}/admin/pages/about`, {
    method: 'POST', headers: { Cookie: cookie }, body: form, redirect: 'manual',
  })).status, 303);

  const saved = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.equal(saved.about.content, '<div>Блок текста</div><p>Абзац</p>');

  const editorHtml = await (await fetch(`${baseUrl}/admin/pages/about`, { headers: { Cookie: cookie } })).text();
  const textarea = editorHtml.match(/<textarea id="content"[^>]*>([\s\S]*?)<\/textarea>/)[1];
  assert.match(textarea, /&lt;div&gt;Блок текста&lt;\/div&gt;/);
});

test('admin page order can be changed securely and is reflected on the site', async () => {
  const dashboard = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie } });
  const dashboardHtml = await dashboard.text();
  assert.match(dashboardHtml, /id="page-order-form"/);
  assert.match(dashboardHtml, /draggable="true"/);
  assert.match(dashboardHtml, /Переместить страницу/);
  assert.match(dashboardHtml, /src="\/admin-pages\.js"/);
  const csrf = await csrfFrom(dashboardHtml);
  const orderForm = (token, slugs) => {
    const form = new URLSearchParams({ csrf: token });
    slugs.forEach((slug) => form.append('order', slug));
    return form;
  };

  const invalidOrder = await fetch(`${baseUrl}/admin/pages/reorder`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, order: 'about' }),
    redirect: 'manual',
  });
  assert.equal(invalidOrder.status, 400, 'сервер должен отклонять неполный порядок');

  const invalidCsrf = await fetch(`${baseUrl}/admin/pages/reorder`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: orderForm('invalid', ['about', 'home']),
    redirect: 'manual',
  });
  assert.equal(invalidCsrf.status, 403, 'изменение порядка должно защищаться CSRF-токеном');

  const createNumericSlug = await fetch(`${baseUrl}/admin/pages`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, title: 'Страница 1', slug: '1', content: 'Числовой адрес' }),
    redirect: 'manual',
  });
  assert.equal(createNumericSlug.status, 303);
  const updatedDashboard = await (await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie } })).text();
  assert.deepEqual([...updatedDashboard.matchAll(/name="order" value="([^"]+)"/g)].map((match) => match[1]), [
    'home', 'about', '1',
  ], 'новая страница должна добавляться в конец даже при числовом адресе');

  const reorder = await fetch(`${baseUrl}/admin/pages/reorder`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: orderForm(csrf, ['about', 'home', '1']),
    redirect: 'manual',
  });
  assert.equal(reorder.status, 303, await reorder.text());
  assert.equal(reorder.headers.get('location'), '/admin');

  const editForm = new FormData();
  editForm.set('csrf', await editorCsrf('home'));
  editForm.set('title', 'Главная после редактирования');
  editForm.set('content', 'Изменённое содержимое главной страницы');
  const editResponse = await fetch(`${baseUrl}/admin/pages/home`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: editForm,
    redirect: 'manual',
  });
  assert.equal(editResponse.status, 303);

  const savedPages = JSON.parse(await fs.readFile(dataFile, 'utf8'));
  assert.ok(savedPages.about.order < savedPages.home.order);
  assert.ok(savedPages.home.order < savedPages['1'].order);
  assert.equal(savedPages.home.title, 'Главная после редактирования');
  const publicPage = await (await fetch(`${baseUrl}/`)).text();
  const navigation = publicPage.match(/<nav>([\s\S]*?)<\/nav>/)[1];
  assert.ok(navigation.indexOf('href="/about"') < navigation.indexOf('href="/"'));
  assert.ok(navigation.indexOf('href="/"') < navigation.indexOf('href="/1"'));

  const scriptResponse = await fetch(`${baseUrl}/admin-pages.js`);
  assert.equal(scriptResponse.status, 200);
  assert.match(await scriptResponse.text(), /dragover/);
});
