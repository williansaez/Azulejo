// Contrato comum dos backends.
// Cada backend exporta create(opts) -> { name, model, livre, choose(ctx), chooseFree(ctx) };
// opts pode trazer { model, baseUrl, apiKey, pensar } (a página do navegador usa
// isso) e, no que faltar, vale o ambiente (OLLAMA_URL, TYPESAFE_URL,
// TYPESAFE_API_KEY).
//
// Primeiro o código (4 a 9 letras e Extremo): choose devolve
// { id, tokensIn, tokensOut, thinkTokens, motivo, raw } ou lança erro.
// pick() mede a latência, valida a escolha e, se algo falhar, cai na escolha
// do código (ctx.codeChoice) marcando a jogada como inválida.
//
// Modo livre (Invisível): chooseFree(ctx) devolve
// { word, motivo, tokensIn, tokensOut, thinkTokens, raw } ou lança erro; o
// modelo inventa a palavra sozinho a partir do que um jogador veria (ver
// ../livre.mjs). livre === false quer dizer que o backend não gera palavras
// (code e jev só escolhem entre opções) e chooseFree lança erro.
// pickFree() só mede e normaliza a resposta; quem valida a palavra (tamanho,
// dicionário, repetida) e pede de novo até vir uma válida (ou abandona a
// partida no limite de propostas) é o harness (livre.mjs). Não há sorteio.

export async function loadBackend(name, opts) {
  if (!['code', 'ollama', 'jev'].includes(name)) throw new Error(`Backend desconhecido: ${name} (use code, ollama ou jev)`);
  const mod = await import(`./${name}.mjs`);
  return mod.create(opts);
}

// ctx = { state, options, ids, codeChoice, onProgress? }
// Se o modelo só pensou e não respondeu (erro com code SO_PENSOU), pede uma
// vez de novo sem format (ctx.semFormato) e anota o erro em avisos; a jogada
// só é inválida se o segundo pedido também falhar.
export async function pick(backend, ctx) {
  const t0 = performance.now();
  let out = null, erro = null, parcial = null;
  const avisos = [];
  try { out = await backend.choose(ctx); } catch (e) {
    erro = e.message || String(e); parcial = e.parcial || null;
    if (e.code === 'SO_PENSOU') {
      avisos.push(`${erro}; pedido de novo sem format`);
      erro = null;
      try { out = await backend.choose({ ...ctx, semFormato: true }); } catch (e2) { erro = e2.message || String(e2); parcial = somaParcial(parcial, e2.parcial); }
    }
  }
  const latencyMs = Math.round(performance.now() - t0);
  const valid = out && ctx.ids.includes(out.id);
  if (out && !valid && !erro) erro = `escolha fora das opções: ${JSON.stringify(out.id)}`;
  const tot = somaParcial(parcial, out);
  return {
    id: valid ? out.id : ctx.codeChoice,
    latencyMs,
    invalid: !valid,
    tokensIn: tot.tokensIn, tokensOut: tot.tokensOut, thinkTokens: tot.thinkTokens,
    motivo: out?.motivo ?? null,
    erro,
    ...(avisos.length ? { avisos } : {}),
    raciocinio: juntaRaciocinio(parcial?.raciocinio, out?.raciocinio),
    raw: out?.raw ?? null,
  };
}

// Soma tokens de um pedido que falhou (e.parcial) com os do pedido seguinte.
function somaParcial(a, b) {
  return {
    tokensIn: (a?.tokensIn ?? 0) + (b?.tokensIn ?? 0),
    tokensOut: (a?.tokensOut ?? 0) + (b?.tokensOut ?? 0),
    thinkTokens: (a?.thinkTokens ?? 0) + (b?.thinkTokens ?? 0),
    raciocinio: juntaRaciocinio(a?.raciocinio, b?.raciocinio),
  };
}
const juntaRaciocinio = (a, b) => [a, b].filter(x => typeof x === 'string' && x).join('\n--- pedido de novo ---\n') || null;

// Raciocínio guardado no registro: no máximo n caracteres (fica o fim, onde
// está a conclusão).
export const MAX_RACIOCINIO = 4000;
export function cortaRaciocinio(t, n = MAX_RACIOCINIO) {
  if (typeof t !== 'string' || !t) return null;
  return t.length > n ? '…' + t.slice(-(n - 1)) : t;
}

