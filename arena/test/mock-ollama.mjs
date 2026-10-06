// Servidor falso que imita POST /api/chat do Ollama, para testar o caminho
// pedido/resposta do backend ollama sem modelo.
//   Primeiro o código (format com enum): responde sempre a primeira opção do
//     enum; MOCK_MODO=invalido devolve um id que não está nas opções.
//   Modo livre (format sem enum, com "palavra"): responde palavras comuns de uma
//     lista fixa, em ciclo, pulando as que o pedido diz já tentadas/recusadas.
//     Lê as recusadas da rodada nas linhas "- PALAVRA: motivo" da mensagem e
//     nunca repete uma delas.
//     MOCK_MODO=invalido devolve sempre uma não-palavra nova (qzxwa, qzxwb, …),
//       para testar o abandono no limite de propostas;
//     MOCK_MODO=teimoso erra as 3 primeiras propostas de cada rodada (uma
//       não-palavra, uma com hífen e uma curta demais) e acerta a 4.ª;
//     MOCK_MODO=misto erra a 1.ª proposta de cada rodada e acerta a 2.ª.
//     O mock não sabe o segredo: só acerta por acaso.
//   Com think: true devolve também message.thinking.
//   Streaming: com stream: true responde em NDJSON (application/x-ndjson):
//     com think, 8 pedaços de message.thinking a cada ~150 ms, depois a
//     resposta em pedaços e o pedaço final (done: true, done_reason,
//     prompt_eval_count, eval_count, eval_duration). Com stream: false (ou
//     MOCK_STREAM=0) responde um JSON só, como antes.
//     MOCK_MODO=sopensa: raciocínio e depois conteúdo VAZIO (done_reason
//       'stop'), sempre que o pedido tem format; sem format (o novo pedido do
//       backend) responde normalmente, em texto (JSON num bloco ```json).
//     MOCK_MODO=lento: 5 s de raciocínio (25 pedaços a cada 200 ms; outro
//       tempo com MOCK_LENTO_MS).
//     MOCK_MODO=cortada: raciocínio e conteúdo vazio com done_reason 'length'.
//   Sem format (pedido tolerante), o modo e as opções saem das mensagens.
//   node arena/test/mock-ollama.mjs [porta]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { norm } from '../solver.mjs';

const port = Number(process.argv[2] || process.env.PORT || 11435);
const DIC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dicionario');

// Palavras comuns de vários tamanhos; ao iniciar, confere cada uma no
// dicionario/<n>.json do seu tamanho (chaves de w ∪ x) e descarta as que faltam.
const COMUNS = ['casa', 'porta', 'janela', 'caminho', 'estrada', 'trabalho', 'verdade', 'pessoas', 'cidade',
  'tempo', 'mundo', 'livro', 'amigo', 'escola', 'música', 'história', 'começo', 'futuro', 'sempre', 'grande',
  'felicidade', 'importante', 'conhecimento', 'computador'];
const valid = new Map();
function validSet(n) {
  if (!valid.has(n)) {
    let set = new Set();
    try {
      const d = JSON.parse(fs.readFileSync(path.join(DIC, `${n}.json`), 'utf8'));
      set = new Set([...(d.w ? d.w.split(' ') : []).map(norm), ...(d.x ? d.x.split(' ') : [])]);
    } catch { /* tamanho sem dicionário */ }
    valid.set(n, set);
  }
  return valid.get(n);
}
const PALAVRAS = COMUNS.filter(w => {
  const ok = validSet(norm(w).length).has(norm(w));
  if (!ok) console.warn(`mock-ollama: "${w}" não está em dicionario/${norm(w).length}.json; fora da lista`);
  return ok;
});

