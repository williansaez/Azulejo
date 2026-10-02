// Lógica pura do Azulejo das Palavras: normalização, cores, dicionário,
// candidatas, sugestões (entropia ou heurística) e descrição das opções em
// palavras. Funciona no Node e no navegador (o núcleo é o mesmo bloco CORE
// copiado em assistente/assistente.js e na página do resolvedor).
//
// O jogo sorteia a palavra com chance igual entre TODAS as palavras do
// dicionário daquele tamanho (dicionario/<n>.json), por isso não há ranking
// por frequência: cada candidata tem chance 1/N.

/*CORE*/
/* Núcleo do resolvedor (igual em arena/solver.mjs, assistente/assistente.js e
 * na página do resolvedor). Sem sinal de por cento nem comentários de linha, para caber no
 * bookmarklet. A palavra secreta é sorteada com chance igual entre todas as
 * palavras do dicionário daquele tamanho, por isso não há ordem de frequência.
 *   candidatas: chaves distintas de w compatíveis com todas as tentativas
 *   sugestão:   até 2 candidatas -> elas mesmas (com entropia);
 *               até 2500 -> entropia (bits) com as candidatas como palpites e,
 *               se forem até 600, mais até 1500 sondas de fora (as chaves que
 *               melhor dividem as candidatas pelas letras);
 *               acima de 2500 -> heurística de frequência de letras.
 *   heurística: soma, para cada letra distinta da palavra, das candidatas que
 *               têm a letra, mais, para cada posição, das candidatas com a
 *               mesma letra nessa posição; mostrada dividida pelo número de
 *               candidatas (letras e posições acertadas em média).
 */
