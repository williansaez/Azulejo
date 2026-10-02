# Gera dicionario/<n>.json (n = 4..13) e dicionario/index.json a partir de:
#   - palavras.txt (pythonprobr/palavras, português do Brasil, com acentos)
#   - pt_PT.dic + pt_PT.aff (LibreOffice/dictionaries) expandidos com
#     examples/unmunch.py do spylls (pip install spylls)
#   - as listas antigas do jogo (valid 4-6, só sem acento), aceitas como tentativa
# Uso: python3 dicionario/gerar.py <palavras.txt> <pt_PT_words.txt> [words-antigas.json]
# Formato de cada arquivo:
#   n   tamanho
#   w   palavras sorteáveis (formas de exibição), separadas por espaço; a chave
#       de uma palavra é a forma sem acentos (ç→c) e chaves podem repetir-se
#       (pais / país são duas palavras)
#   br  grafia brasileira para as palavras de w que só mudam o acento entre as
#       variantes (fénix / fênix); a correspondência é pela chave
#   x   chaves extras aceitas como tentativa mas que nunca são sorteadas
#       (das listas antigas do jogo; não têm forma acentuada conhecida)
import sys, re, json, unicodedata, pathlib
OK = re.compile(r'^[a-záàâãéêíóôõúüç]+$')
MIN, MAX = 4, 13
def norm(w): return ''.join(c for c in unicodedata.normalize('NFD', w.replace('ç', 'c')) if not unicodedata.combining(c))
def load(fn):
    out = {}
    for w in open(fn, encoding='utf8'):
        w = w.strip()
        if OK.match(w) and MIN <= len(w) <= MAX: out.setdefault(norm(w), set()).add(w)
    return out
br, pt = load(sys.argv[1]), load(sys.argv[2])
old = json.load(open(sys.argv[3], encoding='utf8'))['valid'] if len(sys.argv) > 3 else {}
out_dir = pathlib.Path(__file__).parent
index = {'tamanhos': list(range(MIN, MAX + 1)), 'extremo': [10, MAX], 'contagem': {}, 'fontes': [
    'pythonprobr/palavras (pt-BR)', 'LibreOffice pt_PT (Hunspell, expandido com spylls)', 'listas originais do jogo (4-6 letras, só como tentativa)']}
for n in range(MIN, MAX + 1):
    keys = sorted(k for k in set(br) | set(pt) if len(k) == n)
    w, brd = [], []
    for k in keys:
        pf = sorted(pt.get(k, ())); bf = sorted(br.get(k, ()))
        if len(pf) == 1 and len(bf) == 1 and pf[0] != bf[0]:
            # mesma palavra com grafia diferente (fénix / fênix): exibe a de
            # Portugal e guarda a do Brasil como alternativa
            w.append(pf[0]); brd.append(bf[0])
        else:
            # uma ou mais palavras distintas com a mesma chave (pais / país):
            # todas entram como palavras sorteáveis
            w.extend(sorted(set(pf) | set(bf)))
    extra = sorted(set(old.get(str(n), '').split()) - set(keys)) if str(n) in old else []
    json.dump({'n': n, 'w': ' '.join(w), 'br': ' '.join(brd), 'x': ' '.join(extra)},
              open(out_dir / f'{n}.json', 'w', encoding='utf8'), ensure_ascii=False, separators=(',', ':'))
    index['contagem'][str(n)] = {'sorteaveis': len(w), 'chaves': len(keys), 'grafia_br': len(brd), 'extras': len(extra)}
    print(n, len(keys), 'br-dif', len(brd), 'extras', len(extra))
json.dump(index, open(out_dir / 'index.json', 'w', encoding='utf8'), ensure_ascii=False, indent=1)
