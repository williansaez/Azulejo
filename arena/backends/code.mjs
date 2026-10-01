// Linha de base: escolhe sempre a opção com mais informação esperada
// (a primeira da lista já ordenada pelo código). Sem rede.
export function create() {
  return {
    name: 'code',
    model: 'entropia',
    async choose(ctx) { return { id: ctx.codeChoice, tokensIn: 0, tokensOut: 0 }; },
  };
}
