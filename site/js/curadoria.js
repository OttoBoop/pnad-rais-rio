// Curadoria da tela Consultar: nomes simples para as bases, as medidas e as variáveis principais.
// Tudo aqui é só apresentação: cada medida vira os mesmos parâmetros que o gerador de SQL (explorar.js) já usava,
// e cada variável aponta para uma dimensão de dimensoes.js pelo id.

export const BASES = {
  pnad_trimestral: { nome: 'PNAD Contínua trimestral', curto: 'PNAD trimestral', tipo: 'pnad',
    dica: 'Todas as pessoas, com ou sem carteira. É pesquisa por amostra: cada número é uma estimativa e vem com margem de erro. Não tem bairro.' },
  pnad_visita1: { nome: 'PNAD Contínua anual (1ª visita)', curto: 'PNAD anual, 1ª visita', tipo: 'pnad',
    dica: 'Uma fotografia por ano, com a renda de todas as fontes e os módulos anuais. Por amostra, com margem de erro. Sem 2020 e 2021.' },
  pnad_visita5: { nome: 'PNAD Contínua anual (5ª visita)', curto: 'PNAD anual, 5ª visita', tipo: 'pnad',
    dica: 'Uma fotografia por ano, com os módulos da 5ª visita. Por amostra, com margem de erro.' },
  rais_vinculos: { nome: 'RAIS Vínculos', curto: 'RAIS Vínculos', tipo: 'rais',
    dica: 'Emprego formal (carteira assinada e servidores) em estabelecimentos do Rio. É registro administrativo: contagem exata, sem margem de erro. Não vê informais nem conta-própria.' },
  rais_estab: { nome: 'RAIS Estabelecimentos', curto: 'RAIS Estabelecimentos', tipo: 'rais',
    dica: 'Empresas e órgãos que declararam a RAIS no Rio, com setor, porte e bairro. Contagem exata.' },
};

const INFORMAL = 'VD4002 = 1 AND (VD4009 IN (2, 4, 10) OR (VD4009 IN (8, 9) AND V4019 = 2))';

