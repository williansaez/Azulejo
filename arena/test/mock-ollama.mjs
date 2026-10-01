// Servidor falso que imita POST /api/chat do Ollama, para testar o caminho
// pedido/resposta do backend ollama sem modelo. Responde sempre a primeira
// opção do enum. MOCK_MODO=invalido devolve um id que não está nas opções.
//   node arena/test/mock-ollama.mjs [porta]
import http from 'node:http';

const port = Number(process.argv[2] || process.env.PORT || 11435);
let calls = 0;
http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/api/chat') { res.writeHead(404); return res.end('{}'); }
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    let q;
    try { q = JSON.parse(body); } catch { res.writeHead(400); return res.end('{"error":"json inválido"}'); }
    const ids = q?.format?.properties?.escolha?.enum;
    const ok = q.stream === false && q.think === false && q.options?.temperature === 0 &&
      Array.isArray(ids) && ids.length && q.messages?.[0]?.role === 'system' && q.messages?.[1]?.role === 'user';
    if (!ok) { res.writeHead(400); return res.end('{"error":"pedido fora do formato esperado"}'); }
    calls++;
    if (process.env.MOCK_VERBOSE && calls === 2) console.log(q.messages[1].content);
    const escolha = process.env.MOCK_MODO === 'invalido' ? 'xxxxx' : ids[0];
    const out = {
      model: q.model, created_at: new Date().toISOString(), done: true,
      message: { role: 'assistant', content: JSON.stringify({ escolha, motivo: 'mock: primeira opção' }) },
      prompt_eval_count: Math.ceil(JSON.stringify(q.messages).length / 4), eval_count: 12,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out));
  });
}).listen(port, '127.0.0.1', () => console.log(`mock-ollama ouvindo em http://127.0.0.1:${port}`));
