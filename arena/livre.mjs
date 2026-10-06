// Modo livre (Invisível): o modelo inventa cada palpite a partir do que um
// jogador humano vê. Aqui NÃO há candidatas, entropia nem sugestões: o código
// só monta o estado visível, valida a palavra proposta (tamanho, dicionário,
// repetida), pede de novo ao modelo se for recusada e, se as três propostas
// falharem, sorteia uma palavra válida qualquer (sem olhar as letras
// conhecidas). Funciona no Node (jogar.mjs) e no navegador (index.html).
import { norm, loadDict } from './solver.mjs';
import { pickFree } from './backends/index.mjs';

export const MIN = 4, MAX = 13;            // tamanho de cada tentativa
export const LENS = Array.from({ length: MAX - MIN + 1 }, (_, i) => MIN + i);
export const PROPOSTAS = 3;                // 1 pedido + 2 novas tentativas por jogada
const VARIANT = { pt: 'português de Portugal', br: 'português do Brasil' };

// Campos de az-cur que o agente não pode ler antes do fim do jogo. A remoção
// acontece dentro da página; assertHidden prova que nada passou.
export const HIDDEN = ['len', 'secret', 'key'];
export function assertHidden(S) {
  const leak = HIDDEN.filter(k => S && Object.prototype.hasOwnProperty.call(S, k));
  if (leak.length) throw new Error(`o estado lido mostra campos escondidos: ${leak.join(', ')}`);
  return S;
}

// Todos os dicionários de 4 a 13 letras (cada palpite valida no do seu tamanho).
export async function loadAllDicts(opts = {}) {
  const ds = await Promise.all(LENS.map(n => loadDict(n, opts)));
  return new Map(ds.map(D => [D.n, D]));
}

export function regras(tries, v) {
  return `Adivinhe a palavra secreta (${VARIANT[v] || v}) em até ${tries} tentativas. ` +
    'A palavra secreta tem de 4 a 9 letras, mas o tamanho não é mostrado; só na última tentativa o jogo revela quantas letras ela tem. ' +
    'Cada tentativa pode ser qualquer palavra do dicionário com 4 a 13 letras. ' +
    'Depois de cada tentativa, cada letra recebe "certa" (está nessa mesma posição na palavra secreta), "existe" (aparece noutra posição) ou "não existe". ' +
    'Acentos e cedilha não contam. Ganha quem escrever exatamente a palavra secreta.';
}

// ctx do modo livre, a partir de az-cur SEM len/secret/key.
export function buildCtx(S, invalidas = []) {
  assertHidden(S);
  const existe = new Set(), nao = new Set(), certas = new Map();
  const historico = S.guesses.map((g, i) => ({
    numero: i + 1,
    palavra: (g.word || g.key).toUpperCase(),
    letras: g.key.split('').map((ch, j) => {
      const e = g.res[j] === 'off' ? 'não existe' : g.res[j] === 'ok' ? 'certa' : 'existe';
      (e === 'não existe' ? nao : existe).add(ch.toUpperCase());
      if (e === 'certa') certas.set(j + 1, ch.toUpperCase());
      return { letra: ch.toUpperCase(), estado: e };
    }),
  }));
  const sorted = s => [...s].sort();
  return {
    regras: regras(S.tries, S.v),
    rodada: S.guesses.length + 1,
    tentativas: S.tries,
    historico,
    letras_que_existem: sorted(existe),
    letras_que_nao_existem: sorted(nao),
    letras_certas_por_posicao: [...certas].sort((a, b) => a[0] - b[0]).map(([posicao, letra]) => ({ posicao, letra })),
    palavras_ja_tentadas: S.guesses.map(g => g.key.toUpperCase()),
    dica_tamanho: Number.isInteger(S.dica?.len) ? S.dica.len : null,
    tentativas_invalidas_nesta_rodada: invalidas.map(x => ({ ...x })),
  };
}

// Forma para mostrar: a que o modelo escreveu, se for uma forma do dicionário;
// senão a grafia do Brasil (variante br) ou a primeira forma acentuada.
export function displayFor(D, key, v, typed) {
  const forms = D?.forms.get(key) || [];
  const t = typeof typed === 'string' ? typed.trim().toLowerCase() : '';
  if (t && (forms.includes(t) || D?.br.get(key) === t)) return t;
  return (v === 'br' && D?.br.get(key)) || forms[0] || key;
}

