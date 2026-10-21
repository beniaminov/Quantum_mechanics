const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const SESSION_COOKIE = 'hello_service_session';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
// Текстовые поля ограничены в символах (10000 при создании, 30000 в редакторе), но в байтах
// они занимают больше: один символ — до 4 байт UTF-8, а в urlencoded-формах байты кодируются
// в percent-последовательности (до 3 байт на байт). Лимиты должны это допускать.
const MAX_FORM_BYTES = 256 * 1024;
const MAX_FIELD_BYTES = 128 * 1024;
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_UPLOADS_PER_PAGE = 4;
const MAX_MULTIPART_BYTES = MAX_UPLOAD_BYTES * MAX_UPLOADS_PER_PAGE + MAX_FIELD_BYTES + 64 * 1024;
const DEFAULT_DATA_FILE = path.join(__dirname, 'data', 'pages.json');
const EDITOR_SCRIPT_PATH = path.join(__dirname, 'public', 'admin-editor.js');
const MATHJAX_CONFIG_PATH = path.join(__dirname, 'public', 'mathjax-config.js');
const MATHJAX_DIR = path.join(__dirname, 'node_modules', 'mathjax-full', 'es5');
const RESERVED_SLUGS = new Set(['admin', 'health', 'uploads', 'home']);
const RICH_TEXT_TAGS = new Set([
  'a', 'blockquote', 'br', 'code', 'div', 'em', 'figcaption', 'figure', 'h2', 'h3', 'h4',
  'hr', 'img', 'li', 'ol', 'p', 'pre', 's', 'strong', 'u', 'ul',
]);
const VOID_TAGS = new Set(['br', 'hr', 'img']);
const ASSET_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};
const MATHJAX_TYPES = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