var AZ = (function () {
  var MARKS = /[̀-ͯ]/g;
  var ENTROPY_MAX = 2500, PROBE_MAX_CANDS = 600, PROBES = 1500;
  function norm(w) { return w.replace(/ç/g, 'c').normalize('NFD').replace(MARKS, ''); }
  function score(guess, key) {
    var n = key.length, res = new Array(n), cnt = {}, i;
    for (i = 0; i < n; i++) { if (guess[i] === key[i]) res[i] = 'ok'; else { res[i] = 'off'; cnt[key[i]] = (cnt[key[i]] || 0) + 1; } }
    for (i = 0; i < n; i++) { if (res[i] !== 'ok' && cnt[guess[i]] > 0) { res[i] = 'near'; cnt[guess[i]]--; } }
    return res;
  }
  function enc(s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) - 97; return a; }
  var CNT = new Int16Array(26), RES = new Uint8Array(32);
  function pcode(g, k, n) {
    var i, c = 0, r;
    for (i = 0; i < n; i++) { CNT[g[i]] = 0; CNT[k[i]] = 0; }
    for (i = 0; i < n; i++) { if (g[i] === k[i]) RES[i] = 2; else { RES[i] = 0; CNT[k[i]]++; } }
    for (i = 0; i < n; i++) { r = RES[i]; if (r === 0 && CNT[g[i]] > 0) { r = 1; CNT[g[i]]--; } c = c * 3 + r; }
    return c;
  }
  function resCode(res) { var c = 0; for (var i = 0; i < res.length; i++) c = c * 3 + (res[i] === 'ok' ? 2 : res[i] === 'near' ? 1 : 0); return c; }
  function parseDict(d) {
    var n = d.n, words = d.w ? d.w.split(' ') : [], keys = [], forms = new Map(), br = new Map(), valid, i, j, k, f;
    for (i = 0; i < words.length; i++) {
      k = norm(words[i]); f = forms.get(k);
      if (!f) { forms.set(k, [words[i]]); keys.push(k); } else if (f.indexOf(words[i]) < 0) f.push(words[i]);
    }
    (d.br ? d.br.split(' ') : []).forEach(function (b) { br.set(norm(b), b); });
    valid = new Set(keys);
    (d.x ? d.x.split(' ') : []).forEach(function (x) { valid.add(x); });
    var buf = new Uint8Array(keys.length * n), codes = new Array(keys.length);
    for (i = 0; i < keys.length; i++) {
      codes[i] = buf.subarray(i * n, i * n + n);
      for (j = 0; j < n; j++) codes[i][j] = keys[i].charCodeAt(j) - 97;
    }
    return { n: n, keys: keys, forms: forms, br: br, valid: valid, codes: codes, words: words.length, buckets: null };
  }
  function displayOf(D, key, v) {
    if (v === 'br' && D.br.has(key)) return D.br.get(key);
    var f = D.forms.get(key);
    return f ? f.join(' / ') : key;
  }
  function candidates(D, guesses) {
    var n = D.n, out = [], i, j, ok;
    var gs = (guesses || []).map(function (g) { return { c: enc(g.key), t: resCode(g.res), bad: g.key.length !== n }; });
    for (i = 0; i < D.keys.length; i++) {
      ok = true;
      for (j = 0; j < gs.length; j++) if (gs[j].bad || pcode(gs[j].c, D.codes[i], n) !== gs[j].t) { ok = false; break; }
      if (ok) out.push(i);
    }
    return out;
  }
  function letterStats(D, idx) {
    var n = D.n, pos = new Int32Array(n * 26), has = new Int32Array(26), seen = new Int32Array(26), i, j, c, code;
    for (i = 0; i < idx.length; i++) {
      code = D.codes[idx[i]];
      for (j = 0; j < n; j++) { c = code[j]; pos[j * 26 + c]++; if (seen[c] !== i + 1) { seen[c] = i + 1; has[c]++; } }
    }
    return { pos: pos, has: has, N: idx.length };
  }
  var SEEN = new Float64Array(26), STAMP = 0;
  function heur(st, code, n, split) {
    var s = 0, j, c, a, N = st.N;
    STAMP++;
    for (j = 0; j < n; j++) {
      c = code[j]; a = st.pos[j * 26 + c]; s += split ? Math.min(a, N - a) : a;
      if (SEEN[c] !== STAMP) { SEEN[c] = STAMP; a = st.has[c]; s += split ? Math.min(a, N - a) : a; }
    }
    return s;
  }
  function byKey(a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; }
  function entropyRank(D, pool, idx, isCand, st, v) {
    var n = D.n, N = idx.length, B, touched = new Int32Array(N), log2N = Math.log2(N), out = [], hs = [], p, j, t, s, sq, code, g, b, k, cand;
    if (!D.buckets) D.buckets = new Int32Array(Math.pow(3, n));
    B = D.buckets;
    var cc = idx.map(function (i) { return D.codes[i]; });
    for (p = 0; p < pool.length; p++) {
      g = D.codes[pool[p]]; t = 0;
      for (j = 0; j < N; j++) { code = pcode(g, cc[j], n); if (B[code]++ === 0) touched[t++] = code; }
      s = 0; sq = 0;
      for (j = 0; j < t; j++) { b = B[touched[j]]; s += b * Math.log2(b); sq += b * b; B[touched[j]] = 0; }
      k = D.keys[pool[p]]; cand = isCand[pool[p]] === 1;
      out.push({ key: k, display: displayOf(D, k, v), bits: Math.max(0, log2N - s / N), heur: null, cand: cand, expectedRemaining: (sq - (cand ? 1 : 0)) / N });
      hs.push(heur(st, g, n, false));
    }
    var order = out.map(function (o, i) { return i; });
    order.sort(function (x, y) {
      var a = out[x], b2 = out[y], d = b2.bits - a.bits;
      return (d > 1e-9 ? 1 : d < -1e-9 ? -1 : 0) || ((b2.cand ? 1 : 0) - (a.cand ? 1 : 0)) || (hs[y] - hs[x]) || byKey(a, b2);
    });
    return order.map(function (i) { return out[i]; });
  }
  function suggest(D, guesses, v, top) {
    var n = D.n, idx = candidates(D, guesses), N = idx.length, st = letterStats(D, idx), i, ranked = [], mode;
    var cs = idx.map(function (i2) { return { key: D.keys[i2], h: heur(st, D.codes[i2], n, false) }; });
    cs.sort(function (a, b) { return b.h - a.h || byKey(a, b); });
    var cands = cs.map(function (c) { return { key: c.key, display: displayOf(D, c.key, v), heur: c.h / N }; });
    if (!N) mode = 'nenhuma';
    else if (N > ENTROPY_MAX) {
      mode = 'heuristica';
      ranked = cands.map(function (c) { return { key: c.key, display: c.display, bits: null, heur: c.heur, cand: true, expectedRemaining: null }; });
    } else {
      mode = 'entropia';
      var pool = idx.slice(), isCand = new Uint8Array(D.keys.length);
      for (i = 0; i < N; i++) isCand[idx[i]] = 1;
      if (N > 2 && N <= PROBE_MAX_CANDS) {
        var others = [], sc = new Float64Array(D.keys.length);
        for (i = 0; i < D.keys.length; i++) if (!isCand[i]) { sc[i] = heur(st, D.codes[i], n, true); if (sc[i] > 0) others.push(i); }
        others.sort(function (a, b) { return sc[b] - sc[a] || a - b; });
        pool = pool.concat(others.slice(0, PROBES));
      }
      ranked = entropyRank(D, pool, idx, isCand, st, v);
    }
    return { mode: mode, total: N, cands: cands, ranked: ranked, best: ranked.slice(0, top || 5) };
  }
  return { norm: norm, score: score, enc: enc, pcode: pcode, resCode: resCode, parseDict: parseDict, displayOf: displayOf,
    candidates: candidates, suggest: suggest, ENTROPY_MAX: ENTROPY_MAX, PROBE_MAX_CANDS: PROBE_MAX_CANDS, PROBES: PROBES };
})();
/*END CORE*/

