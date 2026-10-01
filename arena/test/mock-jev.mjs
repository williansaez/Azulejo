// Servidor falso que imita POST /v1/systemone (TypeSafe), para testar o
// backend jev sem chave real. Escolhe sempre o primeiro critério.
// MOCK_MODO=invalido devolve uma escolha que não existe.
//   node arena/test/mock-jev.mjs [porta]
import http from 'node:http';

const port = Number(process.argv[2] || process.env.PORT || 8788);
http.createServer((req, res) => {
  const send = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  if (req.method !== 'POST' || req.url !== '/v1/systemone') return send(404, { detail: { message: 'não encontrado' } });
  if (!/^Bearer\s+\S+/.test(req.headers.authorization || '')) return send(401, { detail: { error_type: 'authentication_error', message: 'sem chave' } });
  let body = '';
  req.on('data', c => (body += c));
  req.on('end', () => {
    let q;
    try { q = JSON.parse(body); } catch { return send(400, { detail: { message: 'json inválido' } }); }
    const qq = q?.questions?.escolha;
    const ids = Object.keys(qq?.criteria || {});
    if (!q.state?.game || !q.model || qq?.type !== 'choice' || !qq.instructions?.question || !ids.length) {
      return send(422, { detail: { message: 'pedido fora do formato esperado' } });
    }
    const choice = process.env.MOCK_MODO === 'invalido' ? 'xxxxx' : ids[0];
    const probabilities = Object.fromEntries(ids.map((id, i) => [id, i === 0 ? 0.6 : +(0.4 / (ids.length - 1)).toFixed(3)]));
    send(200, {
      answers: { escolha: { type: 'choice', choice, probabilities, confidence: 0.6 } },
      usage: { input_tokens: Math.ceil(body.length / 4), output_tokens: 0 },
    });
  });
}).listen(port, '127.0.0.1', () => console.log(`mock-jev ouvindo em http://127.0.0.1:${port}`));
