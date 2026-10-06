// Modo livre (Invisível): o modelo inventa cada palpite a partir do que um
// jogador humano vê. Aqui NÃO há candidatas, entropia, sugestões nem sorteio:
// o código só monta o estado visível, valida a palavra proposta (tamanho,
// dicionário, repetida) e, se for recusada, pede outra ao modelo, mostrando
// todas as recusadas da rodada com o motivo. Se o modelo não der uma palavra
// válida em maxPropostas propostas (ou o backend falhar maxPropostas vezes
// seguidas), a partida é abandonada. Funciona no Node (jogar.mjs) e no
// navegador (index.html).
import { norm, loadDict } from './solver.mjs';
import { pickFree } from './backends/index.mjs';

export const MIN = 4, MAX = 13;            // tamanho de cada tentativa
export const LENS = Array.from({ length: MAX - MIN + 1 }, (_, i) => MIN + i);
export const MAX_PROPOSTAS = 25;           // limite de propostas por rodada (depois, abandono)
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
// extra: { proposta, maxPropostas } (número desta proposta na rodada e o limite).
export function buildCtx(S, invalidas = [], extra = {}) {
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
    ...(Number.isInteger(extra.proposta) ? { proposta_nesta_rodada: extra.proposta } : {}),
    ...(Number.isInteger(extra.maxPropostas) ? { max_propostas_por_rodada: extra.maxPropostas } : {}),
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

export const motivoLimite = n => `o modelo não produziu uma palavra válida em ${n} propostas`;
export const motivoErros = (n, erro) => `o backend falhou em ${n} pedidos seguidos: ${erro}`;

// Uma jogada no modo livre: pede ao modelo até ele propor uma palavra válida.
// Cada recusa entra em tentativas_invalidas_nesta_rodada (todas, com o motivo)
// para o próximo pedido. NÃO há sorteio: se o modelo propuser maxPropostas
// palavras recusadas, ou o backend falhar (rede, HTTP, JSON, resposta sem
// palavra) maxPropostas vezes seguidas, a jogada volta com abandonado: true e
// nada é digitado. Os erros do backend não contam como propostas.
// S: az-cur sem len/secret/key. Ganchos (opcionais), usados pela página e pelo
// harness: hooks.onAsk(ctx, i) antes de cada pedido; hooks.onProposal(p, r)
// depois de cada resposta; hooks.submit(key, display, p) digita a palavra
// aceita e devolve 'ok' ou o resultado do jogo (se o jogo recusar, a proposta
// passa a recusada e o modelo é chamado de novo).
export async function freeMove(backend, S, { dicts, v = S.v, hooks = {}, maxPropostas = MAX_PROPOSTAS } = {}) {
  const max = Math.max(1, Math.floor(Number(maxPropostas)) || MAX_PROPOSTAS);
  const tried = new Set(S.guesses.map(g => g.key));
  const recusadas = new Set();                         // chaves recusadas nesta rodada
  const propostas = [], invalidas = [], erros = [];
  let latencyMs = 0, tokensIn = 0, tokensOut = 0, thinkTokens = 0;
  let chosen = null, typed = null, motivo = null, palavras = 0, errosSeguidos = 0, motivoAbandono = null;
  for (let i = 0; !chosen; i++) {
    if (palavras >= max) { motivoAbandono = motivoLimite(max); break; }
    if (errosSeguidos >= max) { motivoAbandono = motivoErros(max, erros.at(-1)); break; }
    const ctx = buildCtx(S, invalidas, { proposta: palavras + 1, maxPropostas: max });
    hooks.onAsk?.(ctx, i);
    const r = await pickFree(backend, ctx);
    latencyMs += r.latencyMs; tokensIn += r.tokensIn; tokensOut += r.tokensOut; thinkTokens += r.thinkTokens;
    let p;
    if (r.word == null) {
      errosSeguidos++;
      const erro = r.erro || 'resposta vazia';
      erros.push(erro);
      p = { palavra: null, valida: false, erro: true, motivo_rejeicao: `sem palavra (${erro})` };
      propostas.push(p);
      hooks.onProposal?.(p, r);
      continue;
    }
    errosSeguidos = 0; palavras++;
    let c = check(r.word, dicts, tried);
    if (c.valida && recusadas.has(c.key)) c = { key: c.key, valida: false, motivo_rejeicao: 'já foi recusada nesta rodada' };
    p = { palavra: r.word, valida: c.valida, ...(c.valida ? {} : { motivo_rejeicao: c.motivo_rejeicao }) };
    if (r.motivo) p.motivo = r.motivo;
    propostas.push(p);
    hooks.onProposal?.(p, r);
    if (c.valida && hooks.submit) {
      const res = await hooks.submit(c.key, displayFor(dicts.get(c.key.length), c.key, v, r.word), p);
      if (res !== 'ok') {
        p.valida = false; p.motivo_rejeicao = `o jogo recusou a palavra (${res})`;
        hooks.onProposal?.(p, r);
      }
    }
    if (p.valida) { chosen = c.key; typed = r.word; motivo = r.motivo; p.key = c.key; }
    else {
      if (/^[a-z]+$/.test(c.key)) recusadas.add(c.key);
      invalidas.push({ palavra: r.word.toUpperCase(), motivo: p.motivo_rejeicao });
    }
  }
  return {
    abandonado: !chosen,
    ...(chosen ? {} : { motivoAbandono }),
    word: chosen,                                     // o que se digita (sem acentos); null no abandono
    display: chosen ? displayFor(dicts.get(chosen.length), chosen, v, typed) : null,
    propostas,
    invalid: propostas.filter(p => !p.valida && !p.erro).length, // palavras recusadas nesta jogada
    errosBackend: erros.length,
    latencyMs, tokensIn, tokensOut, thinkTokens,
    motivo: chosen ? motivo : null,
    erros,
  };
}

// Registro da jogada (formato do .jsonl). extra: campos do harness. Também
// serve para a rodada abandonada (word e palavra null, abandonado: true).
export function moveRecord(m, extra = {}) {
  return {
    word: m.word, palavra: m.display, latencyMs: m.latencyMs, invalid: m.invalid,
    propostas: m.propostas.map(({ key, ...p }) => p),
    ...(m.errosBackend ? { errosBackend: m.errosBackend } : {}),
    ...(m.abandonado ? { abandonado: true, motivoAbandono: m.motivoAbandono } : {}),
    tokens: { entrada: m.tokensIn, saida: m.tokensOut }, thinkTokens: m.thinkTokens,
    ...(m.motivo ? { motivo: m.motivo } : {}),
    ...(m.erros.length ? { erro: m.erros.join(' | ') } : {}),
    ...extra,
  };
}

// Rodadas do modo livre de um jogo: as jogadas digitadas e, se houve, a
// rodada abandonada (entra nas contas de propostas e tokens).
export const rodadasLivres = g => [...(g.moves || []), ...(g.rodadaAbandonada ? [g.rodadaAbandonada] : [])];