export const { norm, score, enc, pcode, resCode, parseDict, displayOf, ENTROPY_MAX, PROBE_MAX_CANDS, PROBES } = AZ;

// Índices (no dicionário) das chaves compatíveis com as tentativas [{key, res}].
export const candidateIndexes = (D, guesses) => AZ.candidates(D, guesses);
// Chaves (sem acento) compatíveis com as tentativas, na ordem do dicionário.
export const candidates = (D, guesses) => AZ.candidates(D, guesses).map(i => D.keys[i]);

// Sugestões para o estado [{key, res}] na variante v ('pt' | 'br'):
//   { mode: 'entropia'|'heuristica'|'nenhuma', total, cands, ranked, best }
// cands: candidatas ordenadas pela heurística (mais "típicas" primeiro),
//   [{key, display, heur}]; ranked: todos os palpites avaliados, do melhor para
//   o pior; best: os `top` primeiros. Cada palpite tem sempre
//   {key, display, bits|null, heur|null, cand, expectedRemaining|null}.
export const suggest = (D, guesses, v = 'pt', top = 5) => AZ.suggest(D, guesses, v, top);

export const isValid = (D, key) => D.valid.has(key);

// ---------- dicionário ----------
// loadDict(n, opts) -> {n, keys (sem repetição), forms: Map<key, string[]>,
//   br: Map<key, string>, valid: Set<key> (keys ∪ x), codes, words}
// Em cache por tamanho e origem. Origem:
//   opts.rootDir                 lê <rootDir>/dicionario/<n>.json do disco (Node)
//   opts.root / opts.fetchImpl   fetch(new URL('dicionario/<n>.json', root))
//   nada, no Node                lê da pasta do repositório (a pasta acima de arena/)
//   nada, no navegador           fetch relativo à raiz do repositório (../ de solver.mjs)
const dictCache = new Map();
const REPO_ROOT_URL = new URL('../', import.meta.url);
export function loadDict(n, opts = {}) {
  n = Number(n);
  if (!Number.isInteger(n) || n < 1 || n > 20) return Promise.reject(new Error(`tamanho inválido: ${n}`));
  const inNode = typeof process !== 'undefined' && !!process.versions?.node && typeof document === 'undefined';
  const useDisk = !!opts.rootDir || (inNode && !opts.root && !opts.fetchImpl);
  const src = useDisk ? `disk:${opts.rootDir || ''}` : `url:${opts.root ? String(opts.root) : ''}`;
  const id = `${n}|${src}`;
  if (dictCache.has(id)) return dictCache.get(id);
  const p = (async () => {
    let json;
    if (useDisk) {
      const fs = await import('node:fs/promises');
      const path = await import('node:path');
      const { fileURLToPath } = await import('node:url');
      const dir = opts.rootDir || fileURLToPath(REPO_ROOT_URL);
      json = JSON.parse(await fs.readFile(path.join(dir, 'dicionario', `${n}.json`), 'utf8'));
    } else {
      const f = opts.fetchImpl || globalThis.fetch;
      const url = new URL(`dicionario/${n}.json`, opts.root || REPO_ROOT_URL);
      const r = await f(url.href);
      if (!r.ok) throw new Error(`não foi possível carregar ${url.href} (HTTP ${r.status})`);
      json = await r.json();
    }
    if (Number(json.n) !== n) throw new Error(`dicionário de ${n} letras com n=${json.n}`);
    return AZ.parseDict(json);
  })();
  dictCache.set(id, p);
  p.catch(() => dictCache.delete(id));
  return p;
}

