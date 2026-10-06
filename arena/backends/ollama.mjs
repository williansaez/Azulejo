// Backend Ollama (/api/chat) com saída estruturada e resposta em streaming.
//   choose(ctx)      primeiro o código: o modelo só escolhe um id da lista.
//   chooseFree(ctx)  modo livre (Invisível): o modelo inventa a palavra.
// opts.pensar = true manda think: true (modelos com raciocínio); por padrão
// think: false.
//
// Streaming (stream: true): lê os pedaços NDJSON, junta message.thinking e
// message.content e chama ctx.onProgress({ phase, thinkingChars, contentChars,
// elapsedMs, thinkingTail }) no máximo a cada 250 ms (e a cada 1 s mesmo sem
// pedaço novo, para o relógio andar). phase: 'aguardando' (nada chegou
// ainda), 'pensando' ou 'respondendo'. O último pedaço (done: true) traz
// prompt_eval_count/eval_count. Se o servidor responder um JSON só (sem
// streaming), funciona igual.
// Tempo: sem limite total enquanto chegam pedaços; aborta se ficar
// ARENA_IDLE_MS (padrão 180000) sem nada, ou no teto opts.timeoutMs /
// ARENA_TIMEOUT_MS (padrão 900000 com pensar, 120000 sem).
// Tokens: options.num_predict = opts.maxTokens / ARENA_MAX_TOKENS (padrão
// 4096), para o raciocínio não cortar a resposta.
// Conteúdo vazio com raciocínio: tenta tirar a resposta do raciocínio (um
// JSON ou uma palavra no formato esperado); se não der, lança um erro com
// code 'SO_PENSOU' ("o modelo só pensou e não respondeu") e quem chama
// (pick/freeMove) pede uma vez de novo com ctx.semFormato: sem format e
// leitura tolerante ({...} no texto, senão a última palavra de 4 a 13 letras).
import { postStream, env } from './index.mjs';

export const MAX_TOKENS = 4096;
export const IDLE_MS = 180000;
export const TIMEOUT_MS = { pensar: 900000, normal: 120000 };
const TAIL = 600;

const SYSTEM = `Você está jogando "Azulejo das Palavras", um jogo de adivinhar palavras em português parecido com o Wordle.
A cada rodada você recebe o estado do jogo (tentativas já feitas e as cores de cada letra) e uma lista curta de opções de palavra, já calculadas por um programa que conhece o dicionário.
A palavra secreta foi sorteada com chance igual entre todas as palavras do dicionário daquele tamanho.
Cada opção diz se ainda pode ser a resposta, quanta informação ela traz (em bits) e quantas palavras devem sobrar em média depois de jogá-la. Quando ainda há palavras possíveis demais, os bits não são calculados ("não calculada") e as opções vêm ordenadas por uma pontuação heurística de letras comuns (maior é melhor).
Seu objetivo é acertar a palavra secreta no menor número de tentativas. No começo vale mais ganhar informação; quando sobram poucas palavras, vale mais chutar uma que pode ser a resposta.
Responda APENAS com JSON no formato {"escolha": "<id de uma das opções>", "motivo": "<frase curta>"}. Não escreva mais nada.`;

function userMessage(ctx) {
  const s = ctx.state;
  const lines = [`Rodada ${s.rodada}. ${s.regras}`];
  if (s.tentativas_feitas.length) {
    lines.push('', 'Tentativas feitas:');
    for (const t of s.tentativas_feitas) lines.push(`${t.numero}. ${t.palavra} → ${t.cores.join('; ')}`);
  } else lines.push('', 'Ainda não houve tentativas.');
  lines.push('', `Palavras possíveis restantes: ${s.palavras_possiveis_restantes}.`);
  if (s.como_as_opcoes_foram_calculadas) lines.push(s.como_as_opcoes_foram_calculadas);
  lines.push('', 'Opções (escolha uma pelo campo "id"):');
  for (const o of ctx.options) lines.push(JSON.stringify(o));
  lines.push('', 'Responda só com o JSON {"escolha": "...", "motivo": "..."}.');
  return lines.join('\n');
}

