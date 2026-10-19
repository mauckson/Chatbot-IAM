// Zero-dependency local server: serves public/ and routes /api/chat to api/chat.js,
// the same way Vercel does. Reads GROQ_API_KEY / GROQ_MODEL from .env.local or .env.
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

export function loadEnvFiles() {
  for (const name of ['.env.local', '.env']) {
    const file = path.join(ROOT, name);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match) continue;
      let value = match[2];
      if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
      if (process.env[match[1]] === undefined) process.env[match[1]] = value;
    }
  }
}

// Apply the same response headers vercel.json gives every route.
function vercelHeaders() {
  try {
    const config = JSON.parse(readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    return (config.headers || [])
      .filter((rule) => rule.source === '/(.*)')
      .flatMap((rule) => rule.headers);
  } catch {
    return [];
  }
}

async function handleApi(req, res, handler) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) value.forEach((v) => headers.append(key, v));
    else if (value !== undefined) headers.set(key, value);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const request = new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? Readable.toWeb(req) : undefined,
    duplex: hasBody ? 'half' : undefined,
  });
  const response = await handler.fetch(request);
  res.writeHead(response.status, Object.fromEntries(response.headers));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function serveStatic(req, res, pathname) {
  let relative;
  try {
    relative = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400).end('Bad request');
    return;
  }
  let filePath = path.join(PUBLIC_DIR, path.normalize(relative));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    if ((await stat(filePath)).isDirectory()) filePath = path.join(filePath, 'index.html');
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

export async function startDevServer({ port = Number(process.env.PORT) || 3000, handler } = {}) {
  const chat = handler || (await import(pathToFileURL(path.join(ROOT, 'api', 'chat.js')).href)).default;
  const sharedHeaders = vercelHeaders();

  const server = createServer(async (req, res) => {
    for (const { key, value } of sharedHeaders) res.setHeader(key, value);
    const { pathname } = new URL(req.url, 'http://localhost');
    try {
      if (pathname === '/api/chat') await handleApi(req, res, chat);
      else if (req.method === 'GET' || req.method === 'HEAD') await serveStatic(req, res, pathname);
      else res.writeHead(405, { Allow: 'GET, HEAD' }).end('Method not allowed');
    } catch (err) {
      console.error('[dev-server]', err);
      if (!res.headersSent) res.writeHead(500);
      res.end('Server error');
    }
  });

  await new Promise((resolve) => server.listen(port, resolve));
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadEnvFiles();
  const server = await startDevServer();
  const { port } = server.address();
  console.log(`Orbit is running at http://localhost:${port}`);
  if (!process.env.GROQ_API_KEY) {
    console.log('GROQ_API_KEY is not set, so chat requests will show a setup error. Add it to .env.local.');
  }
}