function escapeHtmlText(value) {
  return String(value).split(/(&(?:#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);)/gi)
    .map((part) => /^&(?:#(?:x[0-9a-f]+|\d+)|amp|lt|gt|quot|apos|nbsp);$/i.test(part) ? part : escapeHtml(part))
    .join('');
}

function readHtmlAttribute(attributes, name) {
  const expression = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>]+))`, 'i');
  const match = attributes.match(expression);
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : null;
}

function safeRichTextHref(value, pages, assets) {
  const href = String(value || '').trim();
  if (href === '/') return href;
  if (/^\/[a-z0-9-]+$/.test(href) && pages[href.slice(1)]) return href;
  const asset = href.match(/^\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp|pdf))$/);
  if (asset && assets.some((item) => item.id === asset[1])) return href;
  if (/^https:\/\/[^\s"'<>]+$/i.test(href) || /^mailto:[^\s"'<>]+$/i.test(href)) return href;
  return null;
}

function safeImageWidth(style) {
  const match = String(style || '').match(/(?:^|;)\s*width\s*:\s*(\d+(?:\.\d{1,2})?)(px|%)\s*(?:;|$)/i);
  if (!match) return '';
  const value = Number(match[1]);
  const unit = match[2].toLowerCase();
  if (!Number.isFinite(value) || value <= 0 || (unit === '%' && value > 100) || (unit === 'px' && value > 2000)) {
    return '';
  }
  return `${value}${unit}`;
}

function sanitizeRichText(value, pages, pageAssets = []) {
  const source = String(value || '');
  const assets = pageAssets;
  const input = source.replace(/<(script|style|iframe|object|embed|svg|math|template|noscript|form|video|audio)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
  const tokenPattern = /<!--[\s\S]*?-->|<\/?[a-z][^>]*>/gi;
  const output = [];
  const openTags = [];
  let position = 0;
  let match;
  while ((match = tokenPattern.exec(input))) {
    const text = input.slice(position, match.index);
    if (text) output.push(escapeHtmlText(text).replace(/\r?\n/g, '<br>'));
    position = tokenPattern.lastIndex;
    if (match[0].startsWith('<!--')) continue;
    const tagMatch = match[0].match(/^<\s*(\/?)\s*([a-z][a-z0-9]*)\b([^>]*)>$/i);
    if (!tagMatch) {
      output.push(escapeHtml(match[0]));
      continue;
    }
    const closing = tagMatch[1] === '/';
    const tag = tagMatch[2].toLowerCase();
    if (!RICH_TEXT_TAGS.has(tag)) continue;
    if (closing) {
      const openIndex = openTags.lastIndexOf(tag);
      if (openIndex !== -1) {
        for (let index = openTags.length - 1; index >= openIndex; index -= 1) {
          output.push(`</${openTags.pop()}>`);
        }
      }
      continue;
    }

    let attributes = '';
    if (tag === 'a') {
      const href = safeRichTextHref(readHtmlAttribute(tagMatch[3], 'href'), pages, assets);
      if (href) attributes += ` href="${escapeHtml(href)}"`;
      const title = readHtmlAttribute(tagMatch[3], 'title');
      if (title) attributes += ` title="${escapeHtml(title.slice(0, 200))}"`;
    } else if (tag === 'img') {
      const src = safeRichTextHref(readHtmlAttribute(tagMatch[3], 'src'), pages, assets);
      if (!src || !/^\/uploads\/[a-f0-9]{32}\.(?:png|jpg|gif|webp)$/.test(src)) continue;
      attributes += ` src="${escapeHtml(src)}"`;
      const alt = readHtmlAttribute(tagMatch[3], 'alt');
      if (alt) attributes += ` alt="${escapeHtml(alt.slice(0, 200))}"`;
      const width = safeImageWidth(readHtmlAttribute(tagMatch[3], 'style'));
      if (width) attributes += ` style="width: ${width}; max-width: 100%; height: auto"`;
    }

    output.push(`<${tag}${attributes}>`);
    if (!VOID_TAGS.has(tag) && !/\/\s*>$/.test(match[0])) openTags.push(tag);
  }
  const remainingText = input.slice(position);
  if (remainingText) output.push(escapeHtmlText(remainingText).replace(/\r?\n/g, '<br>'));
  while (openTags.length) output.push(`</${openTags.pop()}>`);

  let html = output.join('');
  html = html.replace(/(<\/?(?:div|p|blockquote|h[2-4]|li|pre|figure|figcaption)[^>]*>)\s*(?:<br>)+/gi, '$1');
  return html;
}

function renderRichText(value, pages, pageAssets) {
  const source = String(value || '');
  if (!/<\s*\/?[a-z][^>]*>/i.test(source)) {
    return source.split(/\n{2,}/).map((paragraph) =>
      `<p>${escapeHtml(paragraph).replace(/\n/g, '<br>')}</p>`).join('');
  }
  return sanitizeRichText(source, pages, pageAssets);
}

function sendHtml(req, res, statusCode, html, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; font-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    ...headers,
  });
  res.end(req.method === 'HEAD' ? undefined : html);
}

function sendJson(req, res, statusCode, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
}

function layout(title, content) {
  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; font-family: system-ui, sans-serif; color: #192230; background: #f3f6fa; }
    * { box-sizing: border-box; }
    body { margin: 0; }
    header { background: #15243a; color: white; }
    .bar, main { width: min(960px, calc(100% - 32px)); margin: 0 auto; }
    .bar { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 24px; }
    .brand { color: white; font-size: 1.15rem; font-weight: 700; text-decoration: none; }
    nav { display: flex; flex-wrap: wrap; gap: 18px; }
    nav a { color: #dce7f5; text-decoration: none; }
    nav a:hover, nav a:focus { color: white; text-decoration: underline; }
    main { padding: 48px 0 72px; }
    .card { background: white; border: 1px solid #dce3ed; border-radius: 12px; padding: 28px; box-shadow: 0 8px 24px #15243a0c; }
    h1 { margin-top: 0; font-size: clamp(1.8rem, 5vw, 2.5rem); }
    p { line-height: 1.7; }
    .muted { color: #59677a; }
    .datetime { display: flex; flex-wrap: wrap; gap: 8px 24px; margin: 0 0 24px; padding: 12px 16px; border-radius: 8px; background: #f3f6fa; }
    .datetime p { margin: 0; }
    .pages { display: grid; gap: 12px; padding: 0; list-style: none; }
    .pages a { display: block; padding: 16px; border: 1px solid #dce3ed; border-radius: 8px; color: #1556a0; text-decoration: none; }
    .pages a:hover { background: #f5f8fc; }
    .asset-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; padding: 0; list-style: none; }
    .asset-list li { padding: 12px; border: 1px solid #dce3ed; border-radius: 8px; overflow-wrap: anywhere; }
    .asset-list img { display: block; width: 100%; max-height: 180px; object-fit: contain; margin-bottom: 8px; }
    .asset-list label { font-weight: 400; }
    label { display: block; margin: 18px 0 6px; font-weight: 650; }
    input, textarea { width: 100%; padding: 11px 12px; border: 1px solid #aebacc; border-radius: 6px; font: inherit; }
    input[type="checkbox"], input[type="file"] { width: auto; }
    textarea { min-height: 240px; resize: vertical; }
    [hidden] { display: none !important; }
    .editor-toolbar { display: flex; flex-wrap: wrap; gap: 8px; padding: 10px; border: 1px solid #aebacc; border-bottom: 0; border-radius: 6px 6px 0 0; background: #f3f6fa; }
    .editor-toolbar button { margin: 0; padding: 8px 10px; }
    .editor-toolbar select { max-width: 220px; padding: 8px; font: inherit; }
    .editor-toolbar input[type="number"] { width: 82px; padding: 8px; }
    .editor-toolbar .image-size-unit { width: auto; }
    .rich-editor { min-height: 240px; padding: 12px; border: 1px solid #aebacc; border-radius: 0 0 6px 6px; background: white; line-height: 1.6; }
    .rich-editor:focus { outline: 2px solid #1556a0; outline-offset: 1px; }
    .rich-editor img { max-width: 100%; height: auto; }
    .rich-editor img.editor-image-selected { outline: 2px solid #1556a0; outline-offset: 2px; }
    .formula-preview { margin-top: 16px; padding: 16px; border: 1px solid #aebacc; border-radius: 6px; background: #fff; }
    .formula-preview mjx-container[display="true"] { overflow-x: auto; overflow-y: hidden; }
    .formula-dialog { width: min(640px, calc(100% - 32px)); max-width: none; border: 1px solid #aebacc; border-radius: 10px; padding: 24px; box-shadow: 0 16px 48px #15243a40; }
    .formula-dialog::backdrop { background: #15243a80; }
    .formula-dialog h2 { margin-top: 0; }
    .formula-dialog textarea { min-height: 120px; font-family: ui-monospace, monospace; }
    .formula-dialog .formula-preview { min-height: 56px; overflow-x: auto; }
    .formula-dialog .formula-actions { display: flex; flex-wrap: wrap; gap: 8px; }
    .formula-dialog .formula-actions button { margin: 0; }
    .formula-dialog .formula-error { min-height: 1.5em; color: #922; }
    .project-story { padding: 0; overflow: hidden; border: 0; }
    .project-story > h1 { margin: 0; padding: 36px 36px 14px; color: #fff; background: linear-gradient(125deg, #101832, #174675 58%, #087f83); }
    .project-story > div:first-of-type { margin: 0; padding: 0 36px 36px; color: #e4f4ff; background: linear-gradient(125deg, #101832, #174675 58%, #087f83); }
    .project-story > div:first-of-type > p:first-child { margin: 0 0 14px; color: #83ead4; font-size: .78rem; font-weight: 750; letter-spacing: .12em; }
    .project-story > div:first-of-type > h2 { margin: 0 0 12px; border: 0; color: #fff; font-size: clamp(1.6rem, 4vw, 2.25rem); }
    .project-story > div:first-of-type > p:last-child { max-width: 72ch; margin: 0; color: #e4f4ff; font-size: 1.1rem; }
    .project-story > h2 { margin: 34px 32px 14px; padding-bottom: 10px; border-bottom: 2px solid #e3ebf4; color: #17375a; font-size: 1.4rem; }
    .project-story > p, .project-story > ul, .project-story > ol { margin-right: 32px; margin-left: 32px; }
    .project-story li { margin: 10px 0; line-height: 1.7; }
    .project-story > blockquote { margin: 20px 32px; padding: 18px 22px; border-left: 5px solid #0c9990; border-radius: 0 12px 12px 0; background: linear-gradient(110deg, #eafaf6, #f0f5ff); color: #1c3854; font-size: 1.06rem; line-height: 1.7; }
    .project-story > div:not(:first-of-type) { display: grid; grid-template-columns: repeat(auto-fit, minmax(205px, 1fr)); gap: 14px; margin: 18px 32px; }
    .project-story > div:not(:first-of-type) > div { padding: 18px; border: 1px solid #dae5f0; border-radius: 14px; background: linear-gradient(150deg, #fff, #f4f8fd); box-shadow: 0 8px 20px #15243a0c; }
    .project-story > div:not(:first-of-type) h3 { margin: 0 0 10px; color: #087f83; font-size: 1.08rem; }
    .project-story > div:not(:first-of-type) p { margin: 0; color: #4b5c70; }
    button, .button { display: inline-block; margin-top: 18px; padding: 11px 16px; border: 0; border-radius: 6px; background: #1556a0; color: white; font: inherit; font-weight: 650; cursor: pointer; text-decoration: none; }
    button:hover, .button:hover { background: #10447f; }
    .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
    .actions button { margin-right: 8px; }
    .error { padding: 12px; border-radius: 6px; background: #fff0f0; color: #922; }
    footer { padding: 20px 16px; color: #59677a; text-align: center; }
    @media (max-width: 560px) { .bar { align-items: flex-start; flex-direction: column; padding: 16px 0; gap: 12px; } main { padding-top: 28px; } .card { padding: 20px; } .project-story { padding: 0; } .project-story > h1 { padding: 26px 22px 12px; } .project-story > div:first-of-type { padding: 0 22px 26px; } .project-story > h2 { margin-right: 22px; margin-left: 22px; } .project-story > p, .project-story > ul, .project-story > ol { margin-right: 22px; margin-left: 22px; } .project-story > blockquote { margin-right: 22px; margin-left: 22px; } .project-story > div:not(:first-of-type) { margin-right: 22px; margin-left: 22px; } }
  </style>
</head>
<body>${content}</body>
</html>`;
}

function header(pages, admin = false) {
  const links = Object.entries(pages).map(([slug, page]) =>
    `<a href="/${slug === 'home' ? '' : escapeHtml(slug)}">${escapeHtml(page.title)}</a>`).join('');
  const adminLink = admin ? '' : '<a href="/admin">Администрирование</a>';
  return `<header><div class="bar"><a class="brand" href="/"> Квантовая механика</a><nav>${links}${adminLink}</nav></div></header>`;
}

async function readPages(dataFile) {
  const contents = await fs.readFile(dataFile, 'utf8');
  const pages = JSON.parse(contents);
  if (!pages || typeof pages !== 'object' || Array.isArray(pages) || Object.keys(pages).length === 0) {
    throw new Error(`Invalid pages data in ${dataFile}`);
  }
  for (const [slug, page] of Object.entries(pages)) {
    if (!/^[a-z0-9-]+$/.test(slug) || !page || typeof page.title !== 'string' || typeof page.content !== 'string'
      || (page.assets !== undefined && (!Array.isArray(page.assets) || page.assets.some((asset) =>
        !asset || !/^[a-f0-9]{32}\.(png|jpg|gif|webp|pdf)$/.test(asset.id)
        || typeof asset.name !== 'string' || !Object.values(ASSET_TYPES).includes(asset.type))))) {
      throw new Error(`Invalid page entry "${slug}" in ${dataFile}`);
    }
  }
  return pages;
}

function safeEqual(left, right) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function getCookie(req, name) {
  const cookieHeader = req.headers.cookie || '';
  for (const item of cookieHeader.split(';')) {
    const separator = item.indexOf('=');
    if (separator !== -1 && item.slice(0, separator).trim() === name) {
      return item.slice(separator + 1).trim();
    }
  }
  return '';
}

function sendRedirect(res, location, headers = {}) {
  res.writeHead(303, { Location: location, ...headers });
  res.end();
}

async function readForm(req) {
  if (!String(req.headers['content-type'] || '').startsWith('application/x-www-form-urlencoded')) {
    throw new HttpError(415, 'Expected a URL-encoded form.');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_FORM_BYTES) {
      throw new HttpError(413, 'Form is too large.');
    }
    chunks.push(chunk);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

function detectAssetType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { extension: '.png', type: 'image/png' };
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { extension: '.jpg', type: 'image/jpeg' };
  }
  const signature = buffer.subarray(0, 6).toString('ascii');
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    return { extension: '.gif', type: 'image/gif' };
  }
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    return { extension: '.webp', type: 'image/webp' };
  }
  if (buffer.length >= 5 && buffer.toString('ascii', 0, 5) === '%PDF-') {
    return { extension: '.pdf', type: 'application/pdf' };
  }
  return null;
}

