#!/usr/bin/env node
// Arena do Azulejo das Palavras: um backend de IA joga no navegador real
// (Playwright) e medimos vitórias, tentativas, tempo e latência por jogada.
//
//   node arena/jogar.mjs --backend code|ollama|jev [--jogos 3] [--letras 4..9|extremo|invisivel]
//     [--variante pt|br] [--tentativas 6] [--url URL] [--local]
//     [--model qwen3.5:9b] [--opcoes 8] [--pensar] [--visivel] [--ritmo MS] [--saida arena/resultados]
//
// --letras invisivel é o modo livre: o modelo inventa cada palavra (livre.mjs),
// sem opções do código; só o backend ollama joga.

import { parseArgs } from 'node:util';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { loadDict, suggest, describeOptions, describeState, lastTryOnly } from './solver.mjs';
import { loadBackend, pick } from './backends/index.mjs';
import * as Livre from './livre.mjs';

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
    pensar: { type: 'boolean', default: false },
    visivel: { type: 'boolean', default: false },
    ritmo: { type: 'string' },
    saida: { type: 'string' },
    ajuda: { type: 'boolean', short: 'h', default: false },
  },
});
if (a.ajuda) {
  console.log(fs.readFileSync(path.join(ARENA_DIR, 'LEIA-ME.txt'), 'utf8'));
  process.exit(0);
}
// Pausa (ms) depois de cada jogada e no fim de cada jogo, para dar tempo de ver.
// Não entra no tempo medido. Com --visivel e sem --ritmo, usa 900 ms.
const ritmo = a.ritmo != null ? Math.max(0, parseInt(a.ritmo, 10) || 0) : (a.visivel ? 900 : 0);
const letras = String(a.letras).toLowerCase();
const extremo = ['extremo', 'x'].includes(letras);
const livre = ['invisivel', 'invisível', 'i', 'livre'].includes(letras);
const cfg = {
  backend: a.backend,
  jogos: Math.max(1, parseInt(a.jogos, 10) || 1),
  // valor de az-prefs2.len: 4..9, 'x' (Extremo, 10 a 13 sorteado pelo jogo) ou
  // 'i' (Invisível: 4 a 9 sorteado e escondido; modo livre)
  len: extremo ? 'x' : livre ? 'i' : Number(letras),
  v: a.variante,
  tries: Number(a.tentativas),
  k: Math.max(2, parseInt(a.opcoes, 10) || 8),
};
if (!extremo && !livre && ![4, 5, 6, 7, 8, 9].includes(cfg.len)) fail('--letras deve ser 4 a 9, extremo ou invisivel');
const lenLabel = extremo ? 'Extremo (10 a 13 letras)' : livre ? 'invisível (livre): 4 a 9 letras, tamanho escondido' : `${cfg.len} letras`;
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
// Invisível: também sem len (o jogador não vê o tamanho). Tudo é removido
// dentro da página; o Node nunca recebe estes campos antes do fim.
const readStateFree = page => page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('az-cur') || 'null');
  if (!s) return null;
  const { secret, key, len, ...rest } = s;
  return rest;
});
// Estado completo, só depois de done (para o registro).
const readFinal = page => page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('az-cur') || 'null');
  if (!s || !s.done) throw new Error('o jogo ainda não terminou');
  return { secret: s.secret, len: s.len, key: s.key };
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
    if (t && !t.hidden && /não está no dicion/.test(t.textContent)) return 'invalida';
    return false;
  }, prevCount, { timeout: 10000, polling: 20 });
  return h.jsonValue();
}
async function clearRow(page, len) { for (let i = 0; i < len + 1; i++) await page.keyboard.press('Backspace'); }