// Valida uma proposta. Devolve { key, valida, motivo_rejeicao? }.
export function check(word, dicts, tried) {
  const key = norm(String(word ?? '').trim().toLowerCase());
  if (!/^[a-z]+$/.test(key)) return { key, valida: false, motivo_rejeicao: 'não é uma palavra só de letras (sem espaços, hífens ou números)' };
  if (key.length < MIN || key.length > MAX) return { key, valida: false, motivo_rejeicao: 'tamanho fora de 4 a 13' };
  if (tried.has(key)) return { key, valida: false, motivo_rejeicao: 'já foi tentada' };
  const D = dicts.get(key.length);
  if (!D || !D.valid.has(key)) return { key, valida: false, motivo_rejeicao: 'não está no dicionário' };
  return { key, valida: true };
}

// Sorteio sem informação: um tamanho de 4 a 13 ao acaso e, nele, uma palavra
// ao acaso (chance igual) que ainda não foi tentada. NÃO filtra pelas letras.
export function randomWord(dicts, tried, rnd = Math.random) {
  for (let i = 0; i < 1000; i++) {
    const D = dicts.get(LENS[Math.floor(rnd() * LENS.length)]);
    if (!D || !D.keys.length) continue;
    const key = D.keys[Math.floor(rnd() * D.keys.length)];
    if (!tried.has(key)) return key;
  }
  throw new Error('não foi possível sortear uma palavra nova');
}

// Uma jogada no modo livre: até PROPOSTAS pedidos ao modelo; a primeira
// proposta válida é a jogada. Se todas falharem, sorteio (fallback).
// S: az-cur sem len/secret/key. hooks.onAsk(ctx, i) antes de cada pedido e
// hooks.onProposal(proposta, resposta) depois (a página usa para o painel).
export async function freeMove(backend, S, { dicts, v = S.v, hooks = {} } = {}) {
  const tried = new Set(S.guesses.map(g => g.key));
  const propostas = [], invalidas = [], erros = [];
  let latencyMs = 0, tokensIn = 0, tokensOut = 0, thinkTokens = 0, chosen = null, motivo = null;
  for (let i = 0; i < PROPOSTAS && !chosen; i++) {
    const ctx = buildCtx(S, invalidas);
    hooks.onAsk?.(ctx, i);
    const r = await pickFree(backend, ctx);
    latencyMs += r.latencyMs; tokensIn += r.tokensIn; tokensOut += r.tokensOut; thinkTokens += r.thinkTokens;
    let p;
    if (r.word == null) {
      p = { palavra: null, valida: false, motivo_rejeicao: `sem palavra (${r.erro || 'resposta vazia'})` };
      if (r.erro) erros.push(r.erro);
    } else {
      const c = check(r.word, dicts, tried);
      p = { palavra: r.word, valida: c.valida, ...(c.valida ? {} : { motivo_rejeicao: c.motivo_rejeicao }) };
      if (r.motivo) p.motivo = r.motivo;
      if (c.valida) { chosen = c.key; motivo = r.motivo; p.key = c.key; }
      else invalidas.push({ palavra: r.word.toUpperCase(), motivo: c.motivo_rejeicao });
    }
    propostas.push(p);
    hooks.onProposal?.(p, r);
  }
  const fallback = !chosen;
  const key = chosen || randomWord(dicts, tried);
  const typed = chosen ? propostas.find(p => p.valida)?.palavra : null;
  return {
    word: key,                                        // o que se digita (sem acentos)
    display: displayFor(dicts.get(key.length), key, v, typed),
    fallback,
    propostas,
    invalid: propostas.filter(p => !p.valida).length, // propostas recusadas nesta jogada
    latencyMs, tokensIn, tokensOut, thinkTokens,
    motivo: fallback ? 'sorteio: as três propostas foram recusadas' : motivo,
    erros,
  };
}

// Registro da jogada (formato do .jsonl). extra: campos do harness.
export function moveRecord(m, extra = {}) {
  return {
    word: m.word, palavra: m.display, latencyMs: m.latencyMs, invalid: m.invalid,
    propostas: m.propostas.map(({ key, ...p }) => p), fallback: m.fallback,
    tokens: { entrada: m.tokensIn, saida: m.tokensOut }, thinkTokens: m.thinkTokens,
    ...(m.motivo ? { motivo: m.motivo } : {}),
    ...(m.erros.length ? { erro: m.erros.join(' | ') } : {}),
    ...extra,
  };
}
