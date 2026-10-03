// Servidor falso que imita POST /api/chat do Ollama, para testar o caminho
// pedido/resposta do backend ollama sem modelo.
//   Primeiro o código (format com enum): responde sempre a primeira opção do
//     enum; MOCK_MODO=invalido devolve um id que não está nas opções.
//   Modo livre (format sem enum, com "palavra"): responde palavras comuns de uma
//     lista fixa, em ciclo, pulando as que o pedido diz já tentadas/recusadas;
//     MOCK_MODO=invalido devolve sempre "qzxwv" (não é palavra), para testar as
//     novas tentativas e o sorteio; MOCK_MODO=misto erra a 1.ª proposta de cada
//     rodada e acerta a 2.ª. O mock não sabe o segredo: só acerta por acaso.
//   Com think: true devolve também message.thinking.
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
// "Palavras já tentadas (não repita): A, B." e "Propostas recusadas nesta rodada (não repita): X (motivo), ..."
function usadas(text) {
  const out = new Set();
  for (const re of [/Palavras já tentadas[^:]*:\s*(.*)$/m, /Propostas recusadas nesta rodada[^:]*:\s*(.*)$/m]) {
    const m = text.match(re);
    if (m) for (const p of m[1].replace(/\([^)]*\)/g, '').replace(/\.$/, '').split(',')) if (p.trim() && p.trim() !== 'nenhuma') out.add(norm(p.trim().toLowerCase()));
  }
  return out;
}
function proxima(text) {
  const skip = usadas(text);
  for (let i = 0; i < PALAVRAS.length; i++) {
    const w = PALAVRAS[(cursor + i) % PALAVRAS.length];
    if (!skip.has(norm(w))) { cursor = (cursor + i + 1) % PALAVRAS.length; return w; }
  }
  return PALAVRAS[cursor++ % PALAVRAS.length];
}

http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/chat') { res.writeHead(404); return res.end('{}'); }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    let q;
    try { q = JSON.parse(body); } catch { res.writeHead(400); return res.end('{"error":"json inválido"}'); }
    const ids = q?.format?.properties?.escolha?.enum;
    const livre = !ids && q?.format?.properties?.palavra?.type === 'string' && q.format.required?.includes('palavra');
    const base = q.stream === false && typeof q.think === 'boolean' && q.options?.temperature === 0 &&
      q.messages?.[0]?.role === 'system' && q.messages?.[1]?.role === 'user';
    const ok = base && (livre || (Array.isArray(ids) && ids.length));
    if (!ok) { res.writeHead(400); return res.end('{"error":"pedido fora do formato esperado"}'); }
    calls++;
    if (process.env.MOCK_VERBOSE === 'todos' || (process.env.MOCK_VERBOSE && (calls === 2 || (livre && calls <= 3)))) console.log(q.messages[1].content + '\n---');
    let content;
    if (livre) {
      const user = q.messages[1].content;
      const ruim = process.env.MOCK_MODO === 'invalido' || (process.env.MOCK_MODO === 'misto' && !/Propostas recusadas nesta rodada/.test(user));
      const palavra = ruim ? 'qzxwv' : proxima(user);
      content = JSON.stringify({ palavra, motivo: ruim ? 'mock: palavra inválida' : 'mock: palavra comum da lista' });
    } else {
      const escolha = process.env.MOCK_MODO === 'invalido' ? 'xxxxx' : ids[0];
      content = JSON.stringify({ escolha, motivo: 'mock: primeira opção' });
    }
    const message = { role: 'assistant', content };
    if (q.think === true) message.thinking = 'Vou pensar: olho as letras que existem e as que não existem e escolho uma palavra comum que ainda não tentei.';
    const out = {
      model: q.model, created_at: new Date().toISOString(), done: true, message,
      prompt_eval_count: Math.ceil(JSON.stringify(q.messages).length / 4),
      eval_count: 12 + (q.think === true ? 30 : 0),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(port, '127.0.0.1', () => console.log(`mock-ollama ouvindo em http://127.0.0.1:${port} (${PALAVRAS.length} palavras para o modo livre)`));
