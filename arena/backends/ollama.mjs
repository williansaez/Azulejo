// Backend Ollama (/api/chat) com saída estruturada: o modelo só escolhe um id.
import { postJson, env } from './index.mjs';

const SYSTEM = `Você está jogando "Azulejo das Palavras", um jogo de adivinhar palavras em português parecido com o Wordle.
A cada rodada você recebe o estado do jogo (tentativas já feitas e as cores de cada letra) e uma lista curta de opções de palavra, já calculadas por um programa que conhece o dicionário.
Cada opção diz se ainda pode ser a resposta, quão comum é a palavra, quanta informação ela traz (em bits) e quantas palavras devem sobrar em média depois de jogá-la.
Seu objetivo é acertar a palavra secreta no menor número de tentativas. No começo vale mais ganhar informação; quando sobram poucas palavras, vale mais chutar uma que pode ser a resposta.
Responda APENAS com JSON no formato {"escolha": "<id de uma das opções>", "motivo": "<frase curta>"}. Não escreva mais nada.`;

function userMessage(ctx) {
  const s = ctx.state;
  const lines = [`Rodada ${s.rodada}. ${s.regras}`];
  if (s.tentativas_feitas.length) {
    lines.push('', 'Tentativas feitas:');
    for (const t of s.tentativas_feitas) lines.push(`${t.numero}. ${t.palavra} → ${t.cores.join('; ')}`);
  } else lines.push('', 'Ainda não houve tentativas.');
  lines.push('', `Palavras possíveis restantes: ${s.palavras_possiveis_restantes}.`, '', 'Opções (escolha uma pelo campo "id"):');
  for (const o of ctx.options) lines.push(JSON.stringify(o));
  lines.push('', 'Responda só com o JSON {"escolha": "...", "motivo": "..."}.');
  return lines.join('\n');
}

// opts: { model, baseUrl } (baseUrl pode ser relativo, ex.: /ollama via servir.mjs)
export function create({ model, baseUrl } = {}) {
  const base = (baseUrl || env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const name = model || 'qwen3.5:9b';
  return {
    name: 'ollama',
    model: name,
    async choose(ctx) {
      const body = {
        model: name,
        stream: false,
        think: false,
        options: { temperature: 0 },
        format: {
          type: 'object',
          properties: { escolha: { type: 'string', enum: ctx.ids }, motivo: { type: 'string' } },
          required: ['escolha'],
        },
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: userMessage(ctx) },
        ],
      };
      const r = await postJson(`${base}/api/chat`, body);
      if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(r.text || '').slice(0, 200)}`);
      const content = r.json?.message?.content;
      if (typeof content !== 'string') throw new Error('resposta sem message.content');
      let ans;
      try { ans = JSON.parse(content); } catch { throw new Error(`conteúdo não é JSON: ${content.slice(0, 120)}`); }
      return {
        id: typeof ans?.escolha === 'string' ? ans.escolha.trim().toLowerCase() : ans?.escolha,
        motivo: ans?.motivo ?? null,
        tokensIn: r.json.prompt_eval_count ?? 0,
        tokensOut: r.json.eval_count ?? 0,
        raw: content,
      };
    },
  };
}

export { SYSTEM, userMessage };
