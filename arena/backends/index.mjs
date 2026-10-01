// Contrato comum dos backends.
// Cada backend exporta create(opts) -> { name, model, choose(ctx) }; opts pode
// trazer { model, baseUrl, apiKey } (a página do navegador usa isso) e, no que
// faltar, vale o ambiente (OLLAMA_URL, TYPESAFE_URL, TYPESAFE_API_KEY). choose
// devolve { id, tokensIn, tokensOut, motivo, raw } ou lança erro.
// pick() mede a latência, valida a escolha e, se algo falhar, cai na escolha
// do código (ctx.codeChoice) marcando a jogada como inválida.

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
    motivo: out?.motivo ?? null,
    erro,
    raw: out?.raw ?? null,
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
