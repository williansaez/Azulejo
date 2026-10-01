// Lógica pura do Azulejo das Palavras: normalização, cores, candidatos,
// ranking por informação esperada e descrição das opções em palavras.
// Portado de assistente/assistente.js. Não depende do navegador.

export const norm = w => w.replace(/ç/g, 'c').normalize('NFD').replace(/[̀-ͯ]/g, '');

// Igual à função score() do jogo (index.html).
export function score(guess, key) {
  const n = key.length, res = Array(n).fill('off'), cnt = {};
  for (let i = 0; i < n; i++) { if (guess[i] === key[i]) res[i] = 'ok'; else cnt[key[i]] = (cnt[key[i]] || 0) + 1; }
  for (let i = 0; i < n; i++) { if (res[i] !== 'ok' && cnt[guess[i]] > 0) { res[i] = 'near'; cnt[guess[i]]--; } }
  return res;
}

// Mesmo algoritmo, devolvendo o padrão como inteiro (base 3: off=0, near=1,
// ok=2) sem criar arrays, para o ranking ser rápido.
const CNT = new Int8Array(26), OK = new Uint8Array(8);
function patternCode(guess, key) {
  const n = key.length;
  CNT.fill(0);
  for (let i = 0; i < n; i++) {
    OK[i] = guess.charCodeAt(i) === key.charCodeAt(i) ? 1 : 0;
    if (!OK[i]) CNT[key.charCodeAt(i) - 97]++;
  }
  let code = 0;
  for (let i = 0; i < n; i++) {
    let r = 0;
    if (OK[i]) r = 2;
    else { const c = guess.charCodeAt(i) - 97; if (CNT[c] > 0) { r = 1; CNT[c]--; } }
    code = code * 3 + r;
  }
  return code;
}

// Agrupa a lista de palavras secretas (com acentos, por frequência) pela forma
// normalizada, mantendo a posição da primeira ocorrência como "rank".
export function buildList(words) {
  const byKey = new Map(), entries = [];
  for (const w of words) {
    const key = norm(w);
    const seen = byKey.get(key);
    if (seen) { seen.words.push(w); continue; }
    const e = { key, word: w, words: [w], rank: entries.length };
    byKey.set(key, e);
    entries.push(e);
  }
  return entries;
}

// guesses = [{key, res}] como guardado em az-cur.
export function candidates(entries, guesses) {
  const want = guesses.map(g => ({ key: g.key, res: g.res.join(',') }));
  return entries.filter(e => want.every(g => score(g.key, e.key).join(',') === g.res));
}

// Entropia (bits) da partição dos candidatos para cada palpite do pool.
// Ordena por bits desc; empate: candidato primeiro, depois mais frequente.
export function rankGuesses(pool, cands) {
  const isCand = new Set(cands.map(c => c.key));
  const total = cands.length;
  const out = pool.map(p => {
    const buckets = new Map();
    for (const c of cands) { const s = patternCode(p.key, c.key); buckets.set(s, (buckets.get(s) || 0) + 1); }
    let bits = 0, sumSq = 0;
    for (const n of buckets.values()) { const q = n / total; bits -= q * Math.log2(q); sumSq += n * n; }
    const cand = isCand.has(p.key);
    // palavras que ainda restariam em média depois desta tentativa (0 se acertar)
    const expectedLeft = total ? (sumSq - (cand ? 1 : 0)) / total : 0;
    return { key: p.key, word: p.word, rank: p.rank, bits: Math.abs(bits), isCandidate: cand, expectedLeft };
  });
  out.sort((a, b) => (b.bits - a.bits > 1e-9 ? 1 : a.bits - b.bits > 1e-9 ? -1 : 0)
    || (b.isCandidate - a.isCandidate) || (a.rank - b.rank));
  out.forEach((r, i) => { r.pos = i; });
  return out;
}

const dec = (x, d = 1) => x.toFixed(d).replace('.', ',');

function frequencyLabel(rank, total) {
  if (rank < total / 3) return 'muito comum';
  if (rank < (2 * total) / 3) return 'comum';
  return 'rara';
}

function leftLabel(x, n) {
  if (x === 0) return 'nenhuma (acerta com certeza)';
  const v = x < 10 ? dec(x) : String(Math.round(x));
  return `cerca de ${v} de ${n}`;
}

// Transforma as k melhores opções em objetos com os mesmos campos, em palavras
// (estilo jev-tetris). Sempre inclui as candidatas mais frequentes: todas, se
// forem até k; senão as duas mais comuns.
export function describeOptions(ranked, cands, k = 8) {
  const total = ranked.length;
  const byKey = new Map(ranked.map(r => [r.key, r]));
  const must = (cands.length <= k ? cands : cands.slice(0, 2)).map(c => byKey.get(c.key)).filter(Boolean);
  const chosen = new Map(must.map(r => [r.key, r]));
  for (const r of ranked) { if (chosen.size >= k) break; chosen.set(r.key, r); }
  return [...chosen.values()].sort((a, b) => a.pos - b.pos).map(r => ({
    id: r.key,
    word: r.word.toUpperCase(),
    pode_ser_a_resposta: r.isCandidate ? 'sim' : 'não',
    frequencia: frequencyLabel(r.rank, total),
    informacao_esperada_bits: dec(r.bits),
    opcoes_restantes_em_media: leftLabel(r.expectedLeft, cands.length),
    chance_de_acertar_agora: !r.isCandidate ? 'nenhuma' : cands.length === 1 ? 'certeza' : `1 em ${cands.length}`,
  }));
}

const COLOR = { ok: 'lugar certo', near: 'está na palavra, em outro lugar', off: 'não está na palavra' };
const VARIANT = { pt: 'português de Portugal', br: 'português do Brasil' };

// Estado do jogo em palavras para os modelos (sem a palavra secreta).
export function describeState(S, cands, totalWords) {
  return {
    regras: `Adivinhe a palavra secreta de ${S.len} letras (${VARIANT[S.v]}) em até ${S.tries} tentativas. ` +
      'Depois de cada tentativa cada letra recebe uma cor: lugar certo, está na palavra em outro lugar, ou não está na palavra. ' +
      'Acentos e cedilha não contam.',
    rodada: `${S.guesses.length + 1} de ${S.tries}`,
    tentativas_restantes: S.tries - S.guesses.length,
    tentativas_feitas: S.guesses.map((g, i) => ({
      numero: i + 1,
      palavra: (g.word || g.key).toUpperCase(),
      cores: g.key.split('').map((ch, j) => `${ch.toUpperCase()}: ${COLOR[g.res[j]]}`),
    })),
    palavras_possiveis_restantes: `${cands.length} de ${totalWords}`,
  };
}