let calls = 0, cursor = 0;
// "Palavras já tentadas (não repita): A, B." (uma linha) e as recusadas da
// rodada, uma por linha: "- PALAVRA: motivo".
function tentadas(text) {
  const out = new Set();
  const m = text.match(/Palavras já tentadas[^:]*:\s*(.*)$/m);
  if (m) for (const p of m[1].replace(/\.$/, '').split(',')) if (p.trim() && p.trim() !== 'nenhuma') out.add(norm(p.trim().toLowerCase()));
  return out;
}
const recusadas = text => [...text.matchAll(/^- (.+?): /gm)].map(m => m[1].trim().toLowerCase());
const usadas = text => new Set([...tentadas(text), ...recusadas(text).map(norm)]);
// Não-palavras para os modos de erro, sempre novas (nunca uma já recusada).
const TEIMOSO = ['qzxwv', 'bem-vindo', 'sol'];
function invalida(text, i) {
  const ja = new Set(recusadas(text));
  if (i != null && i < TEIMOSO.length && !ja.has(TEIMOSO[i])) return TEIMOSO[i];
  for (let k = 0; ; k++) {
    let suf = '', x = k;
    do { suf = String.fromCharCode(97 + (x % 26)) + suf; x = Math.floor(x / 26) - 1; } while (x >= 0);
    const w = 'qzxw' + suf;
    if (!ja.has(w)) return w;
  }
}
function proxima(text) {
  const skip = usadas(text);
  for (let i = 0; i < PALAVRAS.length; i++) {
    const w = PALAVRAS[(cursor + i) % PALAVRAS.length];
    if (!skip.has(norm(w))) { cursor = (cursor + i + 1) % PALAVRAS.length; return w; }
  }
  return PALAVRAS[cursor++ % PALAVRAS.length];
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
// Raciocínio falso, em minúsculas e sem JSON (para o caminho "só pensou" não
// achar uma resposta nele). Cada pedaço é diferente, para a página ver mudar.
const PENSAMENTOS = [
  'Vou pensar com calma. ', 'Primeiro olho as letras que já sei que existem na palavra secreta. ',
  'Depois descarto as letras que não existem, para não gastar tentativas. ', 'A palavra secreta tem de quatro a nove letras. ',
  'Convém uma palavra comum, com vogais diferentes. ', 'Não posso repetir nenhuma tentativa já feita nem uma recusada. ',
  'Comparo algumas opções e penso em quantas letras novas cada uma testa. ', 'Já sei o que vou responder. ',
];
function pensamento(i) { return `(${i + 1}) ${PENSAMENTOS[i % PENSAMENTOS.length]}`; }

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/chat') { res.writeHead(404); return res.end('{}'); }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', async () => {
    let q;
    try { q = JSON.parse(body); } catch { res.writeHead(400); return res.end('{"error":"json inválido"}'); }
    const temFormat = !!q.format;
    const sys = q.messages?.[0]?.content || '', user0 = q.messages?.[1]?.content || '';
    // ids: do enum do format ou, sem format, das linhas {"id": ...} da mensagem
    let ids = q?.format?.properties?.escolha?.enum;
    if (!temFormat && !/modo Invisível/.test(sys)) ids = [...user0.matchAll(/^\{"id":"([^"]+)"/gm)].map(m => m[1]);
    const livre = temFormat ? (!ids && q?.format?.properties?.palavra?.type === 'string' && q.format.required?.includes('palavra')) : /modo Invisível/.test(sys);
    const base = typeof q.stream === 'boolean' && typeof q.think === 'boolean' && q.options?.temperature === 0 &&
      q.messages?.[0]?.role === 'system' && q.messages?.[1]?.role === 'user';
    const ok = base && (livre || (Array.isArray(ids) && ids.length));
    if (!ok) { res.writeHead(400); return res.end('{"error":"pedido fora do formato esperado"}'); }
    calls++;
    const modo = process.env.MOCK_MODO;
    if (process.env.MOCK_LOG) console.log(`pedido ${calls}: stream=${q.stream} think=${q.think} format=${temFormat ? 'sim' : 'não'} num_predict=${q.options?.num_predict ?? '-'}`);
    if (process.env.MOCK_VERBOSE === 'todos' || (process.env.MOCK_VERBOSE && (calls === 2 || (livre && calls <= 3)))) console.log(q.messages[1].content + '\n---');
    let content;
    if (livre) {
      const user = q.messages[1].content;
      const nRec = recusadas(user).length;
      const ruim = modo === 'invalido' || (modo === 'misto' && nRec === 0) || (modo === 'teimoso' && nRec < 3);
      const palavra = ruim ? invalida(user, modo === 'teimoso' ? nRec : null) : proxima(user);
      content = JSON.stringify({ palavra, motivo: ruim ? 'mock: palavra inválida' : 'mock: palavra comum da lista' });
    } else {
      const escolha = modo === 'invalido' ? 'xxxxx' : ids[0];
      content = JSON.stringify({ escolha, motivo: 'mock: primeira opção' });
    }
    if (!temFormat) content = 'Aqui está a minha resposta:\n```json\n' + content + '\n```';
    // conteúdo vazio: só pensa (sopensa, com format) ou corta (cortada)
    const vazio = q.think === true && ((modo === 'sopensa' && temFormat) || modo === 'cortada');
    const doneReason = modo === 'cortada' ? 'length' : 'stop';
    if (vazio) content = '';
    const nThink = q.think === true ? (modo === 'lento' ? Math.max(1, Math.round((Number(process.env.MOCK_LENTO_MS) || 5000) / 200)) : 8) : 0;
    const passo = modo === 'lento' ? 200 : 150;
    const thinkingParts = Array.from({ length: nThink }, (_, i) => pensamento(i));
    const thinking = thinkingParts.join('');
    const final = {
      model: q.model, created_at: new Date().toISOString(), done: true, done_reason: doneReason,
      prompt_eval_count: Math.ceil(JSON.stringify(q.messages).length / 4),
      eval_count: Math.ceil((thinking.length + content.length) / 4) + 2,
      eval_duration: (nThink * passo + 90) * 1e6, total_duration: (nThink * passo + 120) * 1e6,
    };
    if (q.stream === false || process.env.MOCK_STREAM === '0') {
      const message = { role: 'assistant', content };
      if (q.think === true) message.thinking = thinking;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ...final, message }));
    }
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
    res.flushHeaders();
    let closed = false;
    res.on('close', () => { closed = true; });
    const chunk = message => res.write(JSON.stringify({ model: q.model, created_at: new Date().toISOString(), message: { role: 'assistant', content: '', ...message }, done: false }) + '\n');
    await sleep(60); // "avaliação do prompt"
    for (const t of thinkingParts) { if (closed) return; chunk({ thinking: t }); await sleep(passo); }
    const pedacos = content ? content.match(/[\s\S]{1,12}/g) : [];
    for (const c of pedacos) { if (closed) return; chunk({ content: c }); await sleep(30); }
    if (closed) return;
    res.end(JSON.stringify({ ...final, message: { role: 'assistant', content: '' } }) + '\n');
  });
}).listen(port, '127.0.0.1', () => console.log(`mock-ollama ouvindo em http://127.0.0.1:${port} (${PALAVRAS.length} palavras para o modo livre${process.env.MOCK_MODO ? `, MOCK_MODO=${process.env.MOCK_MODO}` : ''})`));