// Invisível: digita (letras + Enter) e espera a tentativa entrar em az-cur.
// Se o dicionário daquele tamanho ainda não estava no jogo, aparece
// "Carregando dicionário…" e o jogo envia sozinho quando acaba (até 15 s).
// Devolve 'ok', 'invalida' (não está no dicionário), 'curta' ou 'erro'.
async function submitFree(page, word, prevCount) {
  await page.evaluate(() => { const t = document.getElementById('toast'); if (t) t.hidden = true; });
  await page.keyboard.type(word);
  await page.keyboard.press('Enter');
  const look = (allowLoading) => page.waitForFunction(([prev, allowLoading]) => {
    const s = JSON.parse(localStorage.getItem('az-cur') || 'null');
    if (s && s.guesses.length > prev) return 'ok';
    const t = document.getElementById('toast');
    const msg = t && !t.hidden ? t.textContent : '';
    if (/não está no dicion/.test(msg)) return 'invalida';
    if (/pelo menos 4 letras/.test(msg)) return 'curta';
    if (/Não foi possível carregar/.test(msg)) return 'erro';
    if (allowLoading && /Carregando dicion/.test(msg)) return 'carregando';
    return false;
  }, [prevCount, allowLoading], { timeout: allowLoading ? 10000 : 15000, polling: 20 }).then(h => h.jsonValue());
  let r = await look(true);
  if (r === 'carregando') r = await look(false); // espera o envio automático depois da carga
  return r;
}

// Dicionário do tamanho sorteado: do disco com --local, senão de <url>/dicionario/<n>.json.
// Fica em cache (loadDict) e a primeira jogada também (openers), por tamanho e variante.
const openers = new Map();
function getDict(n, url) {
  return a.local ? loadDict(n, { rootDir: GAME_DIR }) : loadDict(n, { root: url, fetchImpl: fetch });
}
function getAllDicts(url) {
  return Livre.loadAllDicts(a.local ? { rootDir: GAME_DIR } : { root: url, fetchImpl: fetch });
}