async function readMultipartForm(req) {
  const contentType = String(req.headers['content-type'] || '');
  if (contentType.startsWith('application/x-www-form-urlencoded')) {
    const form = await readForm(req);
    const fields = new Map();
    for (const [name, value] of form) {
      const existing = fields.get(name);
      if (existing === undefined) fields.set(name, value);
      else if (Array.isArray(existing)) existing.push(value);
      else fields.set(name, [existing, value]);
    }
    return { fields, files: [] };
  }
  const boundaryMatch = contentType.match(/^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if (!boundaryMatch) {
    throw new HttpError(415, 'Expected a multipart form.');
  }
  const boundary = boundaryMatch[1] || boundaryMatch[2];
  if (boundary.length > 70) {
    throw new HttpError(400, 'Invalid multipart boundary.');
  }

  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_MULTIPART_BYTES) {
      throw new HttpError(413, 'Upload request is too large.');
    }
    chunks.push(chunk);
  }

  const body = Buffer.concat(chunks);
  const marker = Buffer.from(`--${boundary}`);
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  const fields = new Map();
  const files = [];
  let position = body.indexOf(marker);
  if (position !== 0) {
    throw new HttpError(400, 'Malformed multipart form.');
  }

  while (position !== -1) {
    position += marker.length;
    if (body.subarray(position, position + 2).toString() === '--') break;
    if (body.subarray(position, position + 2).toString() !== '\r\n') {
      throw new HttpError(400, 'Malformed multipart form.');
    }
    position += 2;
    const headersEnd = body.indexOf(Buffer.from('\r\n\r\n'), position);
    if (headersEnd === -1) throw new HttpError(400, 'Malformed multipart form.');
    const headers = body.subarray(position, headersEnd).toString('utf8');
    const disposition = headers.match(/content-disposition:\s*form-data;([^\r\n]+)/i);
    const fieldName = disposition && disposition[1].match(/(?:^|;)\s*name="([^"]*)"/i);
    if (!fieldName) throw new HttpError(400, 'Malformed multipart field.');
    const filenameMatch = disposition[1].match(/(?:^|;)\s*filename="([^"]*)"/i);
    const dataStart = headersEnd + 4;
    const nextBoundary = body.indexOf(delimiter, dataStart);
    if (nextBoundary === -1) throw new HttpError(400, 'Malformed multipart form.');
    const value = body.subarray(dataStart, nextBoundary);

    if (filenameMatch) {
      if (filenameMatch[1]) {
        if (files.length >= MAX_UPLOADS_PER_PAGE) {
          throw new HttpError(400, `Upload no more than ${MAX_UPLOADS_PER_PAGE} files at a time.`);
        }
        if (value.length > MAX_UPLOAD_BYTES) {
          throw new HttpError(413, 'Each image or PDF must be 5 MB or smaller.');
        }
        const safeName = filenameMatch[1].split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
        files.push({ name: safeName || 'file', buffer: value });
      }
    } else {
      if (value.length > MAX_FIELD_BYTES) throw new HttpError(413, 'Form field is too large.');
      const fieldValue = value.toString('utf8');
      const existing = fields.get(fieldName[1]);
      if (existing === undefined) {
        fields.set(fieldName[1], fieldValue);
      } else if (Array.isArray(existing)) {
        existing.push(fieldValue);
      } else {
        fields.set(fieldName[1], [existing, fieldValue]);
      }
    }
    position = nextBoundary + 2;
  }
  return { fields, files };
}

