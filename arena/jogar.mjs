#!/usr/bin/env node
// Arena do Azulejo das Palavras: um backend de IA joga no navegador real
// (Playwright) e medimos vitórias, tentativas, tempo e latência por jogada.
//
//   node arena/jogar.mjs --backend code|ollama|jev [--jogos 3] [--letras 5]
//     [--variante pt|br] [--tentativas 6] [--url URL] [--local]
//     [--model qwen3.5:9b] [--opcoes 8] [--visivel] [--saida arena/resultados]

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { buildList, candidates, rankGuesses, describeOptions, describeState } from './solver.mjs';
import { loadBackend, pick } from './backends/index.mjs';

const ARENA_DIR = path.dirname(fileURLToPath(import.meta.url));
const GAME_DIR = path.resolve(ARENA_DIR, '..');
const LIVE_URL = 'https://datm83.github.io/Azulejo/';

const { values: a } = parseArgs({
  options: {
    backend: { type: 'string', default: 'code' },
    jogos: { type: 'string', default: '3' },
    letras: { type: 'string', default: '5' },
    variante: { type: 'string', default: 'pt' },
    tentativas: { type: 'string', default: '6' },
    url: { type: 'string' },
    local: { type: 'boolean', default: false },
    model: { type: 'string' },
    opcoes: { type: 'string', default: '8' },
    visivel: { type: 'boolean', default: false },
    saida: { type: 'string' },
    ajuda: { type: 'boolean', short: 'h', default: false },
  },
});
if (a.ajuda) {
  console.log(fs.readFileSync(path.join(ARENA_DIR, 'LEIA-ME.txt'), 'utf8'));
  process.exit(0);
}
const cfg = {
  backend: a.backend,
  jogos: Math.max(1, parseInt(a.jogos, 10) || 1),
  len: Number(a.letras),
  v: a.variante,
  tries: Number(a.tentativas),
  k: Math.max(2, parseInt(a.opcoes, 10) || 8),
};
if (![4, 5, 6].includes(cfg.len)) fail('--letras deve ser 4, 5 ou 6');
if (!['pt', 'br'].includes(cfg.v)) fail('--variante deve ser pt ou br');
if (![4, 6, 10].includes(cfg.tries)) fail('--tentativas deve ser 4, 6 ou 10');
const outDir = a.saida ? path.resolve(a.saida) : path.join(ARENA_DIR, 'resultados');

function fail(msg) { console.error(`Erro: ${msg}`); process.exit(2); }

// ---------- Playwright ----------
async function loadPlaywright() {
  try {
    const m = await import('playwright');
    return m.chromium ? m : m.default;
  } catch {
    // instalação global (ex.: NODE_PATH): o import ESM não usa NODE_PATH, o require sim
    return createRequire(import.meta.url)(process.env.PLAYWRIGHT_GLOBAL || 'playwright');
  }
}
function chromiumPath() {
  const p = process.env.PW_CHROMIUM || '/opt/pw-browsers/chromium';
  return fs.existsSync(p) ? p : undefined;
}

// ---------- servidor local (--local) ----------
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
function serveLocal() {
  const server = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const file = path.join(GAME_DIR, path.normalize(p));
    if (!file.startsWith(GAME_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ---------- jogo ----------
// Lê az-cur sem a palavra secreta (secret e key ficam na página).
const readState = page => page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('az-cur') || 'null');
  if (!s) return null;
  const { secret, key, ...rest } = s;
  return rest;
});

// Digita a palavra e espera: 'ok' (tentativa registada) ou 'invalida' (toast do dicionário).
async function submitWord(page, word, prevCount) {
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; });
  await page.keyboard.type(word);
  await page.keyboard.press('Enter');
  const h = await page.waitForFunction(prev => {
    const s = JSON.parse(localStorage.getItem('az-cur') || 'null');
    if (s && s.guesses.length > prev) return 'ok';
    const t = document.getElementById('toast');
    if (t && !t.hidden && /dicion/.test(t.textContent)) return 'invalida';
    return false;
  }, prevCount, { timeout: 10000, polling: 20 });
  return h.jsonValue();
}
async function clearRow(page, len) { for (let i = 0; i < len + 1; i++) await page.keyboard.press('Backspace'); }

