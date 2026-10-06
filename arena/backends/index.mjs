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

// ctx = { state, options, ids, codeChoice }
export async function pick(backend, ctx) {
  const t0 = performance.now();
  let out = null, erro = null;
  try { out = await backend.choose(ctx); } catch (e) { erro = e.message || String(e); }
  const latencyMs = Math.round(performance.now() - t0);
  const valid = out && ctx.ids.includes(out.id);
  if (out && !valid && !erro) erro = `escolha fora das opções: ${JSON.stringify(out.id)}`;
  return {
    id: valid ? out.id : ctx.codeChoice,
    latencyMs,
    invalid: !valid,
    tokensIn: out?.tokensIn ?? 0,
    tokensOut: out?.tokensOut ?? 0,
    thinkTokens: out?.thinkTokens ?? 0,
    motivo: out?.motivo ?? null,
    erro,
    raw: out?.raw ?? null,
  };
}

// Modo livre. ctx = { regras, rodada, tentativas, historico, letras_que_existem,
//   letras_que_nao_existem, palavras_ja_tentadas, dica_tamanho,
//   tentativas_invalidas_nesta_rodada }.
// Devolve { word, latencyMs, invalid, tokensIn, tokensOut, thinkTokens, raw, motivo, erro }.
// word é o texto proposto (aparado) ou null; invalid só diz que não veio uma
// palavra (erro de rede/HTTP/JSON ou campo vazio). A validação contra o
// dicionário fica no harness.
export const ERRO_LIVRE = 'este backend não joga no modo livre';
export async function pickFree(backend, ctx) {
  const t0 = performance.now();
  let out = null, erro = null;
  try {
    if (typeof backend.chooseFree !== 'function') throw new Error(ERRO_LIVRE);
    out = await backend.chooseFree(ctx);
  } catch (e) { erro = e.message || String(e); }
  const latencyMs = Math.round(performance.now() - t0);
  const word = typeof out?.word === 'string' && out.word.trim() ? out.word.trim() : null;
  if (out && !word && !erro) erro = `resposta sem palavra: ${JSON.stringify(out.word ?? null)}`;
  return {
    word,
    latencyMs,
    invalid: !word,
    tokensIn: out?.tokensIn ?? 0,
    tokensOut: out?.tokensOut ?? 0,
    thinkTokens: out?.thinkTokens ?? 0,
    raw: out?.raw ?? null,
    motivo: out?.motivo ?? null,
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