// ---------- texto para os modelos ----------
const dec = (x, d = 1) => x.toFixed(d).replace('.', ',');

function leftLabel(x, n) {
  if (x === 0) return 'nenhuma (acerta com certeza)';
  const v = x < 10 ? dec(x) : String(Math.round(x));
  return `cerca de ${v} de ${n}`;
}

// Transforma as k melhores opções de suggest() em objetos com os MESMOS campos,
// em palavras (estilo jev-tetris). Sempre inclui candidatas: todas, se forem
// até k; senão as duas mais típicas (heurística). Campos que o modo atual não
// calcula dizem "não calculada".
export function describeOptions(sug, k = 8) {
  const { ranked, cands } = sug;
  const N = cands.length;
  const pos = new Map(ranked.map((r, i) => [r.key, i]));
  const must = (N <= k ? cands : cands.slice(0, 2)).filter(c => pos.has(c.key));
  const chosen = new Map(must.map(c => [c.key, ranked[pos.get(c.key)]]));
  for (const r of ranked) { if (chosen.size >= k) break; if (!chosen.has(r.key)) chosen.set(r.key, r); }
  return [...chosen.values()].sort((a, b) => pos.get(a.key) - pos.get(b.key)).map(r => ({
    id: r.key,
    word: r.display.toUpperCase(),
    pode_ser_a_resposta: r.cand ? 'sim' : 'não',
    informacao_esperada_bits: r.bits != null ? dec(r.bits, 2) : 'não calculada',
    opcoes_restantes_em_media: r.expectedRemaining != null ? leftLabel(r.expectedRemaining, N) : 'não calculada',
    pontuacao_heuristica: r.heur != null ? dec(r.heur, 2) : 'não calculada',
    chance_de_acertar_agora: r.cand ? `1 em ${N}` : 'nenhuma',
  }));
}

const COLOR = { ok: 'lugar certo', near: 'está na palavra, em outro lugar', off: 'não está na palavra' };
const VARIANT = { pt: 'português de Portugal', br: 'português do Brasil' };

// Estado do jogo em palavras para os modelos (sem a palavra secreta).
export function describeState(S, nCands, totalKeys, mode) {
  const extremo = S.modo === 'extremo' ? ' Modo Extremo: o tamanho foi sorteado entre 10 e 13 letras.' : '';
  return {
    regras: `Adivinhe a palavra secreta de ${S.len} letras (${VARIANT[S.v] || S.v}) em até ${S.tries} tentativas.${extremo} ` +
      'A palavra foi sorteada com chance igual entre todas as palavras do dicionário desse tamanho. ' +
      'Depois de cada tentativa cada letra recebe uma cor: lugar certo, está na palavra em outro lugar, ou não está na palavra. ' +
      'Acentos e cedilha não contam.',
    rodada: `${S.guesses.length + 1} de ${S.tries}`,
    tentativas_restantes: S.tries - S.guesses.length,
    tentativas_feitas: S.guesses.map((g, i) => ({
      numero: i + 1,
      palavra: (g.word || g.key).toUpperCase(),
      cores: g.key.split('').map((ch, j) => `${ch.toUpperCase()}: ${COLOR[g.res[j]]}`),
    })),
    palavras_possiveis_restantes: `${nCands} de ${totalKeys}`,
    como_as_opcoes_foram_calculadas: mode === 'heuristica'
      ? 'Muitas palavras possíveis: as opções são candidatas ordenadas por uma pontuação heurística de letras comuns (sem bits).'
      : 'As opções estão ordenadas pela informação esperada (bits); algumas podem ser sondas que não são a resposta.',
  };
}