const lists = new Map(), openers = new Map();
function getEntries(W, v, len) {
  const id = v + len;
  if (!lists.has(id)) lists.set(id, buildList(W.secret[v][String(len)].split(' ')));
  return lists.get(id);
}

async function playGame(browser, url, backend, n) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.addInitScript(prefs => {
      localStorage.setItem('az-prefs2', JSON.stringify(prefs));
      localStorage.setItem('az-cur', 'null');
    }, { v: cfg.v, len: cfg.len, tries: cfg.tries });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#play');
    const W = await page.evaluate(() => JSON.parse(document.getElementById('words').textContent));
    const entries = getEntries(W, cfg.v, cfg.len);

    await page.click('#play');
    const t0 = Date.now(); // "tempo depois do start"
    await page.evaluate(() => document.activeElement?.blur());

    const moves = [];
    let S = await readState(page);
    if (!S || S.done || S.guesses.length) throw new Error('o jogo não começou limpo');
    while (!S.done) {
      if (stopping) throw new Error('interrompido');
      const cands = candidates(entries, S.guesses);
      const openerId = cfg.v + cfg.len;
      let ranked;
      if (S.guesses.length === 0 && openers.has(openerId)) ranked = openers.get(openerId);
      else {
        ranked = rankGuesses(entries, cands);
        if (S.guesses.length === 0) openers.set(openerId, ranked);
      }
      const options = describeOptions(ranked, cands, cfg.k);
      const ids = options.map(o => o.id);
      const ctx = { state: describeState(S, cands, entries.length), options, ids, codeChoice: ids[0] };

      const r = await pick(backend, ctx);
      let word = r.id, invalidWord = false;
      let res = await submitWord(page, word, S.guesses.length);
      if (res === 'invalida') {
        invalidWord = true;
        await clearRow(page, cfg.len);
        word = ctx.codeChoice;
        res = await submitWord(page, word, S.guesses.length);
        if (res !== 'ok') throw new Error(`palavra recusada duas vezes: ${word}`);
      }
      moves.push({
        word, latencyMs: r.latencyMs, invalid: r.invalid || invalidWord,
        ...(invalidWord ? { palavraRecusada: r.id } : {}),
        tokens: { entrada: r.tokensIn, saida: r.tokensOut },
        candidatesBefore: cands.length, opcoes: ids.length,
        igualAoCodigo: !r.invalid && r.id === ctx.codeChoice,
        ...(r.motivo ? { motivo: r.motivo } : {}),
        ...(r.erro ? { erro: r.erro } : {}),
      });
      if (r.erro && process.env.ARENA_DEBUG) console.error(`  [jogada ${moves.length}] ${r.erro}`);
      S = await readState(page);
    }
    const tempoTotalMs = Date.now() - t0;
    const secret = await page.evaluate(() => JSON.parse(localStorage.getItem('az-cur')).secret); // só depois do fim
    return {
      jogo: n, data: new Date().toISOString(), url,
      backend: backend.name, model: backend.model, len: cfg.len, variant: cfg.v, tries: cfg.tries,
      won: !!S.won, tentativas: S.guesses.length,
      guesses: S.guesses.map(g => ({ word: g.word, key: g.key, res: g.res })),
      secret, tempoTotalMs,
      tempoModeloMs: moves.reduce((s, m) => s + m.latencyMs, 0),
      moves,
    };
  } finally {
    await context.close().catch(() => {});
  }
}