// Modo livre. ctx = { regras, rodada, tentativas, historico, letras_que_existem,
//   letras_que_nao_existem, palavras_ja_tentadas, dica_tamanho,
//   tentativas_invalidas_nesta_rodada, onProgress?, semFormato? }.
// Devolve { word, latencyMs, invalid, tokensIn, tokensOut, thinkTokens, raw,
//   motivo, raciocinio, soPensou?, origem?, erro }. soPensou: o modelo só
// pensou e não respondeu (quem chama pede de novo uma vez sem format).
// word é o texto proposto (aparado) ou null; invalid só diz que não veio uma
// palavra (erro de rede/HTTP/JSON ou campo vazio). A validação contra o
// dicionário fica no harness.
export const ERRO_LIVRE = 'este backend não joga no modo livre';
export async function pickFree(backend, ctx) {
  const t0 = performance.now();
  let out = null, erro = null, parcial = null, soPensou = false;
  try {
    if (typeof backend.chooseFree !== 'function') throw new Error(ERRO_LIVRE);
    out = await backend.chooseFree(ctx);
  } catch (e) { erro = e.message || String(e); parcial = e.parcial || null; soPensou = e.code === 'SO_PENSOU'; }
  const latencyMs = Math.round(performance.now() - t0);
  const word = typeof out?.word === 'string' && out.word.trim() ? out.word.trim() : null;
  if (out && !word && !erro) erro = `resposta sem palavra: ${JSON.stringify(out.word ?? null)}`;
  const src = out || parcial;
  return {
    word,
    latencyMs,
    invalid: !word,
    tokensIn: src?.tokensIn ?? 0,
    tokensOut: src?.tokensOut ?? 0,
    thinkTokens: src?.thinkTokens ?? 0,
    raw: out?.raw ?? null,
    motivo: out?.motivo ?? null,
    raciocinio: src?.raciocinio || null,
    ...(soPensou ? { soPensou: true } : {}),
    ...(out?.origem ? { origem: out.origem } : {}),
    erro,
  };
}

// Variáveis de ambiente quando roda no Node; no navegador não há process.
export const env = globalThis.process?.env ?? {};

// fetch com tempo limite (ARENA_TIMEOUT_MS, padrão 120 s).
// Funciona no Node e no navegador (sem imports do Node).
export async function postJson(url, body, headers = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(env.ARENA_TIMEOUT_MS) || 120000),
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* corpo não-JSON */ }
  return { status: res.status, ok: res.ok, json, text, headers: res.headers };
}

// POST com resposta em streaming NDJSON (uma linha JSON por pedaço, como o
// Ollama com stream: true). Sem tempo limite total enquanto chegam pedaços:
//   idleMs   sem nenhum pedaço por este tempo, aborta;
//   totalMs  teto do pedido inteiro.
// onChunk(obj) é chamado para cada objeto. Se o servidor responder um JSON
// só (sem streaming), ele chega como um único objeto. Devolve
// { status, ok, text (só quando !ok), chunks }. Funciona no Node 20 e no
// navegador (fetch + ReadableStream).
export async function postStream(url, body, { headers = {}, onChunk, idleMs = 180000, totalMs = 900000, signal } = {}) {
  if (signal?.aborted) throw new Error('interrompido');
  const ac = new AbortController();
  let motivo = null;
  const abort = m => { if (!motivo) { motivo = m; ac.abort(); } };
  const seg = ms => `${ms % 1000 ? (ms / 1000).toFixed(1) : ms / 1000} s`;
  const total = setTimeout(() => abort(`tempo máximo do pedido esgotado (${seg(totalMs)}; ARENA_TIMEOUT_MS ou "Tempo máx. por proposta")`), totalMs);
  let idle = null;
  const poke = () => { clearTimeout(idle); idle = setTimeout(() => abort(`o modelo ficou ${seg(idleMs)} sem mandar nada (ARENA_IDLE_MS)`), idleMs); };
  const onExt = () => abort('interrompido');
  signal?.addEventListener?.('abort', onExt);
  poke();
  let chunks = 0;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson, application/json', ...headers },
      body: JSON.stringify(body),
      signal: ac.signal,
    });
    poke();
    if (!res.ok) return { status: res.status, ok: false, text: await res.text(), chunks };
    const dec = new TextDecoder();
    let buf = '', all = '', bad = 0;
    const line = l => {
      if (!l.trim()) return;
      let obj;
      try { obj = JSON.parse(l); } catch { bad++; return; }
      chunks++;
      onChunk?.(obj);
    };
    const feed = text => {
      buf += text; all += text;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { line(buf.slice(0, i)); buf = buf.slice(i + 1); }
    };
    if (res.body?.getReader) {
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        poke();
        feed(dec.decode(value, { stream: true }));
      }
      feed(dec.decode());
    } else feed(await res.text());
    if (buf.trim()) line(buf);
    // JSON único em várias linhas (sem streaming e formatado): tenta o corpo todo
    if (!chunks && bad && all.trim()) { try { const obj = JSON.parse(all); chunks++; onChunk?.(obj); } catch { /* não é JSON */ } }
    if (!chunks) throw new Error(`resposta sem JSON: ${all.slice(0, 160)}`);
    return { status: res.status, ok: true, chunks };
  } catch (e) {
    if (motivo) throw new Error(motivo);
    throw e;
  } finally {
    clearTimeout(total); clearTimeout(idle);
    signal?.removeEventListener?.('abort', onExt);
    ac.abort(); // se saiu no meio (erro num pedaço), não deixa o corpo a correr

  }
}