// ---------- modo livre (Invisível) ----------
// Nenhuma lista de palavras: só as regras e o que um jogador vê na tela.
const SYSTEM_LIVRE = `Você está jogando "Azulejo das Palavras" no modo Invisível, um jogo de adivinhar uma palavra secreta em português.
Regras:
- A palavra secreta tem de 4 a 9 letras, mas o tamanho NÃO é mostrado (só na última tentativa o jogo revela quantas letras ela tem).
- Cada tentativa pode ser qualquer palavra portuguesa do dicionário com 4 a 13 letras (não precisa ter o tamanho da secreta).
- Só valem palavras que existem num dicionário de português, escritas numa palavra só, sem espaços nem hífens (acentos são permitidos). Nomes próprios, siglas, palavras inventadas ou de outras línguas são recusados.
- Depois de cada tentativa, cada letra é marcada como "certa" (está nessa mesma posição na palavra secreta), "existe" (aparece noutra posição) ou "não existe". Uma letra certa na posição N também diz que a palavra tem pelo menos N letras.
- Acentos e cedilha não contam (Á = A, Ç = C).
- Você ganha quando escrever exatamente a palavra secreta. Há um número limitado de tentativas.
Como jogar bem:
- Use as letras que existem e evite as que não existem; tentativas no começo podem servir para descobrir letras.
- Prefira palavras comuns do português.
- Nunca repita uma palavra já tentada.
Propostas recusadas:
- Se a sua proposta for recusada, o jogo pede outra e mostra todas as propostas recusadas nesta rodada, com o motivo de cada uma.
- Uma proposta recusada NUNCA deve ser repetida: proponha sempre uma palavra diferente de todas as recusadas.
- Não há sorteio: o jogo só avança com uma palavra válida dada por você. Se você não der uma palavra válida depois de muitas propostas, a partida é abandonada e conta como derrota.
Responda APENAS com JSON no formato {"palavra": "<sua tentativa>", "motivo": "<frase curta>"}.
A palavra deve ser UMA palavra portuguesa, sem espaços nem hífens; acentos são permitidos. Não escreva mais nada.`;

const lista = xs => (xs.length ? xs.join(', ') : 'nenhuma');

function userMessageLivre(ctx) {
  const lines = [`Rodada ${ctx.rodada} (máximo de ${ctx.tentativas} tentativas).`, ctx.regras, ''];
  if (ctx.historico.length) {
    lines.push('Tentativas feitas:');
    for (const h of ctx.historico) lines.push(`${h.numero}. ${h.palavra} → ${h.letras.map(l => `${l.letra}: ${l.estado}`).join('; ')}`);
  } else lines.push('Ainda não houve tentativas.');
  lines.push('');
  lines.push(`Letras que existem na palavra secreta: ${lista(ctx.letras_que_existem)}.`);
  lines.push(`Letras que não existem na palavra secreta: ${lista(ctx.letras_que_nao_existem)}.`);
  if (ctx.letras_certas_por_posicao?.length) lines.push(`Letras já na posição certa: ${ctx.letras_certas_por_posicao.map(c => `${c.letra} na ${c.posicao}.ª`).join(', ')}.`);
  lines.push(`Palavras já tentadas (não repita): ${lista(ctx.palavras_ja_tentadas)}.`);
  lines.push(ctx.dica_tamanho ? `Dica da última tentativa: a palavra secreta tem ${ctx.dica_tamanho} letras.`
    : 'O tamanho da palavra secreta não foi revelado (tem de 4 a 9 letras).');
  const recusadas = ctx.tentativas_invalidas_nesta_rodada || [];
  if (recusadas.length) {
    lines.push('', `Propostas recusadas nesta rodada (${recusadas.length}; não repita nenhuma):`);
    for (const t of recusadas) lines.push(`- ${t.palavra}: ${t.motivo}`);
    lines.push('Proponha uma palavra diferente de todas as recusadas.');
  }
  if (ctx.max_propostas_por_rodada) lines.push(`Esta é a proposta ${ctx.proposta_nesta_rodada ?? recusadas.length + 1} de no máximo ${ctx.max_propostas_por_rodada} nesta rodada.`);
  lines.push('', 'Responda só com o JSON {"palavra": "...", "motivo": "..."}.');
  return lines.join('\n');
}

