// Backend TypeSafe "System One" (o "Jev" do jev-tetris).
// Formato copiado de jev-tetris/public/jev.js; o host e o formato NÃO foram
// verificados aqui (sem chave). Configure com TYPESAFE_URL e TYPESAFE_API_KEY.
import { postJson, env } from './index.mjs';

const RETRY = new Set([429, 529]);

export function buildRequest(ctx, model) {
  const criteria = {};
  // Como no jev-tetris, cada critério é o objeto da opção (mesmos campos em todas).
  for (const o of ctx.options) { const { id, ...desc } = o; criteria[id] = desc; }
  return {
    state: { game: ctx.state },
    model,
    questions: {
      escolha: {
        type: 'choice',
        instructions: {
          question: 'Qual palavra o jogador deve tentar agora em `game`? Cada opção descreve a palavra e o que se espera depois de jogá-la.',
          priorities: [
            'O objetivo é acertar a palavra secreta no menor número de tentativas.',
            'Uma opção com pode_ser_a_resposta "sim" pode ganhar o jogo já; uma com "não" nunca ganha nesta rodada.',
            'No começo, prefira mais informacao_esperada_bits e menos opcoes_restantes_em_media.',
            'Quando restam poucas palavras possíveis ou poucas tentativas, prefira uma que pode ser a resposta (todas as possíveis têm a mesma chance).',
            'Se informacao_esperada_bits for "não calculada", compare pela pontuacao_heuristica (maior é melhor).',
          ],
        },
        criteria,
      },
    },
  };
}

// opts: { model, baseUrl, apiKey }. Com baseUrl relativo (ex.: /typesafe via
// servir.mjs) a chave é opcional: o proxy acrescenta a dele.
export function create({ model, baseUrl, apiKey } = {}) {
  const base = (baseUrl || env.TYPESAFE_URL || 'https://api.typesafe.ai').replace(/\/$/, '');
  const key = apiKey || env.TYPESAFE_API_KEY || '';
  const viaProxy = base.startsWith('/');
  const name = model || 'jev-latest';
  return {
    name: 'jev',
    model: name,
    livre: false,
    // System One responde perguntas do tipo "choice" (escolhe entre critérios
    // dados); não gera texto livre, por isso não inventa palavras.
    async chooseFree() {
      throw new Error('este backend não joga no modo livre: o Jev (TypeSafe) só escolhe entre opções dadas e o modo Invisível (livre) exige gerar palavras. Use o backend ollama.');
    },
    async choose(ctx) {
      if (!key && !viaProxy) throw new Error('TYPESAFE_API_KEY não definida');
      const body = buildRequest(ctx, name);
      const auth = key ? { Authorization: `Bearer ${key}` } : {};
      let r, delay = 500;
      for (let attempt = 1; ; attempt++) {
        r = await postJson(`${base}/v1/systemone`, body, auth);
        if (r.ok || !RETRY.has(r.status) || attempt >= 4) break;
        const ra = Number(r.headers.get('retry-after'));
        await new Promise(res => setTimeout(res, ra > 0 ? ra * 1000 : delay));
        delay *= 2;
      }
      if (!r.ok) throw new Error(`TypeSafe HTTP ${r.status}: ${(r.text || '').slice(0, 200)}`);
      const ans = r.json?.answers?.escolha;
      if (!ans) throw new Error('resposta sem answers.escolha');
      return {
        id: ans.choice,
        motivo: ans.confidence != null ? `confiança ${ans.confidence}` : null,
        tokensIn: r.json.usage?.input_tokens ?? 0,
        tokensOut: r.json.usage?.output_tokens ?? 0,
        raw: { choice: ans.choice, probabilities: ans.probabilities ?? null, confidence: ans.confidence ?? null },
      };
    },
  };
}
