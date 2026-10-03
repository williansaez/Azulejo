// Linha de base: escolhe sempre a opção com mais informação esperada
// (a primeira da lista já ordenada pelo código: entropia ou, com mais de
// 2500 palavras possíveis, heurística de letras). Sem rede.
export function create() {
  return {
    name: 'code',
    model: 'entropia/heurística',
    livre: false,
    async choose(ctx) { return { id: ctx.codeChoice, tokensIn: 0, tokensOut: 0 }; },
    // O código só escolhe entre as opções que o solver calcula; no modo livre
    // a palavra tem de ser inventada pelo jogador, sem lista de candidatas.
    async chooseFree() {
      throw new Error('este backend não joga no modo livre: o Código só escolhe entre as opções do solver e o modo Invisível (livre) exige gerar palavras. Use o backend ollama.');
    },
  };
}
