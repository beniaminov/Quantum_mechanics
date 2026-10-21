const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { after, before, test } = require('node:test');
const { createServer } = require('./my_hello');

const initialPages = {
  home: { title: 'Главная', content: 'Исходная главная страница' },
  about: { title: 'О нас', content: 'Информация о проекте' },
};
let temporaryDirectory;
let server;
let baseUrl;

before(async () => {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'hello-service-'));
  const dataFile = path.join(temporaryDirectory, 'pages.json');
  await fs.writeFile(dataFile, JSON.stringify(initialPages));
  server = createServer({
    adminUsername: 'admin',
    adminPassword: 'test-password-long-enough',
    dataFile,
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
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

test('serves public pages, health checks, and not-found responses', async () => {
  const home = await fetch(`${baseUrl}/`);
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-type'), /text\/html/);
  const homeHtml = await home.text();
  assert.match(homeHtml, /Исходная главная страница/);
  assert.match(homeHtml, /src="\/mathjax-config\.js"/);
  assert.match(homeHtml, /src="\/mathjax\/tex-mml-chtml\.js"/);
  assert.match(homeHtml, /aria-label="Текущие дата и время"/);
  assert.match(homeHtml, /<strong>Дата:<\/strong> <time datetime="[^"]+">[^<]+<\/time>/);
  assert.match(homeHtml, /<strong>Время:<\/strong> <time datetime="[^"]+">[^<]+<\/time>/);

  const about = await fetch(`${baseUrl}/about`);
  assert.equal(about.status, 200);
  const aboutHtml = await about.text();
  assert.match(aboutHtml, /Информация о проекте/);
  assert.doesNotMatch(aboutHtml, /Текущие дата и время/);

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });

  const missing = await fetch(`${baseUrl}/missing`);
  assert.equal(missing.status, 404);

  const unsupported = await fetch(`${baseUrl}/`, { method: 'POST' });
  assert.equal(unsupported.status, 405);
});