// ---------- resumo ----------
const fmt = (x, d = 0) => x.toLocaleString('pt-BR', { minimumFractionDigits: d, maximumFractionDigits: d });
const secs = ms => `${fmt(ms / 1000, 2)} s`;
function printSummary(games, backend) {
  console.log('');
  console.log(`Resumo: backend ${backend.name} (${backend.model}), ${cfg.len} letras, variante ${cfg.v}, ${cfg.tries} tentativas`);
  if (!games.length) { console.log('  Nenhum jogo terminado.'); return; }
  const pad = (s, n) => String(s).padEnd(n);
  console.log('  ' + pad('#', 4) + pad('segredo', 12) + pad('resultado', 11) + pad('tentativas', 12) + pad('tempo total', 13) + 'tempo modelo');
  for (const g of games) {
    console.log('  ' + pad(g.jogo, 4) + pad(g.secret, 12) + pad(g.won ? 'vitória' : 'derrota', 11) +
      pad(`${g.tentativas}/${g.tries}`, 12) + pad(secs(g.tempoTotalMs), 13) + secs(g.tempoModeloMs));
  }
  const moves = games.flatMap(g => g.moves);
  const won = games.filter(g => g.won);
  const inv = moves.filter(m => m.invalid).length;
  const agree = moves.filter(m => m.igualAoCodigo).length;
  const tin = moves.reduce((s, m) => s + m.tokens.entrada, 0), tout = moves.reduce((s, m) => s + m.tokens.saida, 0);
  const rows = [
    ['Jogos', games.length],
    ['Vitórias', `${won.length} (${fmt(100 * won.length / games.length)}%)`],
    ['Média de tentativas (todos)', fmt(games.reduce((s, g) => s + g.tentativas, 0) / games.length, 2)],
    ['Média de tentativas (vitórias)', won.length ? fmt(won.reduce((s, g) => s + g.tentativas, 0) / won.length, 2) : '-'],
    ['Tempo médio total por jogo', secs(games.reduce((s, g) => s + g.tempoTotalMs, 0) / games.length)],
    ['Latência média por jogada', `${fmt(moves.reduce((s, m) => s + m.latencyMs, 0) / moves.length, 1)} ms`],
    ['Jogadas', moves.length],
    ['Respostas inválidas', `${inv} (${fmt(100 * inv / moves.length)}%)`],
    ['Igual à escolha do código', `${agree} (${fmt(100 * agree / moves.length)}%)`],
    ['Tokens entrada / saída', `${fmt(tin)} / ${fmt(tout)}`],
  ];
  console.log('');
  for (const [k, v] of rows) console.log('  ' + pad(k, 34) + v);
}

// ---------- principal ----------
let stopping = false;
async function main() {
  const backend = await loadBackend(cfg.backend, { model: a.model });
  if (backend.name === 'jev' && !process.env.TYPESAFE_API_KEY) console.warn('Aviso: TYPESAFE_API_KEY não definida; todas as jogadas vão cair no código e contar como inválidas.');
  const { chromium } = await loadPlaywright();
  const server = a.local ? await serveLocal() : null;
  const url = server ? `http://127.0.0.1:${server.address().port}/index.html` : (a.url || LIVE_URL);
  const browser = await chromium.launch({ headless: !a.visivel, executablePath: chromiumPath() });

  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outFile = path.join(outDir, `${backend.name}-${stamp}.jsonl`);
  const games = [];
  let finished = false;
  const finish = async code => {
    if (finished) return; finished = true;
    printSummary(games, backend);
    const rel = path.relative(process.cwd(), outFile);
    console.log(`\n  Resultados: ${games.length ? (rel.startsWith('..') ? outFile : rel) : '(nenhum jogo gravado)'}`);
    await browser.close().catch(() => {});
    server?.close();
    process.exit(code);
  };
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    console.log('\nInterrompido (Ctrl-C). Resumo do que foi jogado:');
    finish(130);
  });

  console.log(`Arena Azulejo: ${cfg.jogos} jogo(s), backend ${backend.name} (${backend.model}), ${url}`);
  for (let i = 1; i <= cfg.jogos && !stopping; i++) {
    try {
      const g = await playGame(browser, url, backend, i);
      if (stopping) break;
      games.push(g);
      fs.appendFileSync(outFile, JSON.stringify(g) + '\n');
      const seq = g.guesses.map(x => x.word.toUpperCase()).join(' > ');
      console.log(`  jogo ${i}: ${g.won ? 'vitória' : 'derrota'} em ${g.tentativas}/${g.tries} (${secs(g.tempoTotalMs)}) ${seq}  [segredo: ${g.secret}]`);
    } catch (e) {
      if (stopping) break;
      console.error(`  jogo ${i}: erro: ${e.message}`);
    }
  }
  if (!stopping) await finish(0);
}
main().catch(e => { console.error(e); process.exit(1); });