// est: parâmetros do gerador (medida, taxa, num, den, y, zeros). vars: variáveis que precisam existir na base.
export const MEDIDAS = {
  pnad: [
    { id: 'pessoas', nome: 'o número de pessoas', est: { medida: 'total', y: '1' }, decimais: 0 },
    { id: 'distribuicao', nome: 'a distribuição em % (quanto cada grupo representa)', est: { medida: 'proporcao' }, exigePor: true },
    { id: 'desocupacao', nome: 'a taxa de desocupação', est: { medida: 'taxa', taxa: 'desocupacao' }, vars: ['VD4001', 'VD4002'],
      nota: 'Desocupados sobre as pessoas na força de trabalho.' },
    { id: 'participacao', nome: 'a taxa de participação na força de trabalho', est: { medida: 'taxa', taxa: 'participacao' }, vars: ['VD4001', 'V2009'],
      nota: 'Pessoas na força de trabalho sobre as pessoas de 14 anos ou mais.' },
    { id: 'nivel_ocupacao', nome: 'o nível da ocupação', est: { medida: 'taxa', taxa: 'nivel_ocupacao' }, vars: ['VD4002', 'V2009'],
      nota: 'Ocupados sobre as pessoas de 14 anos ou mais.' },
    { id: 'informalidade', nome: 'a taxa de informalidade', est: { medida: 'taxa', taxa: 'personalizada', num: INFORMAL, den: 'VD4002 = 1' },
      vars: ['VD4009', 'V4019', 'VD4002'], desde: 2016,
      nota: 'Ocupados sem carteira, trabalhadores familiares auxiliares e empregadores ou conta-própria sem CNPJ, sobre o total de ocupados. Disponível de 2016 em diante (a pergunta do CNPJ começou em 2015T4).' },
    { id: 'rendimento', nome: 'o rendimento médio do trabalho', est: { medida: 'media', y: 'VD4019' }, vars: ['VD4019'],
      nota: 'Rendimento mensal habitual de todos os trabalhos, em reais do próprio período (sem corrigir pela inflação).' },
    { id: 'renda_pc', nome: 'a renda domiciliar por pessoa (média)', est: { medida: 'media', y: 'VD5008' }, vars: ['VD5008'],
      nota: 'Rendimento domiciliar per capita, em reais do próprio ano (sem corrigir pela inflação).' },
    { id: 'horas', nome: 'as horas trabalhadas por semana (média)', est: { medida: 'media', y: 'VD4031' }, vars: ['VD4031'],
      nota: 'Horas habitualmente trabalhadas por semana em todos os trabalhos.' },
  ],
  rais_vinculos: [
    { id: 'vinculos', nome: 'o número de vínculos (empregos formais)', est: { medida: 'contagem' } },
    { id: 'rem_media', nome: 'a remuneração média', est: { medida: 'media', y: 'vl_rem_media_nom', zeros: true },
      nota: 'Remuneração média mensal no ano, em reais do próprio ano. Vínculos sem remuneração informada ficam de fora.' },
    { id: 'rem_mediana', nome: 'a remuneração mediana (a do meio)', est: { medida: 'mediana', y: 'vl_rem_media_nom', zeros: true },
      nota: 'Metade dos vínculos ganha menos que este valor. Em reais do próprio ano.' },
    { id: 'massa', nome: 'a massa salarial mensal', est: { medida: 'soma', y: 'vl_rem_media_nom', zeros: true },
      nota: 'Soma das remunerações médias mensais dos vínculos, em reais do próprio ano.' },
    { id: 'idade', nome: 'a idade média', est: { medida: 'media', y: 'idade', zeros: true } },
  ],
  rais_estab: [
    { id: 'estabelecimentos', nome: 'o número de estabelecimentos', est: { medida: 'contagem' },
      nota: 'Conta todos os estabelecimentos declarados, inclusive os sem empregados (RAIS negativa).' },
    { id: 'vinculos_estab', nome: 'o total de vínculos ativos nos estabelecimentos', est: { medida: 'soma', y: 'qtd_vinculos_ativos', zeros: false } },
  ],
};

// ordinal: as categorias têm ordem própria (idade, escolaridade, porte); o gráfico não reordena pelo valor.
const PESSOA_PNAD = { grupo: 'Pessoa', itens: [
  { id: 'V2007', nome: 'Sexo' }, { id: 'V2010', nome: 'Cor ou raça' },
  { id: 'V2009@faixa', nome: 'Faixa de idade', ordinal: true }, { id: 'VD3004', nome: 'Escolaridade', ordinal: true }] };
const TRABALHO_PNAD = { grupo: 'Trabalho', itens: [
  { id: 'VD4002', nome: 'Situação: ocupado ou desocupado' }, { id: 'VD4001', nome: 'Na força de trabalho ou fora dela' },
  { id: 'VD4009', nome: 'Tipo de trabalho (com carteira, sem carteira, conta-própria…)' },
  { id: 'VD4012', nome: 'Contribui para a previdência' }, { id: 'VD4013', nome: 'Faixa de horas trabalhadas', ordinal: true }] };
const SETOR_PNAD = { grupo: 'Setor e ocupação', itens: [
  { id: 'VD4010', nome: 'Setor de atividade (grupos do IBGE)' }, { id: 'V4013@secao', nome: 'Setor de atividade (seção da CNAE)' },
  { id: 'VD4011', nome: 'Grupo de ocupação' }, { id: 'V4010@grande_grupo', nome: 'Ocupação (grandes grupos)' }] };

const SETOR_RAIS = { grupo: 'Setor', itens: [
  { id: 'cnae_2_0_subclasse@secao', nome: 'Setor (seção da CNAE)' }, { id: 'cnae_2_0_subclasse@divisao', nome: 'Setor detalhado (divisão da CNAE)' },
  { id: 'ibge_subsetor', nome: 'Subsetor do IBGE (25 grupos)' }] };