async function playGame(browser, url, backend, n) {
  if (livre) return playFreeGame(browser, url, backend, n);
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.addInitScript(prefs => {
      localStorage.setItem('az-prefs2', JSON.stringify(prefs));
      localStorage.setItem('az-cur', 'null');
    }, { v: cfg.v, len: cfg.len, tries: cfg.tries });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#play');

    await page.click('#play');
    // o jogo pode carregar o dicionário antes de gravar o estado: espera um az-cur novo
    await page.waitForFunction(() => {
      const s = JSON.parse(localStorage.getItem('az-cur') || 'null');
      return !!(s && s.secret && !s.done && s.guesses.length === 0);
    }, null, { timeout: 30000, polling: 50 });
    await page.evaluate(() => document.activeElement?.blur());
    let S = await readState(page);
    if (!S || S.done || S.guesses.length) throw new Error('o jogo não começou limpo');
    const len = S.len; // tamanho real (no Extremo, sorteado entre 10 e 13)
    const D = await getDict(len, url);
    const t0 = Date.now(); // "tempo depois do start" (com o jogo e o dicionário prontos)
    let pausas = 0;

    const moves = [];
    while (!S.done) {
      if (stopping) throw new Error('interrompido');
      const openerId = cfg.v + len;
      let sug;
      if (S.guesses.length === 0 && openers.has(openerId)) sug = openers.get(openerId);
      else {
        sug = suggest(D, S.guesses, cfg.v, 5, S.dica || null);
        if (S.guesses.length === 0) openers.set(openerId, sug);
      }
      if (S.guesses.length === S.tries - 1) sug = lastTryOnly(sug); // última tentativa: só candidatas
      const cands = sug.cands;
      if (!cands.length) throw new Error('nenhuma palavra do dicionário combina com as cores (dicionário diferente do jogo?)');
      const options = describeOptions(sug, cfg.k);
      const ids = options.map(o => o.id);
      const ctx = { state: describeState(S, cands.length, D.keys.length, sug.mode), options, ids, codeChoice: ids[0] };

      const r = await pick(backend, ctx);
      let word = r.id, invalidWord = false;
      let res = await submitWord(page, word, S.guesses.length);
      if (res === 'invalida') {
        invalidWord = true;
        await clearRow(page, len);
        word = ctx.codeChoice;
        res = await submitWord(page, word, S.guesses.length);
        if (res !== 'ok') throw new Error(`palavra recusada duas vezes: ${word}`);
      }
      moves.push({
        word, latencyMs: r.latencyMs, invalid: r.invalid || invalidWord,
        ...(invalidWord ? { palavraRecusada: r.id } : {}),
        tokens: { entrada: r.tokensIn, saida: r.tokensOut },
        candidatesBefore: cands.length, modoSolver: sug.mode, opcoes: ids.length,
        igualAoCodigo: !r.invalid && r.id === ctx.codeChoice,
        ...(r.motivo ? { motivo: r.motivo } : {}),
        ...(r.thinkTokens ? { thinkTokens: r.thinkTokens } : {}),
        ...(r.erro ? { erro: r.erro } : {}),
      });
      if (r.erro && process.env.ARENA_DEBUG) console.error(`  [jogada ${moves.length}] ${r.erro}`);
      S = await readState(page);
      if (ritmo) { await page.waitForTimeout(ritmo); pausas += ritmo; }
    }
    const tempoTotalMs = Date.now() - t0 - pausas;
    if (ritmo) await page.waitForTimeout(ritmo * 3); // deixa a tela de fim visível
    const secret = await page.evaluate(() => JSON.parse(localStorage.getItem('az-cur')).secret); // só depois do fim
    return {
      jogo: n, data: new Date().toISOString(), url,
      backend: backend.name, model: backend.model, len, ...(S.modo ? { modo: S.modo } : {}), variant: cfg.v, tries: cfg.tries,
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


// ---------- modo livre (Invisível) ----------
// O modelo inventa cada palavra a partir do estado visível (livre.mjs). O
// harness nunca lê len, secret nem key antes de done: readStateFree remove
// esses campos dentro da página e Livre.assertHidden confere a cada rodada.
async function playFreeGame(browser, url, backend, n) {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    await context.addInitScript(prefs => {
      localStorage.setItem('az-prefs2', JSON.stringify(prefs));
      localStorage.setItem('az-cur', 'null');
    }, { v: cfg.v, len: 'i', tries: cfg.tries });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#play');
    // todos os dicionários de 4 a 13 (cada palpite valida no do seu tamanho); em cache
    const dicts = await getAllDicts(url);

    await page.click('#play');
    // espera um jogo novo (o jogo carrega o dicionário do segredo antes de gravar
    // az-cur); só devolve true/false: nenhum campo escondido sai da página
    await page.waitForFunction(() => {
      const s = JSON.parse(localStorage.getItem('az-cur') || 'null');
      return !!(s && s.modo === 'invisivel' && !s.done && s.guesses.length === 0);
    }, null, { timeout: 30000, polling: 50 });
    await page.evaluate(() => document.activeElement?.blur());
    let S = Livre.assertHidden(await readStateFree(page));
    if (!S || S.done || S.guesses.length) throw new Error('o jogo não começou limpo');
    const campos = Object.keys(S).sort();
    console.log(`  [jogo ${n}] estado visto pelo agente: ${campos.join(', ')} (sem ${Livre.HIDDEN.join('/')}: ${Livre.HIDDEN.every(k => !(k in S)) ? 'ok' : 'FALHOU'})`);
    const t0 = Date.now();
    let pausas = 0, leituras = 1;

    const moves = [];
    while (!S.done) {
      if (stopping) throw new Error('interrompido');
      const m = await Livre.freeMove(backend, S, { dicts, v: cfg.v });
      let word = m.word, res = await submitFree(page, word, S.guesses.length);
      const recusadasPeloJogo = [];
      // não deveria acontecer (validamos com os mesmos dicionários), mas: apaga e sorteia outra
      for (let k = 0; res !== 'ok' && k < 5; k++) {
        recusadasPeloJogo.push({ palavra: word, resultado: res });
        await clearRow(page, Livre.MAX);
        word = Livre.randomWord(dicts, new Set([...S.guesses.map(g => g.key), ...recusadasPeloJogo.map(x => x.palavra)]));
        m.fallback = true; m.word = word; m.display = Livre.displayFor(dicts.get(word.length), word, cfg.v);
        res = await submitFree(page, word, S.guesses.length);
      }
      if (res !== 'ok') throw new Error(`o jogo recusou as palavras: ${recusadasPeloJogo.map(x => x.palavra).join(', ')}`);
      moves.push(Livre.moveRecord(m, recusadasPeloJogo.length ? { recusadasPeloJogo } : {}));
      if (process.env.ARENA_DEBUG) for (const p of m.propostas) if (!p.valida) console.error(`  [jogada ${moves.length}] ${p.palavra}: ${p.motivo_rejeicao}`);
      S = Livre.assertHidden(await readStateFree(page)); leituras++;
      if (ritmo) { await page.waitForTimeout(ritmo); pausas += ritmo; }
    }
    const tempoTotalMs = Date.now() - t0 - pausas;
    if (ritmo) await page.waitForTimeout(ritmo * 3);
    const fim = await readFinal(page); // só depois do fim: segredo e tamanho
    return {
      jogo: n, data: new Date().toISOString(), url,
      backend: backend.name, model: backend.model, ...(backend.pensar ? { pensar: true } : {}),
      len: fim.len, modo: 'invisivel', livre: true, variant: cfg.v, tries: cfg.tries,
      won: !!S.won, tentativas: S.guesses.length,
      guesses: S.guesses.map(g => ({ word: g.word, key: g.key, res: g.res })),
      secret: fim.secret, tempoTotalMs,
      tempoModeloMs: moves.reduce((s, m) => s + m.latencyMs, 0),
      estadoVisto: { campos, leituras, semCamposEscondidos: true },
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
  console.log(`Resumo: backend ${backend.name} (${backend.model}${backend.pensar ? ', pensar' : ''}), ${lenLabel}, variante ${cfg.v}, ${cfg.tries} tentativas`);
  if (!games.length) { console.log('  Nenhum jogo terminado.'); return; }
  const pad = (s, n) => String(s).padEnd(n);
  console.log('  ' + pad('#', 4) + pad('segredo', 16) + pad('letras', 8) + pad('resultado', 11) + pad('tentativas', 12) + pad('tempo total', 13) + 'tempo modelo');
  for (const g of games) {
    console.log('  ' + pad(g.jogo, 4) + pad(g.secret, 16) + pad(g.len, 8) + pad(g.won ? 'vitória' : 'derrota', 11) +
      pad(`${g.tentativas}/${g.tries}`, 12) + pad(secs(g.tempoTotalMs), 13) + secs(g.tempoModeloMs));
  }
  const moves = games.flatMap(g => g.moves);
  const won = games.filter(g => g.won);
  const inv = moves.filter(m => m.invalid).length;
  const agree = moves.filter(m => m.igualAoCodigo).length;
  const tin = moves.reduce((s, m) => s + m.tokens.entrada, 0), tout = moves.reduce((s, m) => s + m.tokens.saida, 0);
  const think = moves.reduce((s, m) => s + (m.thinkTokens || 0), 0);
  if (livre) {
    const props = moves.reduce((s, m) => s + m.propostas.length, 0);
    const rej = moves.reduce((s, m) => s + m.invalid, 0);
    const fb = moves.filter(m => m.fallback).length;
    const rowsL = [
      ['Jogos', games.length],
      ['Vitórias', `${won.length} (${fmt(100 * won.length / games.length)}%)`],
      ['Média de tentativas (todos)', fmt(games.reduce((s, g) => s + g.tentativas, 0) / games.length, 2)],
      ['Média de tentativas (vitórias)', won.length ? fmt(won.reduce((s, g) => s + g.tentativas, 0) / won.length, 2) : '-'],
      ['Tempo médio total por jogo', secs(games.reduce((s, g) => s + g.tempoTotalMs, 0) / games.length)],
      ['Latência média por jogada', `${fmt(moves.reduce((s, m) => s + m.latencyMs, 0) / moves.length, 1)} ms (todas as propostas)`],
      ['Jogadas', moves.length],
      ['Propostas do modelo', props],
      ['Propostas rejeitadas', `${rej} (${fmt(100 * rej / Math.max(1, props))}% das propostas)`],
      ['Jogadas por sorteio (fallback)', `${fb} (${fmt(100 * fb / moves.length)}%)`],
      ['Tokens entrada / saída', `${fmt(tin)} / ${fmt(tout)}`],
      ['Tokens de raciocínio (aprox.)', fmt(think)],
    ];
    console.log('');
    for (const [k, v] of rowsL) console.log('  ' + pad(k, 34) + v);
    return;
  }
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
    ...(think ? [['Tokens de raciocínio (aprox.)', fmt(think)]] : []),
  ];
  console.log('');
  for (const [k, v] of rows) console.log('  ' + pad(k, 34) + v);
}

// ---------- principal ----------
let stopping = false;
async function main() {
  const backend = await loadBackend(cfg.backend, { model: a.model, pensar: a.pensar });
  if (livre && !backend.livre) {
    let msg = 'este backend não joga no modo livre';
    try { await backend.chooseFree({}); } catch (e) { msg = e.message; }
    fail(`--backend ${backend.name} com --letras invisivel: ${msg}`);
  }
  if (a.pensar && backend.name !== 'ollama') console.warn('Aviso: --pensar só vale para o backend ollama; ignorado.');
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

  console.log(`Arena Azulejo: ${cfg.jogos} jogo(s), ${lenLabel}, backend ${backend.name} (${backend.model}), ${url}`);
  for (let i = 1; i <= cfg.jogos && !stopping; i++) {
    try {
      const g = await playGame(browser, url, backend, i);
      if (stopping) break;
      games.push(g);
      fs.appendFileSync(outFile, JSON.stringify(g) + '\n');
      const seq = g.guesses.map(x => x.word.toUpperCase()).join(' > ');
      if (livre) {
        const rej = g.moves.reduce((s, m) => s + m.invalid, 0), fb = g.moves.filter(m => m.fallback).length;
        console.log(`  jogo ${i} (invisível (livre)): ${g.won ? 'vitória' : 'derrota'} em ${g.tentativas}/${g.tries} (${secs(g.tempoTotalMs)}) ${seq}  [segredo: ${g.secret}, ${g.len} letras; ${rej} propostas rejeitadas, ${fb} por sorteio]`);
        g.moves.forEach((m, j) => console.log(`     ${j + 1}. ${m.palavra.toUpperCase()}${m.fallback ? ' (sorteio)' : ''} · ${m.latencyMs} ms · propostas: ${m.propostas.map(p => `${p.palavra ?? '∅'}${p.valida ? ' ✓' : ` ✗ (${p.motivo_rejeicao})`}`).join(', ')}${m.thinkTokens ? ` · raciocínio ~${m.thinkTokens} tokens` : ''}`));
      } else console.log(`  jogo ${i} (${g.len} letras): ${g.won ? 'vitória' : 'derrota'} em ${g.tentativas}/${g.tries} (${secs(g.tempoTotalMs)}) ${seq}  [segredo: ${g.secret}]`);
    } catch (e) {
      if (stopping) break;
      console.error(`  jogo ${i}: erro: ${e.message}`);
    }
  }
  if (!stopping) await finish(0);
}
main().catch(e => { console.error(e); process.exit(1); });