function validateCsrf(form, session) {
  if (!safeEqual(getFormValue(form, 'csrf'), session.csrfToken)) {
    throw new HttpError(403, 'Invalid CSRF token.');
  }
}

function getFormValue(form, name) {
  const value = form.get(name);
  return Array.isArray(value) ? value[0] || '' : value || '';
}

function getFormValues(form, name) {
  const value = form.get(name);
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

function validateSlug(value) {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
    && value.length <= 50
    && !RESERVED_SLUGS.has(value);
}

function createServer({
  adminUsername = process.env.ADMIN_USERNAME,
  adminPassword = process.env.ADMIN_PASSWORD,
  dataFile = DEFAULT_DATA_FILE,
  uploadDir = path.join(path.dirname(dataFile), 'uploads'),
} = {}) {
  if (!adminUsername || !adminPassword) {
    throw new Error('Set ADMIN_USERNAME and ADMIN_PASSWORD before starting the service.');
  }
  if (adminPassword.length < 12) {
    throw new Error('ADMIN_PASSWORD must be at least 12 characters long.');
  }

  const sessions = new Map();
  let saveQueue = Promise.resolve();

  function getSession(req) {
    const id = getCookie(req, SESSION_COOKIE);
    const session = sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(id);
      return null;
    }
    session.expiresAt = Date.now() + SESSION_TTL_MS;
    return session;
  }

  async function savePages(updatePages) {
    const operation = saveQueue.then(async () => {
      const pages = await readPages(dataFile);
      updatePages(pages);
      const temporaryFile = `${dataFile}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      try {
        await fs.writeFile(temporaryFile, `${JSON.stringify(pages, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporaryFile, dataFile);
      } catch (error) {
        await fs.rm(temporaryFile, { force: true });
        throw error;
      }
    });
    saveQueue = operation.catch(() => {});
    await operation;
  }

  async function storeUploads(files) {
    await fs.mkdir(uploadDir, { recursive: true });
    const stored = [];
    try {
      for (const file of files) {
        const detected = detectAssetType(file.buffer);
        if (!detected) {
          throw new HttpError(400, 'Разрешены только изображения PNG, JPEG, GIF, WebP и PDF.');
        }
        const id = `${crypto.randomBytes(16).toString('hex')}${detected.extension}`;
        await fs.writeFile(path.join(uploadDir, id), file.buffer, { flag: 'wx', mode: 0o600 });
        stored.push({ id, name: file.name, type: detected.type });
      }
      return stored;
    } catch (error) {
      await Promise.all(stored.map((asset) => fs.rm(path.join(uploadDir, asset.id), { force: true })));
      throw error;
    }
  }

  async function removeAssets(assets) {
    await Promise.all((assets || []).map((asset) => fs.rm(path.join(uploadDir, asset.id), { force: true })));
  }

  async function handleRequest(req, res) {
    const requestUrl = new URL(req.url, 'http://localhost');
    const pathname = requestUrl.pathname;

    if (pathname === '/health' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendJson(req, res, 200, { status: 'ok' });
      return;
    }

    if (pathname === '/mathjax-config.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      const script = await fs.readFile(MATHJAX_CONFIG_PATH);
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': script.length,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
      });
      res.end(req.method === 'HEAD' ? undefined : script);
      return;
    }

    if (pathname.startsWith('/mathjax/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(req, res, 405, { error: 'Method Not Allowed' });
        return;
      }
      let relativePath;
      try {
        relativePath = decodeURIComponent(pathname.slice('/mathjax/'.length));
      } catch {
        sendJson(req, res, 400, { error: 'Invalid asset path' });
        return;
      }
      const filePath = path.resolve(MATHJAX_DIR, relativePath);
      const relativeToRoot = path.relative(MATHJAX_DIR, filePath);
      const extension = path.extname(filePath).toLowerCase();
      if (!relativeToRoot || relativeToRoot.startsWith('..') || path.isAbsolute(relativeToRoot)
        || !MATHJAX_TYPES[extension]) {
        sendJson(req, res, 404, { error: 'Not Found' });
        return;
      }
      try {
        const file = await fs.readFile(filePath);
        res.writeHead(200, {
          'Content-Type': MATHJAX_TYPES[extension],
          'Content-Length': file.length,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=86400',
        });
        res.end(req.method === 'HEAD' ? undefined : file);
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
        sendJson(req, res, 404, { error: 'Not Found' });
      }
      return;
    }

    if (pathname === '/admin-editor.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      const script = await fs.readFile(EDITOR_SCRIPT_PATH);
      res.writeHead(200, {
        'Content-Type': 'text/javascript; charset=utf-8',
        'Content-Length': script.length,
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'none'",
      });
      res.end(req.method === 'HEAD' ? undefined : script);
      return;
    }

    const uploadMatch = pathname.match(/^\/uploads\/([a-f0-9]{32}\.(?:png|jpg|gif|webp|pdf))$/);
    if (uploadMatch && (req.method === 'GET' || req.method === 'HEAD')) {
      const [, id] = uploadMatch;
      const extension = path.extname(id);
      try {
        const file = await fs.readFile(path.join(uploadDir, id));
        res.writeHead(200, {
          'Content-Type': ASSET_TYPES[extension],
          'Content-Length': file.length,
          'X-Content-Type-Options': 'nosniff',
          'Content-Disposition': 'inline',
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        res.end(req.method === 'HEAD' ? undefined : file);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        sendJson(req, res, 404, { error: 'Not Found' });
      }
      return;
    }

    if (pathname === '/admin/login' && (req.method === 'GET' || req.method === 'HEAD')) {
      sendHtml(req, res, 200, layout('Вход администратора', `
        ${header({})}<main><section class="card">
          <h1>Вход администратора</h1>
          <form method="post" action="/admin/login">
            <label for="username">Логин</label><input id="username" name="username" autocomplete="username" required>
            <label for="password">Пароль</label><input id="password" name="password" type="password" autocomplete="current-password" required>
            <button type="submit">Войти</button>
          </form>
        </section></main>`), { 'Cache-Control': 'no-store' });
      return;
    }

    if (pathname === '/admin/login' && req.method === 'POST') {
      const form = await readForm(req);
      const validUsername = safeEqual(form.get('username') || '', adminUsername);
      const validPassword = safeEqual(form.get('password') || '', adminPassword);
      if (!validUsername || !validPassword) {
        sendHtml(req, res, 401, layout('Ошибка входа', `
          ${header({})}<main><section class="card">
            <h1>Не удалось войти</h1><p class="error">Проверьте логин и пароль.</p>
            <p><a href="/admin/login">Вернуться ко входу</a></p>
          </section></main>`), { 'Cache-Control': 'no-store' });
        return;
      }

      const id = crypto.randomBytes(32).toString('hex');
      sessions.set(id, {
        csrfToken: crypto.randomBytes(32).toString('hex'),
        expiresAt: Date.now() + SESSION_TTL_MS,
      });
      sendRedirect(res, '/admin', {
        'Cache-Control': 'no-store',
        'Set-Cookie': `${SESSION_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`,
      });
      return;
    }

    if (pathname === '/admin' || pathname.startsWith('/admin/')) {
      const session = getSession(req);
      if (!session) {
        if (req.method === 'GET' || req.method === 'HEAD') {
          sendRedirect(res, '/admin/login');
        } else {
          sendHtml(req, res, 401, layout('Требуется вход', '<main><h1>Сначала войдите в систему</h1></main>'), { 'Cache-Control': 'no-store' });
        }
        return;
      }

      const pages = await readPages(dataFile);
      if ((pathname === '/admin' || pathname === '/admin/') && (req.method === 'GET' || req.method === 'HEAD')) {
        const items = Object.entries(pages).map(([slug, page]) =>
          `<li><a href="/admin/pages/${escapeHtml(slug)}">Редактировать: ${escapeHtml(page.title)}</a>${slug === 'home' ? ' <span class="muted">(главную удалить нельзя)</span>' : ''}</li>`).join('');
        sendHtml(req, res, 200, layout('Управление сайтом', `
          ${header(pages, true)}<main><section class="card">
            <h1>Управление страницами</h1><p class="muted">Выберите страницу, чтобы изменить её заголовок и текст.</p>
            <ul class="pages">${items}</ul>
            <h2>Добавить страницу</h2>
            <form method="post" action="/admin/pages">
              <input type="hidden" name="csrf" value="${session.csrfToken}">
              <label for="new-title">Название страницы</label><input id="new-title" name="title" maxlength="120" required>
              <label for="new-slug">Адрес (латинские буквы, цифры и дефисы)</label><input id="new-slug" name="slug" pattern="[a-z0-9]+(-[a-z0-9]+)*" maxlength="50" placeholder="novosti" required>
              <label for="new-content">Текст страницы</label><textarea id="new-content" name="content" maxlength="10000" required></textarea>
              <button type="submit">Создать страницу</button>
            </form>
            <form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${session.csrfToken}"><button type="submit">Выйти</button></form>
          </section></main>`), { 'Cache-Control': 'no-store' });
        return;
      }

      if (pathname === '/admin/pages' && req.method === 'POST') {
        const form = await readForm(req);
        validateCsrf(form, session);
        const slug = (getFormValue(form, 'slug')).trim();
        const title = (getFormValue(form, 'title')).trim();
        const content = (getFormValue(form, 'content')).trim();
        if (!validateSlug(slug)) {
          throw new HttpError(400, 'Адрес страницы должен содержать только латинские буквы, цифры и дефисы и не совпадать с зарезервированным адресом.');
        }
        if (!title || title.length > 120 || !content || content.length > 10000) {
          throw new HttpError(400, 'Укажите название и текст страницы в допустимых пределах.');
        }
        await savePages((currentPages) => {
          if (currentPages[slug]) throw new HttpError(409, 'Страница с таким адресом уже существует.');
          currentPages[slug] = { title, content, assets: [] };
        });
        sendRedirect(res, `/admin/pages/${slug}`, { 'Cache-Control': 'no-store' });
        return;
      }

      if (pathname === '/admin/logout' && req.method === 'POST') {
        const form = await readForm(req);
        validateCsrf(form, session);
        const id = getCookie(req, SESSION_COOKIE);
        sessions.delete(id);
        sendRedirect(res, '/admin/login', {
          'Cache-Control': 'no-store',
          'Set-Cookie': `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
        });
        return;
      }

      const editorMatch = pathname.match(/^\/admin\/pages\/([a-z0-9-]+)$/i);
      if (editorMatch && (req.method === 'GET' || req.method === 'HEAD')) {
        const slug = editorMatch[1].toLowerCase();
        const page = pages[slug];
        if (!page) {
          sendHtml(req, res, 404, layout('Страница не найдена', '<main><h1>Страница не найдена</h1><a href="/admin">Назад</a></main>'));
          return;
        }
        const assets = page.assets || [];
        const pageLinks = Object.entries(pages)
          .filter(([targetSlug]) => targetSlug !== slug)
          .map(([targetSlug, targetPage]) => `<option value="/${targetSlug === 'home' ? '' : escapeHtml(targetSlug)}">${escapeHtml(targetPage.title)}</option>`)
          .join('');
        const assetOptions = assets.map((asset) =>
          `<option value="${escapeHtml(asset.id)}" data-type="${escapeHtml(asset.type)}">${escapeHtml(asset.name)}</option>`).join('');
        const initialHtml = renderRichText(page.content, pages, assets);
        const assetItems = assets.map((asset) => `<li>
          ${asset.type.startsWith('image/') ? `<img src="/uploads/${escapeHtml(asset.id)}" alt="${escapeHtml(asset.name)}">` : ''}
          <a href="/uploads/${escapeHtml(asset.id)}">${escapeHtml(asset.name)}</a>
          <label><input type="checkbox" name="removeAsset" value="${escapeHtml(asset.id)}"> Удалить файл</label>
        </li>`).join('');
        sendHtml(req, res, 200, layout(`Редактирование: ${page.title}`, `
          ${header(pages, true)}<main><section class="card">
            <p><a href="/admin">← К списку страниц</a></p><h1>Редактирование страницы</h1>
            <form method="post" action="/admin/pages/${escapeHtml(slug)}" enctype="multipart/form-data">
              <input type="hidden" name="csrf" value="${session.csrfToken}">
              <label for="title">Заголовок</label><input id="title" name="title" maxlength="120" value="${escapeHtml(page.title)}" required>
              <label>Содержимое страницы</label>
              <div id="editor-toolbar" class="editor-toolbar" hidden>
                <button type="button" data-command="bold" title="Жирный"><strong>Ж</strong></button>
                <button type="button" data-command="italic" title="Курсив"><em>К</em></button>
                <button type="button" data-command="underline" title="Подчеркнутый"><u>Ч</u></button>
                <button type="button" data-command="insertUnorderedList" title="Маркированный список">• Список</button>
                <button type="button" data-command="insertOrderedList" title="Нумерованный список">1. Список</button>
                <button type="button" data-command="formatBlock" data-value="h2">Заголовок</button>
                <button type="button" data-command="formatBlock" data-value="p">Обычный текст</button>
                <select id="page-link"><option value="">Ссылка на страницу...</option>${pageLinks}</select>
                <button type="button" id="insert-page-link">Вставить ссылку</button>
                <select id="asset-link"><option value="">Изображение или PDF...</option>${assetOptions}</select>
                <button type="button" id="insert-asset">Вставить файл</button>
                <input id="image-width" type="number" min="1" max="2000" step="any" placeholder="Размер" aria-label="Ширина изображения">
                <select id="image-width-unit" class="image-size-unit" aria-label="Единица ширины изображения">
                  <option value="%">%</option><option value="px">px</option>
                </select>
                <button type="button" id="apply-image-width" title="Сначала выберите изображение в тексте">Задать ширину</button>
                <button type="button" id="insert-inline-math" title="Ввести LaTeX-формулу в строку">Формула в строке</button>
                <button type="button" id="insert-display-math" title="Ввести LaTeX-формулу отдельным блоком">Формула отдельным блоком</button>
                <button type="button" id="toggle-formula-preview">Предпросмотр формул</button>
                <button type="button" id="insert-external-link">Внешняя ссылка</button>
                <button type="button" id="toggle-html-source">Редактировать HTML</button>
              </div>
              <div id="rich-editor" class="rich-editor mathjax-ignore" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Содержимое страницы" hidden></div>
              <textarea id="content" name="content" maxlength="30000" required>${escapeHtml(initialHtml)}</textarea>
              <div id="formula-preview" class="formula-preview" aria-label="Предпросмотр формул" hidden></div>
              <dialog id="formula-dialog" class="formula-dialog" aria-labelledby="formula-dialog-title">
                <h2 id="formula-dialog-title">Вставка LaTeX-формулы</h2>
                <label for="formula-source">Код формулы</label>
                <textarea id="formula-source" maxlength="5000" placeholder="Например: \\frac{a}{b}"></textarea>
                <fieldset>
                  <legend>Расположение формулы</legend>
                  <label><input type="radio" name="formula-mode" value="inline" checked> В строке</label>
                  <label><input type="radio" name="formula-mode" value="display"> Отдельным блоком</label>
                </fieldset>
                <div id="formula-dialog-preview" class="formula-preview" aria-label="Предпросмотр формулы"></div>
                <p id="formula-dialog-error" class="formula-error" role="status" aria-live="polite"></p>
                <div class="formula-actions">
                  <button type="button" id="preview-formula">Предпросмотр</button>
                  <button type="button" id="insert-formula">Вставить формулу</button>
                  <button type="button" id="cancel-formula">Отмена</button>
                </div>
              </dialog>
              <label for="uploads">Добавить изображения или PDF (до 4 файлов, по 5 МБ каждый)</label>
              <p class="muted">После загрузки сохраните страницу и откройте редактор заново: тогда файл появится в списке для вставки в позицию курсора.</p>
              <input id="uploads" name="uploads" type="file" accept="image/png,image/jpeg,image/gif,image/webp,application/pdf" multiple>
              ${assets.length ? `<h2>Прикрепленные файлы</h2><ul class="asset-list">${assetItems}</ul>` : ''}
              <div class="actions"><button type="submit">Сохранить</button><a class="button" href="/${slug === 'home' ? '' : escapeHtml(slug)}" target="_blank" rel="noreferrer">Открыть страницу</a></div>
            </form>
            ${slug === 'home' ? '' : `<form method="post" action="/admin/pages/${escapeHtml(slug)}/delete">
              <input type="hidden" name="csrf" value="${session.csrfToken}">
              <button type="submit">Удалить страницу</button>
            </form>`}
          </section></main><script src="/mathjax-config.js"></script><script src="/mathjax/tex-mml-chtml.js" defer></script><script src="/admin-editor.js" defer></script>`), { 'Cache-Control': 'no-store' });
        return;
      }

      const deleteMatch = pathname.match(/^\/admin\/pages\/([a-z0-9-]+)\/delete$/i);
      if (deleteMatch && req.method === 'POST') {
        const slug = deleteMatch[1].toLowerCase();
        if (slug === 'home') throw new HttpError(400, 'Главную страницу удалить нельзя.');
        if (!pages[slug]) {
          sendHtml(req, res, 404, layout('Страница не найдена', '<main><h1>Страница не найдена</h1></main>'));
          return;
        }
        const form = await readForm(req);
        validateCsrf(form, session);
        const removedAssets = pages[slug].assets || [];
        await savePages((currentPages) => {
          if (!currentPages[slug]) throw new HttpError(404, 'Страница не найдена.');
          delete currentPages[slug];
        });
        await removeAssets(removedAssets);
        sendRedirect(res, '/admin', { 'Cache-Control': 'no-store' });
        return;
      }

      if (editorMatch && req.method === 'POST') {
        const slug = editorMatch[1].toLowerCase();
        if (!pages[slug]) {
          sendHtml(req, res, 404, layout('Страница не найдена', '<main><h1>Страница не найдена</h1></main>'));
          return;
        }
        const { fields, files } = await readMultipartForm(req);
        validateCsrf(fields, session);
        const title = getFormValue(fields, 'title').trim();
        const content = sanitizeRichText(getFormValue(fields, 'content'), pages, pages[slug].assets || []).trim();
        if (!title || title.length > 120 || !content || content.length > 30000) {
          throw new HttpError(400, 'Title and content are required and must fit the length limits.');
        }
        const removedIds = getFormValues(fields, 'removeAsset');
        const currentAssets = pages[slug].assets || [];
        const assetsToRemove = currentAssets.filter((asset) => removedIds.includes(asset.id));
        const retainedAssets = currentAssets.filter((asset) => !removedIds.includes(asset.id));
        if (retainedAssets.length + files.filter((file) => file.buffer.length > 0).length > MAX_UPLOADS_PER_PAGE) {
          throw new HttpError(400, `На одной странице может быть не более ${MAX_UPLOADS_PER_PAGE} файлов.`);
        }
        const newAssets = await storeUploads(files);
        try {
          await savePages((currentPages) => {
            if (!currentPages[slug]) throw new HttpError(404, 'Страница не найдена.');
            currentPages[slug] = { title, content, assets: [...retainedAssets, ...newAssets] };
          });
        } catch (error) {
          await removeAssets(newAssets);
          throw error;
        }
        await removeAssets(assetsToRemove);
        sendRedirect(res, `/admin/pages/${slug}`, { 'Cache-Control': 'no-store' });
        return;
      }

      if (pathname === '/admin' || pathname.startsWith('/admin/')) {
        sendHtml(req, res, 405, layout('Метод не поддерживается', '<main><h1>Метод не поддерживается</h1></main>'), { Allow: 'GET, HEAD, POST' });
        return;
      }
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(req, res, 405, { error: 'Method Not Allowed' });
      return;
    }

    const pages = await readPages(dataFile);
    const slug = pathname === '/' ? 'home' : pathname.slice(1);
    const page = pages[slug];
    if (!page) {
      sendHtml(req, res, 404, layout('Страница не найдена', `
        ${header(pages)}<main><section class="card"><h1>Страница не найдена</h1><p><a href="/">На главную</a></p></section></main>`));
      return;
    }

    const paragraphs = renderRichText(page.content, pages, page.assets || []);
    const pageAssets = (page.assets || []).filter((asset) => !paragraphs.includes(`/uploads/${asset.id}`)).map((asset) => asset.type.startsWith('image/')
      ? `<figure><a href="/uploads/${escapeHtml(asset.id)}"><img src="/uploads/${escapeHtml(asset.id)}" alt="${escapeHtml(asset.name)}" style="max-width:100%;height:auto"></a><figcaption>${escapeHtml(asset.name)}</figcaption></figure>`
      : `<p><a href="/uploads/${escapeHtml(asset.id)}">Открыть PDF: ${escapeHtml(asset.name)}</a></p>`).join('');
    const currentDateTime = new Date();
    const dateTimeDisplay = slug === 'home' ? `
      <section class="datetime" aria-label="Текущие дата и время">
        <p><strong>Дата:</strong> <time datetime="${currentDateTime.toISOString()}">${escapeHtml(currentDateTime.toLocaleDateString('ru-RU'))}</time></p>
        <p><strong>Время:</strong> <time datetime="${currentDateTime.toISOString()}">${escapeHtml(currentDateTime.toLocaleTimeString('ru-RU'))}</time></p>
      </section>` : '';
    const articleClass = slug === 'unification' || slug === 'phase-space' ? 'card project-story' : 'card';
    sendHtml(req, res, 200, layout(page.title, `
      ${header(pages)}<main><article class="${articleClass}"><h1>${escapeHtml(page.title)}</h1>${dateTimeDisplay}${paragraphs}${pageAssets}</article></main>
      <footer>Сайт Е.М. Бениаминова</footer><script src="/mathjax-config.js"></script><script src="/mathjax/tex-mml-chtml.js" defer></script>`));
  }

  return http.createServer((req, res) => {
    handleRequest(req, res).catch((error) => {
      if (error instanceof HttpError) {
        sendHtml(req, res, error.statusCode, layout('Ошибка запроса', `
          <main><section class="card"><h1>Не удалось выполнить запрос</h1><p class="error">${escapeHtml(error.message)}</p></section></main>`), {
          'Cache-Control': 'no-store',
        });
        return;
      }
      console.error('Request failed:', error);
      if (!res.headersSent) {
        sendHtml(req, res, 500, layout('Внутренняя ошибка', '<main><h1>Внутренняя ошибка сервера</h1></main>'));
      } else {
        res.destroy(error);
      }
    });
  });
}

function parsePort(value) {
  if (value.trim() === '') {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('PORT must be an integer between 0 and 65535.');
  }

  return port;
}

function startServer({
  host = process.env.HOST || '0.0.0.0',
  port = parsePort(process.env.PORT || '3000'),
} = {}) {
  const server = createServer();

  server.on('error', (error) => {
    console.error('HTTP server error:', error);
    process.exitCode = 1;
  });

  server.listen(port, host, () => {
    const address = server.address();
    const browserHost = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
    console.log(`Server listening on ${host}:${address.port}; open http://${browserHost}:${address.port}/`);
  });

  return server;
}

if (require.main === module) {
  try {
    const server = startServer();
    const shutdown = (signal) => {
      console.log(`${signal} received; closing server...`);
      const forceCloseTimer = setTimeout(() => server.closeAllConnections(), 10_000);
      forceCloseTimer.unref();
      server.close((error) => {
        if (error) {
          console.error('Error while closing HTTP server:', error);
          process.exitCode = 1;
          return;
        }
        console.log('Server stopped.');
      });
    };

    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error('Unable to start HTTP server:', error.message);
    process.exitCode = 1;
  }
}

module.exports = { createServer, startServer };
