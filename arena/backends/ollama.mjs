// Backend Ollama (/api/chat) com saída estruturada.
//   choose(ctx)      primeiro o código: o modelo só escolhe um id da lista.
//   chooseFree(ctx)  modo livre (Invisível): o modelo inventa a palavra.
// opts.pensar = true manda think: true (modelos com raciocínio); por padrão
// think: false.
import { postJson, env } from './index.mjs';

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
function thinkTokensOf(json) {
  const own = json?.thinking_eval_count ?? json?.thinking_count;
  if (Number.isFinite(own)) return own;
  const th = json?.message?.thinking;
  if (typeof th !== 'string' || !th.length) return 0;
  const out = json.eval_count ?? 0;
  const content = json?.message?.content ?? '';
  if (!out) return Math.ceil(th.length / 4);
  return Math.max(1, Math.round(out * th.length / (th.length + content.length)));
}

// opts: { model, baseUrl, pensar } (baseUrl pode ser relativo, ex.: /ollama via servir.mjs)
export function create({ model, baseUrl, pensar } = {}) {
  const base = (baseUrl || env.OLLAMA_URL || 'http://localhost:11434').replace(/\/$/, '');
  const name = model || 'qwen3.5:9b';
  const think = !!pensar;
  async function chat(format, system, user) {
    const body = {
      model: name,
      stream: false,
      think,
      options: { temperature: 0 },
      format,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    };
    const r = await postJson(`${base}/api/chat`, body);
    if (!r.ok) throw new Error(`Ollama HTTP ${r.status}: ${(r.text || '').slice(0, 200)}`);
    const content = r.json?.message?.content;
    if (typeof content !== 'string') throw new Error('resposta sem message.content');
    let ans;
    try { ans = JSON.parse(content); } catch { throw new Error(`conteúdo não é JSON: ${content.slice(0, 120)}`); }
    const thinking = r.json?.message?.thinking;
    return {
      ans,
      tokensIn: r.json.prompt_eval_count ?? 0,
      tokensOut: r.json.eval_count ?? 0,
      thinkTokens: think ? thinkTokensOf(r.json) : 0,
      raw: think && typeof thinking === 'string' ? { content, thinkingChars: thinking.length } : content,
    };
  }
  return {
    name: 'ollama',
    model: name,
    pensar: think,
    livre: true,
    async choose(ctx) {
      const format = {
        type: 'object',
        properties: { escolha: { type: 'string', enum: ctx.ids }, motivo: { type: 'string' } },
        required: ['escolha'],
      };
      const { ans, ...rest } = await chat(format, SYSTEM, userMessage(ctx));
      return {
        id: typeof ans?.escolha === 'string' ? ans.escolha.trim().toLowerCase() : ans?.escolha,
        motivo: ans?.motivo ?? null,
        ...rest,
      };
    },
    async chooseFree(ctx) {
      const { ans, ...rest } = await chat(FORMAT_LIVRE, SYSTEM_LIVRE, userMessageLivre(ctx));
      return {
        word: typeof ans?.palavra === 'string' ? ans.palavra : null,
        motivo: typeof ans?.motivo === 'string' ? ans.motivo : null,
        ...rest,
      };
    },
  };
}

export { SYSTEM, userMessage, SYSTEM_LIVRE, userMessageLivre, FORMAT_LIVRE };
