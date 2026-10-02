// Linha de base: escolhe sempre a opção com mais informação esperada
// (a primeira da lista já ordenada pelo código: entropia ou, com mais de
// 2500 palavras possíveis, heurística de letras). Sem rede.
export function create() {
  return {
    name: 'code',
    model: 'entropia/heurística',
    async choose(ctx) { return { id: ctx.codeChoice, tokensIn: 0, tokensOut: 0 }; },
  };
}