export const VARIAVEIS = {
  pnad: [PESSOA_PNAD, TRABALHO_PNAD, SETOR_PNAD],
  rais_vinculos: [
    { grupo: 'Pessoa', itens: [
      { id: 'sexo', nome: 'Sexo' }, { id: 'raca_cor', nome: 'Cor ou raça' },
      { id: 'faixa_etaria', nome: 'Faixa de idade', ordinal: true }, { id: 'escolaridade_apos_2005', nome: 'Escolaridade', ordinal: true }] },
    SETOR_RAIS,
    { grupo: 'Ocupação', itens: [
      { id: 'cbo_2002_ocupacao@grande_grupo', nome: 'Ocupação (grandes grupos)' },
      { id: 'cbo_2002_ocupacao@subgrupo_principal', nome: 'Ocupação (49 subgrupos)' },
      { id: 'cbo_2002_ocupacao@familia', nome: 'Ocupação detalhada (família da CBO)' }] },
    { grupo: 'Vínculo e empresa', itens: [
      { id: 'tipo_vinculo', nome: 'Tipo de vínculo (CLT, estatutário…)' },
      { id: 'faixa_rem_media_sm', nome: 'Faixa de remuneração (em salários mínimos)', ordinal: true },
      { id: 'tamanho_estabelecimento', nome: 'Porte do estabelecimento', ordinal: true }, { id: 'natureza_juridica', nome: 'Natureza jurídica' }] },
    { grupo: 'Lugar', itens: [{ id: 'bairros_rj', nome: 'Bairro' }] },
  ],
  rais_estab: [
    SETOR_RAIS,
    { grupo: 'Empresa', itens: [
      { id: 'tamanho_estabelecimento', nome: 'Porte do estabelecimento', ordinal: true }, { id: 'natureza_juridica', nome: 'Natureza jurídica' }] },
    { grupo: 'Lugar', itens: [{ id: 'bairro_ipp_cep', nome: 'Bairro (pelo CEP)' }, { id: 'bairros_rj', nome: 'Bairro informado na RAIS' }] },
  ],
};

export function chaveCuradoria(chave) {
  return BASES[chave] && BASES[chave].tipo === 'pnad' ? 'pnad' : chave;
}

// Exemplos que preenchem a frase. ini/fim ausentes = último período da base.
export const EXEMPLOS = [
  { titulo: 'Pessoas brancas ocupadas, por setor (PNAD)',
    estado: { base: 'pnad_trimestral', medida: 'pessoas', conds: [{ dim: 'VD4002', valores: ['1'] }, { dim: 'V2010', valores: ['1'] }], por: 'VD4010' } },
  { titulo: 'Vínculos formais de pessoas brancas, por setor (RAIS)',
    estado: { base: 'rais_vinculos', medida: 'vinculos', conds: [{ dim: 'raca_cor', valores: ['2'] }], por: 'cnae_2_0_subclasse@secao' } },
  { titulo: 'Taxa de desocupação por sexo, desde 2012',
    estado: { base: 'pnad_trimestral', medida: 'desocupacao', por: 'V2007', ini: 'primeiro' } },
  { titulo: 'Rendimento médio por cor ou raça',
    estado: { base: 'pnad_trimestral', medida: 'rendimento', por: 'V2010' } },
  { titulo: 'Remuneração média por escolaridade e sexo (RAIS)',
    estado: { base: 'rais_vinculos', medida: 'rem_media', por: 'escolaridade_apos_2005', e: 'sexo' } },
  { titulo: 'Emprego formal no Rio, 2006 a 2025',
    estado: { base: 'rais_vinculos', medida: 'vinculos', ini: 'primeiro' } },
  { titulo: 'Estabelecimentos por bairro',
    estado: { base: 'rais_estab', medida: 'estabelecimentos', por: 'bairro_ipp_cep' } },
];