test('protects admin pages and saves edits with an authenticated session', async () => {
  const unauthorized = await fetch(`${baseUrl}/admin`, { redirect: 'manual' });
  assert.equal(unauthorized.status, 303);
  assert.equal(unauthorized.headers.get('location'), '/admin/login');

  const login = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'test-password-long-enough' }),
    redirect: 'manual',
  });
  assert.equal(login.status, 303);
  const cookie = login.headers.get('set-cookie').split(';')[0];

  const dashboard = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie } });
  assert.equal(dashboard.status, 200);
  assert.match(await dashboard.text(), /Редактировать: Главная/);

  const editor = await fetch(`${baseUrl}/admin/pages/home`, { headers: { Cookie: cookie } });
  const editorHtml = await editor.text();
  assert.match(editorHtml, /id="rich-editor"/);
  assert.match(editorHtml, /id="toggle-html-source"/);
  assert.match(editorHtml, /id="image-width"/);
  assert.match(editorHtml, /id="apply-image-width"/);
  assert.match(editorHtml, /id="insert-inline-math"/);
  assert.match(editorHtml, /id="insert-display-math"/);
  assert.match(editorHtml, /id="formula-dialog"/);
  assert.match(editorHtml, /id="formula-source"/);
  assert.match(editorHtml, /id="formula-dialog-preview"/);
  assert.match(editorHtml, /id="preview-formula"/);
  assert.match(editorHtml, /id="insert-formula"/);
  assert.match(editorHtml, /id="toggle-formula-preview"/);
  assert.match(editorHtml, /src="\/mathjax\/tex-mml-chtml\.js"/);
  assert.match(editorHtml, /src="\/admin-editor\.js"/);
  const mathjaxScript = await fetch(`${baseUrl}/mathjax/tex-mml-chtml.js`);
  assert.equal(mathjaxScript.status, 200);
  assert.match(mathjaxScript.headers.get('content-type'), /javascript/);
  assert.ok((await mathjaxScript.arrayBuffer()).byteLength > 100_000);
  const mathjaxConfig = await fetch(`${baseUrl}/mathjax-config.js`);
  assert.equal(mathjaxConfig.status, 200);
  const mathjaxConfigText = await mathjaxConfig.text();
  assert.match(mathjaxConfigText, /inlineMath/);
  assert.match(mathjaxConfigText, /displayMath/);
  const editorScript = await fetch(`${baseUrl}/admin-editor.js`);
  assert.equal(editorScript.status, 200);
  const editorScriptText = await editorScript.text();
  assert.match(editorScriptText, /insert-page-link/);
  assert.match(editorScriptText, /openFormulaDialog/);
  assert.match(editorScriptText, /typesetPromise\(\[formulaDialogPreview\]\)/);
  assert.match(editorScriptText, /insertIntoSource\(formula, savedSourceRange\)/);
  const csrfToken = editorHtml.match(/name="csrf" value="([^"]+)"/)[1];

  const save = await fetch(`${baseUrl}/admin/pages/home`, {
    method: 'POST',
    headers: {
      Cookie: cookie,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      csrf: csrfToken,
      title: 'Обновленная страница',
      content: '<p><strong>Жирный текст</strong> <a href="/about" target="_blank">О нас</a><a href="javascript:alert(1)">опасная ссылка</a><img src="https://example.test/image.png" onerror="alert(1)"></p><p>\\(x^2 + y^2 = z^2\\)</p><div>\\[\\frac{1}{2}\\]</div><script>alert("xss")</script>\nНовый текст',
    }),
    redirect: 'manual',
  });
  assert.equal(save.status, 303);

  const updatedPage = await fetch(`${baseUrl}/`);
  const updatedHtml = await updatedPage.text();
  assert.match(updatedHtml, /Обновленная страница/);
  assert.match(updatedHtml, /\\\(x\^2 \+ y\^2 = z\^2\\\)/);
  assert.match(updatedHtml, /\\\[\\frac\{1\}\{2\}\\\]/);
  assert.match(updatedHtml, /<strong>Жирный текст<\/strong>/);
  assert.match(updatedHtml, /href="\/about"/);
  assert.doesNotMatch(updatedHtml, /target="_blank"|javascript:|onerror=|<script>/);
  assert.match(updatedHtml, /Новый текст/);

  const savedPages = JSON.parse(await fs.readFile(path.join(temporaryDirectory, 'pages.json'), 'utf8'));
  assert.equal(savedPages.home.title, 'Обновленная страница');
});

test('rejects incorrect administrator credentials and invalid CSRF tokens', async () => {
  const badLogin = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'wrong-password' }),
  });
  assert.equal(badLogin.status, 401);

  const login = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'test-password-long-enough' }),
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const invalidSave = await fetch(`${baseUrl}/admin/pages/home`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: 'invalid', title: 'No', content: 'No' }),
  });
  assert.equal(invalidSave.status, 403);
});