const FORMAT_LIVRE = {
  type: 'object',
  properties: { palavra: { type: 'string', minLength: 4, maxLength: 16 }, motivo: { type: 'string' } },
  required: ['palavra'],
};

// Tokens de raciocínio: o /api/chat do Ollama não separa (eval_count soma
// raciocínio e resposta). Se um dia vier um campo próprio, usa-o; senão,
// aproxima pela fração de caracteres do raciocínio em eval_count.
function thinkTokensOf(final, thinking, content) {
  const own = final?.thinking_eval_count ?? final?.thinking_count;
  if (Number.isFinite(own)) return own;
  if (!thinking) return 0;
  const out = final?.eval_count ?? 0;
  if (!out) return Math.ceil(thinking.length / 4);
  return Math.max(1, Math.round(out * thinking.length / (thinking.length + content.length)));
}

const semAcento = w => String(w).toLowerCase().replace(/ç/g, 'c').normalize('NFD').replace(/[̀-ͯ]/g, '');
const LETRA = 'A-Za-zÀ-ÖØ-öø-ÿ';
// Tira blocos <think>…</think> que alguns modelos escrevem no próprio conteúdo.
const semThink = t => String(t || '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, ' ');
// Objetos {...} simples (sem chaves aninhadas) no texto, do último para o primeiro.
function objetos(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/\{[^{}]*\}/g)) { try { out.push(JSON.parse(m[0])); } catch { /* não é JSON */ } }
  return out.reverse();
}
const palavras = (text, re) => [...String(text || '').matchAll(re)].map(m => m[1]);

// Lê a resposta. modo: 'json' (com format: JSON.parse, senão {...} no texto),
// 'tolerante' (sem format: {...} no texto, senão a última palavra no formato),
// 'raciocinio' (conteúdo vazio: procura no raciocínio um {...} ou uma palavra
// no formato, com critério mais estrito para não pegar palavras soltas).
// kind: { campo: 'palavra'|'escolha', ids?, evitar? }.
function lerResposta(text, modo, kind) {
  const ok = o => o && typeof o === 'object' && typeof o[kind.campo] === 'string' && o[kind.campo].trim() &&
    (!kind.ids || kind.ids.includes(semAcento(o[kind.campo].trim())));
  const t = modo === 'raciocinio' ? text : semThink(text);
  if (modo === 'json') { try { const o = JSON.parse(t); if (o && typeof o === 'object') return o; } catch { /* abaixo */ } }
  const obj = objetos(t).find(ok);
  if (obj) return obj;
  if (modo === 'json') return null;
  if (kind.ids) {
    // primeiro o código: a última menção de um dos ids, como palavra solta
    const ws = palavras(t, new RegExp(`(?<![${LETRA}])([${LETRA}]{2,})(?![${LETRA}])`, 'g'));
    for (let i = ws.length - 1; i >= 0; i--) { const k = semAcento(ws[i]); if (kind.ids.includes(k)) return { [kind.campo]: k }; }
    return null;
  }
  const evitar = new Set((kind.evitar || []).map(semAcento));
  // no raciocínio, só palavras em MAIÚSCULAS (o jeito como as tentativas
  // aparecem no pedido); na resposta sem format, qualquer palavra de 4 a 13
  const re = modo === 'raciocinio'
    ? /(?<![A-Za-zÀ-ÖØ-öø-ÿ])([A-ZÀ-ÖØ-Þ]{4,13})(?![A-Za-zÀ-ÖØ-öø-ÿ])/g
    : new RegExp(`(?<![${LETRA}-])([${LETRA}]{4,13})(?![${LETRA}-])`, 'g');
  const ws = palavras(t, re).filter(w => !evitar.has(semAcento(w)) && semAcento(w) !== 'json');
  return ws.length ? { [kind.campo]: ws.at(-1).toLowerCase() } : null;
}

