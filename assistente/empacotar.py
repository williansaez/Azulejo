# Gera bookmarklet.txt a partir de assistente.js: remove comentários, junta
# tudo numa linha e troca "%" por "%" para o código funcionar tanto como
# favorito (javascript:) quanto colado no console.
import re, pathlib
p = pathlib.Path(__file__).parent
src = re.sub(r'/\*.*?\*/', '', (p / 'assistente.js').read_text(encoding='utf8'), flags=re.S)
one = ' '.join(l.strip() for l in src.split('\n') if l.strip()).replace('%', '\\u0025')
(p / 'bookmarklet.txt').write_text('javascript:' + one + '\n', encoding='utf8')
print(len(one), 'caracteres')