test('creates pages, uploads images and PDFs, and deletes pages and their files', async () => {
  const login = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'test-password-long-enough' }),
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const dashboard = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie } });
  const dashboardHtml = await dashboard.text();
  const csrfToken = dashboardHtml.match(/name="csrf" value="([^"]+)"/)[1];

  const create = await fetch(`${baseUrl}/admin/pages`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      csrf: csrfToken,
      title: 'Новости',
      slug: 'news',
      content: 'Последние новости проекта',
    }),
    redirect: 'manual',
  });
  assert.equal(create.status, 303);
  assert.equal(create.headers.get('location'), '/admin/pages/news');

  const editor = await fetch(`${baseUrl}/admin/pages/news`, { headers: { Cookie: cookie } });
  const editorHtml = await editor.text();
  const pageToken = editorHtml.match(/name="csrf" value="([^"]+)"/)[1];
  const form = new FormData();
  form.set('csrf', pageToken);
  form.set('title', 'Новости проекта');
  form.set('content', 'Обновленная новость');
  form.append('uploads', new Blob([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], { type: 'image/png' }), 'картинка.png');
  form.append('uploads', new Blob(['%PDF-1.7\nsample'], { type: 'application/pdf' }), 'документ.pdf');
  const save = await fetch(`${baseUrl}/admin/pages/news`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
    redirect: 'manual',
  });
  assert.equal(save.status, 303);

  const publicPage = await fetch(`${baseUrl}/news`);
  const publicHtml = await publicPage.text();
  assert.match(publicHtml, /Новости проекта/);
  assert.match(publicHtml, /картинка\.png/);
  assert.match(publicHtml, /документ\.pdf/);
  const imageId = publicHtml.match(/src="(\/uploads\/[a-f0-9]{32}\.png)"/)[1];
  const image = await fetch(`${baseUrl}${imageId}`);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('content-type'), 'image/png');

  const savedPages = JSON.parse(await fs.readFile(path.join(temporaryDirectory, 'pages.json'), 'utf8'));
  assert.equal(savedPages.news.assets.length, 2);
  const richEditor = await fetch(`${baseUrl}/admin/pages/news`, { headers: { Cookie: cookie } });
  const richEditorHtml = await richEditor.text();
  assert.match(richEditorHtml, /value="\/about">О нас<\/option>/);
  assert.match(richEditorHtml, /data-type="image\/png">картинка\.png<\/option>/);
  const richForm = new FormData();
  richForm.set('csrf', richEditorHtml.match(/name="csrf" value="([^"]+)"/)[1]);
  richForm.set('title', 'Новости проекта');
  richForm.set('content', `<p><a href="${imageId}"><img src="${imageId}" alt="Иллюстрация" style="width: 50%; height: auto" onerror="alert(1)"></a> <a href="/about" target="_blank">О нас</a></p>`);
  const richSave = await fetch(`${baseUrl}/admin/pages/news`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: richForm,
    redirect: 'manual',
  });
  assert.equal(richSave.status, 303);
  const richPublicHtml = await (await fetch(`${baseUrl}/news`)).text();
  assert.match(richPublicHtml, new RegExp(`<a href="${imageId}"><img src="${imageId}" alt="Иллюстрация" style="width: 50%; max-width: 100%; height: auto"></a>`));
  assert.match(richPublicHtml, /href="\/about">О нас<\/a>/);
  assert.doesNotMatch(richPublicHtml, /onerror=|target="_blank"/);
  assert.equal(richPublicHtml.split(`src="${imageId}"`).length - 1, 1);

  const unsafeSizeForm = new FormData();
  unsafeSizeForm.set('csrf', richEditorHtml.match(/name="csrf" value="([^"]+)"/)[1]);
  unsafeSizeForm.set('title', 'Новости проекта');
  unsafeSizeForm.set('content', `<p><img src="${imageId}" style="width: 99999px; background: url(javascript:alert(1))"></p>`);
  const unsafeSizeSave = await fetch(`${baseUrl}/admin/pages/news`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: unsafeSizeForm,
    redirect: 'manual',
  });
  assert.equal(unsafeSizeSave.status, 303);
  const unsafeSizePage = await (await fetch(`${baseUrl}/news`)).text();
  const unsafeRenderedImage = unsafeSizePage.match(new RegExp(`<img src="${imageId}"[^>]*>`))[0];
  assert.doesNotMatch(unsafeRenderedImage, /99999px|background:/);

  const removeForm = new FormData();
  removeForm.set('csrf', richEditorHtml.match(/name="csrf" value="([^"]+)"/)[1]);
  removeForm.set('title', 'Новости проекта');
  removeForm.set('content', 'Обновленная новость');
  removeForm.append('removeAsset', imageId.split('/').pop());
  const removeImage = await fetch(`${baseUrl}/admin/pages/news`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: removeForm,
    redirect: 'manual',
  });
  assert.equal(removeImage.status, 303);
  assert.equal((await fetch(`${baseUrl}${imageId}`)).status, 404);

  const remainingAssets = JSON.parse(await fs.readFile(path.join(temporaryDirectory, 'pages.json'), 'utf8')).news.assets;
  assert.equal(remainingAssets.length, 1);
  const pdfAsset = remainingAssets.find((asset) => asset.type === 'application/pdf');
  const pdf = await fetch(`${baseUrl}/uploads/${pdfAsset.id}`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');

  const deletePage = await fetch(`${baseUrl}/admin/pages/news/delete`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: pageToken }),
    redirect: 'manual',
  });
  assert.equal(deletePage.status, 303);
  assert.equal((await fetch(`${baseUrl}/news`)).status, 404);
  assert.equal((await fetch(`${baseUrl}${imageId}`)).status, 404);
});