function erroCom(msg, code, parcial) { const e = new Error(msg); if (code) e.code = code; e.parcial = parcial; return e; }

// opts: { model, baseUrl, pensar, maxTokens, timeoutMs, idleMs } (baseUrl pode
// ser relativo, ex.: /ollama via servir.mjs)
export function create({ model, baseUrl, pensar, maxTokens, timeoutMs, idleMs } = {}) {
  const base = (baseUrl || env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const name = model || 'qwen3.5:9b';
  const think = !!pensar;
  const numPredict = Math.floor(Number(maxTokens) || Number(env.ARENA_MAX_TOKENS) || MAX_TOKENS);
  const totalMs = Number(timeoutMs) || Number(env.ARENA_TIMEOUT_MS) || (think ? TIMEOUT_MS.pensar : TIMEOUT_MS.normal);
  const idle = Number(idleMs) || Number(env.ARENA_IDLE_MS) || IDLE_MS;

  // Um pedido em streaming. Devolve { ans, tokensIn, tokensOut, thinkTokens,
  // raciocinio, origem, raw } ou lança erro (com e.parcial: tokens e raciocínio).
  async function chat(ctx, format, system, user, kind) {
    const semFormato = !!ctx.semFormato;
    const body = {
      model: name,
      stream: true,
      think,
      options: { temperature: 0, num_predict: numPredict },
      ...(semFormato ? {} : { format }),
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: semFormato ? user + '\nEscreva a resposta: só o JSON, numa linha, sem mais nada.' : user },
      ],
    };
    const onProgress = typeof ctx.onProgress === 'function' ? ctx.onProgress : null;
    const t0 = performance.now();
    let thinking = '', content = '', final = null, erroOllama = null, lastEmit = -Infinity;
    const emit = force => {
      if (!onProgress) return;
      const now = performance.now();
      if (!force && now - lastEmit < 250) return;
      lastEmit = now;
      const phase = content ? 'respondendo' : thinking ? 'pensando' : 'aguardando';
      try {
        onProgress({ phase, thinkingChars: thinking.length, contentChars: content.length, elapsedMs: Math.round(now - t0),
          thinkingTail: thinking.slice(-TAIL), semFormato });
      } catch { /* o painel não deve derrubar o pedido */ }
    };
    const beat = onProgress ? setInterval(() => { if (performance.now() - lastEmit >= 1000) emit(true); }, 1000) : null;
    emit(true);
    let r;
    try {
      r = await postStream(`${base}/api/chat`, body, {
        idleMs: idle, totalMs, signal: ctx.signal,
        onChunk: obj => {
          if (obj?.error) { erroOllama = String(obj.error); return; }
          const m = obj?.message || {};
          if (typeof m.thinking === 'string') thinking += m.thinking;
          if (typeof m.content === 'string') content += m.content;
          if (obj?.done) final = obj;
          emit(false);
        },
      });
    } catch (e) {
      // tempo esgotado, rede, interrompido: guarda o raciocínio que já chegou
      throw erroCom(e.message || String(e), null, { tokensIn: 0, tokensOut: 0, thinkTokens: thinking ? Math.ceil(thinking.length / 4) : 0, raciocinio: thinking || null });
    } finally { if (beat) clearInterval(beat); }
    emit(true);
    const tokens = {
      tokensIn: final?.prompt_eval_count ?? 0,
      tokensOut: final?.eval_count ?? 0,
      thinkTokens: think || thinking ? thinkTokensOf(final, thinking, content) : 0,
      raciocinio: thinking || null,
    };
    if (!r.ok) {
      let msg = r.text || '';
      try { msg = JSON.parse(msg).error || msg; } catch { /* texto */ }
      throw erroCom(`Ollama HTTP ${r.status}: ${String(msg).slice(0, 200)}`, null, tokens);
    }
    if (erroOllama) throw erroCom(`Ollama: ${erroOllama.slice(0, 200)}`, null, tokens);
    const raw = {
      content: content.slice(0, 500), thinkingChars: thinking.length,
      ...(final?.done_reason ? { doneReason: final.done_reason } : {}),
      ...(Number.isFinite(final?.eval_duration) ? { evalDurationMs: Math.round(final.eval_duration / 1e6) } : {}),
      ...(semFormato ? { semFormato: true } : {}),
    };
    let ans = null, origem = semFormato ? 'sem-format' : null;
    if (content.trim()) {
      ans = lerResposta(content, semFormato ? 'tolerante' : 'json', kind);
      if (!ans) {
        if (final?.done_reason === 'length') throw erroCom(`resposta cortada: aumente o limite de tokens (agora ${numPredict}; --max-tokens ou "Limite de tokens")`, 'CORTADA', tokens);
        throw erroCom(semFormato ? `resposta sem ${kind.campo} legível: ${content.slice(0, 120)}` : `conteúdo não é JSON: ${content.slice(0, 120)}`, null, tokens);
      }
    } else {
      // conteúdo vazio: a resposta pode ter ficado no raciocínio
      ans = thinking ? lerResposta(thinking, 'raciocinio', kind) : null;
      if (ans) origem = 'raciocinio';
      else if (final?.done_reason === 'length') throw erroCom(`resposta cortada: aumente o limite de tokens (agora ${numPredict}; --max-tokens ou "Limite de tokens")`, 'CORTADA', tokens);
      else if (thinking && !semFormato) throw erroCom('o modelo só pensou e não respondeu', 'SO_PENSOU', tokens);
      else throw erroCom(thinking ? 'o modelo só pensou e não respondeu (também sem format)' : 'resposta vazia (sem message.content)', null, tokens);
    }
    return { ans, ...tokens, ...(origem ? { origem } : {}), raw };
  }
  return {
    name: 'ollama',
    model: name,
    pensar: think,
    livre: true,
    maxTokens: numPredict,
    timeoutMs: totalMs,
    idleMs: idle,
    async choose(ctx) {
      const format = {
        type: 'object',
        properties: { escolha: { type: 'string', enum: ctx.ids }, motivo: { type: 'string' } },
        required: ['escolha'],
      };
      const { ans, ...rest } = await chat(ctx, format, SYSTEM, userMessage(ctx), { campo: 'escolha', ids: ctx.ids });
      return {
        id: typeof ans?.escolha === 'string' ? semAcento(ans.escolha.trim()) : ans?.escolha,
        motivo: typeof ans?.motivo === 'string' ? ans.motivo : null,
        ...rest,
      };
    },
    async chooseFree(ctx) {
      const evitar = [...(ctx.palavras_ja_tentadas || []), ...(ctx.tentativas_invalidas_nesta_rodada || []).map(t => t.palavra)];
      const { ans, ...rest } = await chat(ctx, FORMAT_LIVRE, SYSTEM_LIVRE, userMessageLivre(ctx), { campo: 'palavra', evitar });
      return {
        word: typeof ans?.palavra === 'string' ? ans.palavra : null,
        motivo: typeof ans?.motivo === 'string' ? ans.motivo : null,
        ...rest,
      };
    },
  };
}

export { SYSTEM, userMessage, SYSTEM_LIVRE, userMessageLivre, FORMAT_LIVRE, lerResposta };
