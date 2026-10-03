/* Assistente do Azulejo das Palavras
 * Roda dentro da página do jogo (bookmarklet). Lê o estado guardado pelo jogo
 * (localStorage "az-cur": tamanho, variante, tentativas e cores), carrega o
 * dicionário daquele tamanho (dicionario/<n>.json, relativo à página) e mostra
 * um painel com as melhores próximas tentativas e as palavras ainda possíveis.
 * Nunca lê nem mostra a palavra secreta.
 * Atenção: este arquivo é empacotado numa linha só (empacotar.py). Use apenas
 * comentários de bloco, termine todas as instruções com ponto e vírgula e não
 * use o operador de resto (empacotar.py troca o sinal de por cento por um escape).
 */
(function(){
  if(document.getElementById('az-asst')){ document.getElementById('az-asst').remove(); return; }
  if(!document.getElementById('play')){ alert('Abra o Azulejo das Palavras antes de usar o assistente.'); return; }
  /*CORE*/
  /* Núcleo do resolvedor (igual em arena/solver.mjs, assistente/assistente.js e
   * na página do resolvedor). Sem sinal de por cento nem comentários de linha, para caber no
   * bookmarklet. A palavra secreta é sorteada com chance igual entre todas as
   * palavras do dicionário daquele tamanho, por isso não há ordem de frequência.
   *   candidatas: chaves distintas de w compatíveis com todas as tentativas
   *   sugestão:   até 2 candidatas -> elas mesmas (com entropia);
   *               até 2500 -> entropia (bits) com as candidatas como palpites e,
   *               se forem até 600, mais até 1500 sondas de fora (as chaves que
   *               melhor dividem as candidatas pelas letras);
   *               acima de 2500 -> heurística de frequência de letras.
   *   heurística: soma, para cada letra distinta da palavra, das candidatas que
   *               têm a letra, mais, para cada posição, das candidatas com a
   *               mesma letra nessa posição; mostrada dividida pelo número de
   *               candidatas (letras e posições acertadas em média).
   */
  var AZ = (function () {
    var MARKS = /[̀-ͯ]/g;
    var ENTROPY_MAX = 2500, PROBE_MAX_CANDS = 600, PROBES = 1500;
    function norm(w) { return w.replace(/ç/g, 'c').normalize('NFD').replace(MARKS, ''); }
    function score(guess, key) {
      var n = key.length, res = new Array(n), cnt = {}, i;
      for (i = 0; i < n; i++) { if (guess[i] === key[i]) res[i] = 'ok'; else { res[i] = 'off'; cnt[key[i]] = (cnt[key[i]] || 0) + 1; } }
      for (i = 0; i < n; i++) { if (res[i] !== 'ok' && cnt[guess[i]] > 0) { res[i] = 'near'; cnt[guess[i]]--; } }
      return res;
    }
    function enc(s) { var a = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i) - 97; return a; }
    var CNT = new Int16Array(26), RES = new Uint8Array(32);
    function pcode(g, k, n) {
      var i, c = 0, r;
      for (i = 0; i < n; i++) { CNT[g[i]] = 0; CNT[k[i]] = 0; }
      for (i = 0; i < n; i++) { if (g[i] === k[i]) RES[i] = 2; else { RES[i] = 0; CNT[k[i]]++; } }
      for (i = 0; i < n; i++) { r = RES[i]; if (r === 0 && CNT[g[i]] > 0) { r = 1; CNT[g[i]]--; } c = c * 3 + r; }
      return c;
    }
    function resCode(res) { var c = 0; for (var i = 0; i < res.length; i++) c = c * 3 + (res[i] === 'ok' ? 2 : res[i] === 'near' ? 1 : 0); return c; }
    function parseDict(d) {
      var n = d.n, words = d.w ? d.w.split(' ') : [], keys = [], forms = new Map(), br = new Map(), valid, i, j, k, f;
      for (i = 0; i < words.length; i++) {
        k = norm(words[i]); f = forms.get(k);
        if (!f) { forms.set(k, [words[i]]); keys.push(k); } else if (f.indexOf(words[i]) < 0) f.push(words[i]);
      }
      (d.br ? d.br.split(' ') : []).forEach(function (b) { br.set(norm(b), b); });
      valid = new Set(keys);
      (d.x ? d.x.split(' ') : []).forEach(function (x) { valid.add(x); });
      var buf = new Uint8Array(keys.length * n), codes = new Array(keys.length);
      for (i = 0; i < keys.length; i++) {
        codes[i] = buf.subarray(i * n, i * n + n);
        for (j = 0; j < n; j++) codes[i][j] = keys[i].charCodeAt(j) - 97;
      }
      return { n: n, keys: keys, forms: forms, br: br, valid: valid, codes: codes, words: words.length, buckets: null };
    }
    function displayOf(D, key, v) {
      if (v === 'br' && D.br.has(key)) return D.br.get(key);
      var f = D.forms.get(key);
      return f ? f.join(' / ') : key;
    }
    function candidates(D, guesses) {
      var n = D.n, out = [], i, j, ok;
      var gs = (guesses || []).map(function (g) { return { c: enc(g.key), t: resCode(g.res), bad: g.key.length !== n }; });
      for (i = 0; i < D.keys.length; i++) {
        ok = true;
        for (j = 0; j < gs.length; j++) if (gs[j].bad || pcode(gs[j].c, D.codes[i], n) !== gs[j].t) { ok = false; break; }
        if (ok) out.push(i);
      }
      return out;
    }
    function letterStats(D, idx) {
      var n = D.n, pos = new Int32Array(n * 26), has = new Int32Array(26), seen = new Int32Array(26), i, j, c, code;
      for (i = 0; i < idx.length; i++) {
        code = D.codes[idx[i]];
        for (j = 0; j < n; j++) { c = code[j]; pos[j * 26 + c]++; if (seen[c] !== i + 1) { seen[c] = i + 1; has[c]++; } }
      }
      return { pos: pos, has: has, N: idx.length };
    }
    var SEEN = new Float64Array(26), STAMP = 0;
    function heur(st, code, n, split) {
      var s = 0, j, c, a, N = st.N;
      STAMP++;
      for (j = 0; j < n; j++) {
        c = code[j]; a = st.pos[j * 26 + c]; s += split ? Math.min(a, N - a) : a;
        if (SEEN[c] !== STAMP) { SEEN[c] = STAMP; a = st.has[c]; s += split ? Math.min(a, N - a) : a; }
      }
      return s;
    }
    function byKey(a, b) { return a.key < b.key ? -1 : a.key > b.key ? 1 : 0; }
    function entropyRank(D, pool, idx, isCand, st, v) {
      var n = D.n, N = idx.length, B, touched = new Int32Array(N), log2N = Math.log2(N), out = [], hs = [], p, j, t, s, sq, code, g, b, k, cand;
      if (!D.buckets) D.buckets = new Int32Array(Math.pow(3, n));
      B = D.buckets;
      var cc = idx.map(function (i) { return D.codes[i]; });
      for (p = 0; p < pool.length; p++) {
        g = D.codes[pool[p]]; t = 0;
        for (j = 0; j < N; j++) { code = pcode(g, cc[j], n); if (B[code]++ === 0) touched[t++] = code; }
        s = 0; sq = 0;
        for (j = 0; j < t; j++) { b = B[touched[j]]; s += b * Math.log2(b); sq += b * b; B[touched[j]] = 0; }
        k = D.keys[pool[p]]; cand = isCand[pool[p]] === 1;
        out.push({ key: k, display: displayOf(D, k, v), bits: Math.max(0, log2N - s / N), heur: null, cand: cand, expectedRemaining: (sq - (cand ? 1 : 0)) / N });
        hs.push(heur(st, g, n, false));
      }
      var order = out.map(function (o, i) { return i; });
      order.sort(function (x, y) {
        var a = out[x], b2 = out[y], d = b2.bits - a.bits;
        return (d > 1e-9 ? 1 : d < -1e-9 ? -1 : 0) || ((b2.cand ? 1 : 0) - (a.cand ? 1 : 0)) || (hs[y] - hs[x]) || byKey(a, b2);
      });
      return order.map(function (i) { return out[i]; });
    }
    function suggest(D, guesses, v, top) {
      var n = D.n, idx = candidates(D, guesses), N = idx.length, st = letterStats(D, idx), i, ranked = [], mode;
      var cs = idx.map(function (i2) { return { key: D.keys[i2], h: heur(st, D.codes[i2], n, false) }; });
      cs.sort(function (a, b) { return b.h - a.h || byKey(a, b); });
      var cands = cs.map(function (c) { return { key: c.key, display: displayOf(D, c.key, v), heur: c.h / N }; });
      if (!N) mode = 'nenhuma';
      else if (N > ENTROPY_MAX) {
        mode = 'heuristica';
        ranked = cands.map(function (c) { return { key: c.key, display: c.display, bits: null, heur: c.heur, cand: true, expectedRemaining: null }; });
      } else {
        mode = 'entropia';
        var pool = idx.slice(), isCand = new Uint8Array(D.keys.length);
        for (i = 0; i < N; i++) isCand[idx[i]] = 1;
        if (N > 2 && N <= PROBE_MAX_CANDS) {
          var others = [], sc = new Float64Array(D.keys.length);
          for (i = 0; i < D.keys.length; i++) if (!isCand[i]) { sc[i] = heur(st, D.codes[i], n, true); if (sc[i] > 0) others.push(i); }
          others.sort(function (a, b) { return sc[b] - sc[a] || a - b; });
          pool = pool.concat(others.slice(0, PROBES));
        }
        ranked = entropyRank(D, pool, idx, isCand, st, v);
      }
      return { mode: mode, total: N, cands: cands, ranked: ranked, best: ranked.slice(0, top || 5) };
    }
    return { norm: norm, score: score, enc: enc, pcode: pcode, resCode: resCode, parseDict: parseDict, displayOf: displayOf,
      candidates: candidates, suggest: suggest, ENTROPY_MAX: ENTROPY_MAX, PROBE_MAX_CANDS: PROBE_MAX_CANDS, PROBES: PROBES };
  })();
  /*END CORE*/
  var get=function(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } };
  var fmt=function(x,d){ return x.toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d}); };
  var pctf=function(x){ return x>=10?fmt(x,0):x>=1?fmt(x,1):x.toLocaleString('pt-BR',{maximumSignificantDigits:2}); };

  var css='#az-asst{position:fixed;right:12px;bottom:12px;z-index:9999;width:min(340px,calc(100vw - 24px));max-height:min(60vh,520px);display:flex;flex-direction:column;background:var(--surface,#fff);color:var(--ink,#16223A);border:1.5px solid var(--cobalt,#1F4E9C);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.22);font:14px/1.4 var(--body,system-ui,sans-serif)}'
   +'#az-asst header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line,#C9D1E0);font:700 15px var(--display,inherit)}'
   +'#az-asst header div{display:flex;gap:6px}'
   +'#az-asst header button{border:1px solid var(--line,#C9D1E0);background:transparent;color:inherit;border-radius:7px;padding:3px 8px;cursor:pointer;font:600 12px inherit}'
   +'#az-asst .b{overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}'
   +'#az-asst h3{margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#5B6782);font-weight:600}'
   +'#az-asst ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}'
   +'#az-asst li{display:flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}'
   +'#az-asst li .w{font:700 16px var(--display,inherit);text-transform:uppercase;letter-spacing:.04em;flex:1;min-width:0;overflow-wrap:anywhere}'
   +'#az-asst li .m{color:var(--muted,#5B6782);font-size:12px;white-space:nowrap}'
   +'#az-asst li .ok{color:var(--ok,#2F8A57);font-size:11px;font-weight:600}'
   +'#az-asst .p{border:0;background:var(--cobalt,#1F4E9C);color:var(--on-color,#fff);border-radius:7px;padding:4px 10px;cursor:pointer;font:700 12px inherit}'
   +'#az-asst .p:disabled{opacity:.45;cursor:default}'
   +'#az-asst p{margin:0;color:var(--muted,#5B6782)}'
   +'#az-asst.min .b{display:none}';
  var root=document.createElement('aside'); root.id='az-asst';
  root.innerHTML='<style>'+css+'</style><header><span id="az-asst-t">Assistente</span><div><button id="az-asst-m" aria-label="Minimizar">–</button><button id="az-asst-x" aria-label="Fechar">×</button></div></header><div class="b" id="az-asst-b"></div>';
  document.body.appendChild(root);
  var timer=null;
  root.querySelector('#az-asst-x').onclick=function(){ clearInterval(timer); root.remove(); };
  root.querySelector('#az-asst-m').onclick=function(){ root.classList.toggle('min'); };

  /* digita uma palavra no jogo com os mesmos eventos de teclado que o jogo escuta;
     se a linha atual já tem letras, apaga a linha antes */
  function type(word){
    var S=get('az-cur'), n=word.length, keys=[], i;
    var cur=S&&Array.isArray(S.cur)?S.cur:[];
    if(cur.some(function(c){ return !!c; })){ for(i=0;i<n;i++) keys.push('ArrowRight'); for(i=0;i<=n;i++) keys.push('Backspace'); }
    keys=keys.concat(word.split(''),['Enter']); i=0;
    (function next(){ if(i>=keys.length) return;
      document.dispatchEvent(new KeyboardEvent('keydown',{key:keys[i++],bubbles:true,cancelable:true}));
      setTimeout(next,40); })();
  }

  /* dicionários por tamanho (promessas), relativos ao endereço do jogo */
  var dicts={}, ready={}, failed={};
  function loadDict(n){
    if(dicts[n]) return dicts[n];
    dicts[n]=fetch(new URL('dicionario/'+n+'.json',document.baseURI).href).then(function(r){
      if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); }).then(function(j){
      ready[n]=AZ.parseDict(j); delete failed[n]; return ready[n]; });
    dicts[n].catch(function(e){ delete dicts[n]; failed[n]=e.message||String(e); });
    return dicts[n];
  }

  var last='', memo={};
  function update(force){
    var S=get('az-cur'), b=root.querySelector('#az-asst-b'), t=root.querySelector('#az-asst-t');
    if(S&&S.modo==='invisivel'){ if(last!=='invisivel'){ last='invisivel'; t.textContent='Assistente · Invisível'; b.innerHTML='<p>Modo Invisível: o assistente ainda não suporta este modo.</p>'; } return; }
    var sig=S?JSON.stringify([S.v,S.len,S.guesses,S.done,!!ready[S.len]]):'none';
    if(!force&&sig===last) return; last=sig;
    if(!S||!S.secret||!S.len){ t.textContent='Assistente'; b.innerHTML='<p>Comece um jogo e o painel atualiza sozinho.</p>'; return; }
    t.textContent=S.len+' letras · '+(S.v==='br'?'Brasil':'Portugal')+(S.modo==='extremo'?' · Extremo':'');
    if(S.done){ b.innerHTML='<p>Jogo terminado. Comece a próxima palavra.</p>'; return; }
    var D=ready[S.len];
    if(!D){
      b.innerHTML=failed[S.len]?'<p>Não foi possível carregar o dicionário ('+failed[S.len]+'). Feche e abra o assistente para tentar de novo.</p>':'<p>Carregando dicionário…</p>';
      if(!failed[S.len]) loadDict(S.len).then(function(){ update(true); },function(){ update(true); });
      return;
    }
    var g=S.guesses||[], mk=sig;
    if(!memo[mk]){ b.innerHTML='<p>Calculando…</p>'; setTimeout(function(){ memo={}; memo[mk]=AZ.suggest(D,g,S.v,5); last=''; update(true); },20); return; }
    var R=memo[mk], N=R.total, html='';
    if(!N){ b.innerHTML='<p>Nenhuma palavra do dicionário encontra estas cores.</p>'; return; }
    var pct=100/N;
    html+='<h3>Melhor próxima tentativa'+(R.mode==='heuristica'?' (letras mais comuns)':'')+'</h3><ul>'+R.best.map(function(s){
      var m=s.bits!=null?fmt(s.bits,2)+' bits':'pontuação '+fmt(s.heur,2);
      return '<li><span class="w">'+s.display+'</span>'+(s.cand?'<span class="ok">pode ser a resposta</span>':'')+'<span class="m">'+m+'</span><button class="p" data-w="'+s.key+'">Jogar</button></li>'; }).join('')+'</ul>';
    html+='<h3>'+fmt(N,0)+' palavra'+(N>1?'s':'')+' possíve'+(N>1?'is':'l')+' · ~'+pctf(pct)+'% cada</h3><ul>'+R.cands.slice(0,40).map(function(c){
      return '<li><span class="w">'+c.display+'</span><button class="p" data-w="'+c.key+'">Jogar</button></li>'; }).join('')+'</ul>';
    if(N>40) html+='<p>… e mais '+fmt(N-40,0)+' (ordenadas pelas letras mais comuns; todas têm a mesma chance).</p>';
    b.innerHTML=html;
    b.querySelectorAll('.p').forEach(function(btn){ btn.onclick=function(){ type(btn.getAttribute('data-w')); }; });
  }
  update(true);
  timer=setInterval(function(){ update(false); },600);
})();
