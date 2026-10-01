/* Assistente do Azulejo das Palavras
 * Roda dentro da página do jogo (bookmarklet). Lê o estado guardado pelo jogo
 * (localStorage "az-cur": tentativas e cores) e a lista de palavras embutida
 * na página, e mostra um painel com as palavras ainda possíveis, ordenadas por
 * frequência, e a melhor próxima tentativa (maior informação esperada).
 * Nunca lê nem mostra a palavra secreta.
 */
(function(){
  if(document.getElementById('az-asst')){ document.getElementById('az-asst').remove(); return; }
  var wordsEl=document.getElementById('words');
  if(!wordsEl){ alert('Abra o Azulejo das Palavras antes de usar o assistente.'); return; }
  var W=JSON.parse(wordsEl.textContent);
  var norm=function(w){ return w.replace(/ç/g,'c').normalize('NFD').replace(/[̀-ͯ]/g,''); };
  var get=function(k){ try{ return JSON.parse(localStorage.getItem(k)); }catch(e){ return null; } };
  function score(g,k){ var n=k.length,res=new Array(n),cnt={},i;
    for(i=0;i<n;i++){ if(g[i]===k[i]) res[i]='ok'; else { res[i]='off'; cnt[k[i]]=(cnt[k[i]]||0)+1; } }
    for(i=0;i<n;i++){ if(res[i]!=='ok'&&cnt[g[i]]>0){ res[i]='near'; cnt[g[i]]--; } }
    return res.join(','); }
  var disp=function(v,k){ return (W.disp.common[k]||W.disp[v][k]||k); };

  var css='#az-asst{position:fixed;right:12px;bottom:12px;z-index:9999;width:min(340px,calc(100vw - 24px));max-height:min(60vh,520px);display:flex;flex-direction:column;background:var(--surface,#fff);color:var(--ink,#16223A);border:1.5px solid var(--cobalt,#1F4E9C);border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.22);font:14px/1.4 var(--body,system-ui,sans-serif)}'
   +'#az-asst header{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 12px;border-bottom:1px solid var(--line,#C9D1E0);font:700 15px var(--display,inherit)}'
   +'#az-asst header div{display:flex;gap:6px}'
   +'#az-asst header button{border:1px solid var(--line,#C9D1E0);background:transparent;color:inherit;border-radius:7px;padding:3px 8px;cursor:pointer;font:600 12px inherit}'
   +'#az-asst .b{overflow:auto;padding:10px 12px;display:flex;flex-direction:column;gap:10px}'
   +'#az-asst h3{margin:0;font-size:11px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted,#5B6782);font-weight:600}'
   +'#az-asst ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:4px}'
   +'#az-asst li{display:flex;align-items:center;gap:8px;font-variant-numeric:tabular-nums}'
   +'#az-asst li .w{font:700 16px var(--display,inherit);text-transform:uppercase;letter-spacing:.04em;flex:1;min-width:0}'
   +'#az-asst li .m{color:var(--muted,#5B6782);font-size:12px}'
   +'#az-asst li .ok{color:var(--ok,#2F8A57);font-size:11px;font-weight:600}'
   +'#az-asst .p{border:0;background:var(--cobalt,#1F4E9C);color:var(--on-color,#fff);border-radius:7px;padding:4px 10px;cursor:pointer;font:700 12px inherit}'
   +'#az-asst .p:disabled{opacity:.45;cursor:default}'
   +'#az-asst p{margin:0;color:var(--muted,#5B6782)}'
   +'#az-asst.min .b{display:none}';
  var root=document.createElement('aside'); root.id='az-asst';
  root.innerHTML='<style>'+css+'</style><header><span id="az-asst-t">Assistente</span><div><button id="az-asst-m" aria-label="Minimizar">–</button><button id="az-asst-x" aria-label="Fechar">×</button></div></header><div class="b" id="az-asst-b"></div>';
  document.body.appendChild(root);
  root.querySelector('#az-asst-x').onclick=function(){ clearInterval(timer); root.remove(); };
  root.querySelector('#az-asst-m').onclick=function(){ root.classList.toggle('min'); };

  /* digita uma palavra no jogo usando os mesmos eventos de teclado que o jogo escuta */
  function type(word){
    var chars=word.split('').concat(['Enter']), i=0;
    (function next(){ if(i>=chars.length) return;
      document.dispatchEvent(new KeyboardEvent('keydown',{key:chars[i++],bubbles:true}));
      setTimeout(next,70); })();
  }

  var cache={};
  function opener(v,len,list){
    var key=v+len; if(cache[key]) return cache[key];
    return cache[key]=best(list,list.map(function(x){return x.k;}),2);
  }
  /* melhor próxima tentativa: entropia da partição dos candidatos por padrão */
  function best(cands,pool,top){
    var out=[],isC={}; cands.forEach(function(c){ isC[c.k]=c; });
    for(var p=0;p<pool.length;p++){ var g=pool[p],h={},tot=cands.length,H=0;
      for(var c=0;c<tot;c++){ var s=score(g,cands[c].k); h[s]=(h[s]||0)+1; }
      for(var s2 in h){ var q=h[s2]/tot; H-=q*Math.log2(q); }
      out.push({k:g,H:H,c:!!isC[g]}); }
    out.sort(function(a,b){ return b.H-a.H||(b.c?1:0)-(a.c?1:0); });
    return out.slice(0,top);
  }

  var last='';
  function update(force){
    var S=get('az-cur'); var b=root.querySelector('#az-asst-b'), t=root.querySelector('#az-asst-t');
    var sig=S?JSON.stringify([S.v,S.len,S.guesses,S.done]):'none';
    if(!force&&sig===last) return; last=sig;
    if(!S||!S.secret){ t.textContent='Assistente'; b.innerHTML='<p>Comece um jogo e o painel atualiza sozinho.</p>'; return; }
    var list=W.secret[S.v][S.len].split(' '), seen={}, items=[];
    list.forEach(function(w,i){ var k=norm(w); if(seen[k]){ seen[k].w+=' / '+w; return; } var o={w:w,k:k,i:i}; seen[k]=o; items.push(o); });
    var g=S.guesses||[];
    var cands=items.filter(function(o){ return g.every(function(x){ return score(x.key,o.k)===x.res.join(','); }); });
    t.textContent=S.len+' letras · '+(S.v==='pt'?'Portugal':'Brasil');
    if(S.done){ b.innerHTML='<p>Jogo terminado. Comece a próxima palavra.</p>'; return; }
    var html='';
    if(!cands.length){ html+='<p>Nenhuma palavra da lista do jogo encontra estas cores. A resposta pode não estar na lista.</p>'; b.innerHTML=html; return; }
    var pct=(100/cands.length);
    var sug = g.length===0 ? opener(S.v,S.len,items) : (cands.length<=2 ? cands.map(function(c){return {k:c.k,H:0,c:true};}) : best(cands,items.map(function(x){return x.k;}),3));
    html+='<h3>Melhor próxima tentativa</h3><ul>'+sug.map(function(s){
      return '<li><span class="w">'+disp(S.v,s.k)+'</span>'+(s.c?'<span class="ok">pode ser a resposta</span>':'')+(s.H?'<span class="m">'+s.H.toFixed(2)+' bits</span>':'')+'<button class="p" data-w="'+s.k+'">Jogar</button></li>'; }).join('')+'</ul>';
    html+='<h3>'+cands.length+' palavra'+(cands.length>1?'s':'')+' possíve'+(cands.length>1?'is':'l')+' · ~'+pct.toFixed(pct<10?1:0)+'% cada</h3><ul>'+cands.slice(0,40).map(function(c){
      return '<li><span class="m">#'+(c.i+1)+'</span><span class="w">'+c.w+'</span><button class="p" data-w="'+c.k+'">Jogar</button></li>'; }).join('')+'</ul>';
    if(cands.length>40) html+='<p>… e mais '+(cands.length-40)+' menos comuns.</p>';
    b.innerHTML=html;
    b.querySelectorAll('.p').forEach(function(btn){ btn.onclick=function(){ type(btn.getAttribute('data-w')); }; });
  }
  update(true);
  var timer=setInterval(function(){ update(false); },600);
})();