test('rejects reserved and duplicate page addresses and files with unsupported content', async () => {
  const login = await fetch(`${baseUrl}/admin/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'test-password-long-enough' }),
    redirect: 'manual',
  });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const dashboard = await fetch(`${baseUrl}/admin`, { headers: { Cookie: cookie } });
  const csrfToken = (await dashboard.text()).match(/name="csrf" value="([^"]+)"/)[1];

  const reserved = await fetch(`${baseUrl}/admin/pages`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: csrfToken, title: 'Admin', slug: 'admin', content: 'text' }),
  });
  assert.equal(reserved.status, 400);

  const duplicate = await fetch(`${baseUrl}/admin/pages`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf: csrfToken, title: 'Дубликат', slug: 'about', content: 'text' }),
  });
  assert.equal(duplicate.status, 409);

  const editor = await fetch(`${baseUrl}/admin/pages/about`, { headers: { Cookie: cookie } });
  const editorToken = (await editor.text()).match(/name="csrf" value="([^"]+)"/)[1];
  const form = new FormData();
  form.set('csrf', editorToken);
  form.set('title', 'О нас');
  form.set('content', 'Информация о проекте');
  form.append('uploads', new Blob(['not an image'], { type: 'image/png' }), 'fake.png');
  const unsupported = await fetch(`${baseUrl}/admin/pages/about`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  });
  assert.equal(unsupported.status, 400);
});

test('publishes the project overview, phase-space page, and source PDF', async () => {
  const siteServer = createServer({
    adminUsername: 'admin',
    adminPassword: 'test-password-long-enough',
    dataFile: path.join(__dirname, 'data', 'pages.json'),
    uploadDir: path.join(__dirname, 'data', 'uploads'),
  });
  await new Promise((resolve, reject) => {
    siteServer.once('error', reject);
    siteServer.listen(0, '127.0.0.1', resolve);
  });
  const siteUrl = `http://127.0.0.1:${siteServer.address().port}`;

  try {
    const overview = await fetch(`${siteUrl}/unification`);
    assert.equal(overview.status, 200);
    const overviewHtml = await overview.text();
    assert.match(overviewHtml, /class="card project-story"/);
    assert.match(overviewHtml, /Промежуточная область/);
    assert.match(overviewHtml, /авторской исследовательской программы/);
    assert.match(overviewHtml, /href="\/phase-space"/);

    const details = await fetch(`${siteUrl}/phase-space`);
    assert.equal(details.status, 200);
    const detailsHtml = await details.text();
    assert.match(detailsHtml, /href="\/uploads\/6866edd42d006f85cecde44692437335\.pdf"/);
    assert.match(detailsHtml, /Быстрый этап/);
    assert.match(detailsHtml, /декогеренцией/);

    const sourcePdf = await fetch(`${siteUrl}/uploads/6866edd42d006f85cecde44692437335.pdf`);
    assert.equal(sourcePdf.status, 200);
    assert.equal(sourcePdf.headers.get('content-type'), 'application/pdf');
  } finally {
    await new Promise((resolve, reject) => {
      siteServer.close((error) => (error ? reject(error) : resolve()));
    });
  }
});
