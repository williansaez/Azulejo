#!/usr/bin/env node
// Servidor local para assistir à arena no navegador (Node 20+, sem dependências).
// Serve a raiz do repositório (o jogo em / e a arena em /arena/) e faz de proxy
// para os modelos, para evitar CORS e não pôr chaves na página:
//   /ollama/*   -> ${OLLAMA_URL   || http://localhost:11434}/*
//   /ollama2/*  -> ${OLLAMA_URL2  || OLLAMA_URL || http://localhost:11434}/*  (um segundo
//                  Ollama, ex.: um lado do duelo noutra máquina ou porta)
//   /typesafe/* -> ${TYPESAFE_URL || https://api.typesafe.ai}/*  (+ Authorization
//                  Bearer ${TYPESAFE_API_KEY}, se definida e o pedido não trouxer)
//
//   node arena/servir.mjs [--porta 8080]        (ou PORT=8080)
//   abra http://localhost:8080/arena/

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: a } = parseArgs({ options: { porta: { type: 'string' }, host: { type: 'string' } } });
const PORT = Number(a.porta || process.env.PORT || 8080);
const HOST = a.host || process.env.HOST || '127.0.0.1';

const PROXIES = {
  '/ollama': { target: process.env.OLLAMA_URL || 'http://localhost:11434' },
  '/ollama2': { target: process.env.OLLAMA_URL2 || process.env.OLLAMA_URL || 'http://localhost:11434' },
  '/typesafe': { target: process.env.TYPESAFE_URL || 'https://api.typesafe.ai', key: process.env.TYPESAFE_API_KEY || '' },
};

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.jsonl': 'application/x-ndjson',
};
// Cabeçalhos que não passam pelo proxy (hop-by-hop, ou que identificariam a página).
const DROP = new Set(['host', 'connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade',
  'te', 'trailer', 'origin', 'referer', 'cookie']);

function proxy(req, res, prefix, { target, key }) {
  const rest = req.url.slice(prefix.length) || '/';
  const url = new URL(target.replace(/\/$/, '') + (rest.startsWith('/') ? rest : '/' + rest));
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) if (!DROP.has(k)) headers[k] = v;
  if (key && !headers.authorization) headers.authorization = `Bearer ${key}`;
  const lib = url.protocol === 'https:' ? https : http;
  const up = lib.request(url, { method: req.method, headers }, upRes => {
    const out = {};
    for (const [k, v] of Object.entries(upRes.headers)) if (!DROP.has(k) && !k.startsWith('access-control-')) out[k] = v;
    res.writeHead(upRes.statusCode || 502, out);
    upRes.pipe(res); // resposta em streaming (inclui stream: true do Ollama)
  });
  up.on('error', e => {
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `proxy ${prefix}: sem resposta de ${url.origin} (${e.code || e.message})` }));
  });
  req.on('aborted', () => up.destroy());
  req.pipe(up); // corpo do pedido em streaming
}

function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
  let file = path.join(ROOT, path.normalize(p));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) { res.writeHead(403); return res.end(); }
  let st = fs.statSync(file, { throwIfNoEntry: false });
  if (st?.isDirectory()) {
    if (!p.endsWith('/')) { res.writeHead(301, { Location: p + '/' }); return res.end(); }
    file = path.join(file, 'index.html');
    st = fs.statSync(file, { throwIfNoEntry: false });
  }
  if (!st?.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('não encontrado'); }
  res.writeHead(200, {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': st.size,
    'Cache-Control': 'no-cache',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  for (const [prefix, cfg] of Object.entries(PROXIES)) {
    if (req.url === prefix || req.url.startsWith(prefix + '/')) return proxy(req, res, prefix, cfg);
  }
  serveStatic(req, res);
});
server.on('error', e => { console.error(`Erro: ${e.message}`); process.exit(1); });
server.listen(PORT, HOST, () => {
  const shown = HOST === '127.0.0.1' || HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`Arena do Azulejo: abra http://${shown}:${PORT}/arena/`);
  console.log(`  /ollama   -> ${PROXIES['/ollama'].target}`);
  console.log(`  /ollama2  -> ${PROXIES['/ollama2'].target}`);
  console.log(`  /typesafe -> ${PROXIES['/typesafe'].target}${PROXIES['/typesafe'].key ? ' (com TYPESAFE_API_KEY)' : ''}`);
  console.log('  Ctrl-C para parar.');
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { server.close(); process.exit(0); });
