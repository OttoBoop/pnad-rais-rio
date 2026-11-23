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

// Variáveis que só existem para quem está ocupado: não servem para separar ou filtrar taxas cujo numerador
// ou denominador inclui quem não está ocupado (o resultado seria 0% ou 100% em tudo).
const SO_OCUPADOS = ['VD4010', 'V4013@secao', 'V4013', 'V4013@divisao', 'V4013@grupamento', 'VD4011', 'V4010', 'V4010@grande_grupo',
  'V4010@subgrupo_principal', 'V4010@subgrupo', 'VD4009', 'VD4012', 'VD4013', 'V4012', 'V4019', 'V4029', 'V4032'];
const SEM_SENTIDO_TAXA = Object.fromEntries([...SO_OCUPADOS.map(v => [v, 'só existe para quem está ocupado']),
  ['VD4002', 'já faz parte da própria taxa'], ['VD4001', 'já faz parte da própria taxa']]);

const INFORMAL = 'VD4002 = 1 AND (VD4009 IN (2, 4, 10) OR (VD4009 IN (8, 9) AND V4019 = 2))';

// est: parâmetros do gerador (medida, taxa, num, den, y, zeros). vars: variáveis que precisam existir na base.
export const MEDIDAS = {
  pnad: [
    { id: 'pessoas', unidade: 'pessoas', nome: 'o número de pessoas', est: { medida: 'total', y: '1' }, decimais: 0 },
    { id: 'distribuicao', unidade: '%', nome: 'a distribuição em % (quanto cada grupo representa)', est: { medida: 'proporcao' }, exigePor: true },
    { id: 'desocupacao', semSentido: SEM_SENTIDO_TAXA, unidade: '%', nome: 'a taxa de desocupação', est: { medida: 'taxa', taxa: 'desocupacao' }, vars: ['VD4001', 'VD4002'],
      nota: 'Desocupados sobre as pessoas na força de trabalho.' },
    { id: 'participacao', semSentido: SEM_SENTIDO_TAXA, unidade: '%', nome: 'a taxa de participação na força de trabalho', est: { medida: 'taxa', taxa: 'participacao' }, vars: ['VD4001', 'V2009'],
      nota: 'Pessoas na força de trabalho sobre as pessoas de 14 anos ou mais.' },
    { id: 'nivel_ocupacao', semSentido: SEM_SENTIDO_TAXA, unidade: '%', nome: 'o nível da ocupação', est: { medida: 'taxa', taxa: 'nivel_ocupacao' }, vars: ['VD4002', 'V2009'],
      nota: 'Ocupados sobre as pessoas de 14 anos ou mais.' },
    { id: 'informalidade', unidade: '%', semSentido: { VD4002: 'a taxa já é só de ocupados', VD4001: 'a taxa já é só de ocupados', VD4009: 'já faz parte da própria taxa', V4019: 'já faz parte da própria taxa' }, nome: 'a taxa de informalidade', est: { medida: 'taxa', taxa: 'personalizada', num: INFORMAL, den: 'VD4002 = 1' },
      vars: ['VD4009', 'V4019', 'VD4002'], desde: 2016,
      nota: 'Ocupados sem carteira, trabalhadores familiares auxiliares e empregadores ou conta-própria sem CNPJ, sobre o total de ocupados. Disponível de 2016 em diante (a pergunta do CNPJ começou em 2015T4).' },
    { id: 'rendimento', unidade: 'R$ por mês', nome: 'o rendimento médio do trabalho', est: { medida: 'media', y: 'VD4019' }, vars: ['VD4019'],
      nota: 'Rendimento mensal habitual de todos os trabalhos, em reais do próprio período (sem corrigir pela inflação).' },
    { id: 'renda_pc', unidade: 'R$ por mês', nome: 'a renda domiciliar por pessoa (média)', est: { medida: 'media', y: 'VD5008' }, vars: ['VD5008'],
      nota: 'Rendimento domiciliar per capita, em reais do próprio ano (sem corrigir pela inflação).' },
    { id: 'horas', unidade: 'horas por semana', nome: 'as horas trabalhadas por semana (média)', est: { medida: 'media', y: 'VD4031' }, vars: ['VD4031'],
      nota: 'Horas habitualmente trabalhadas por semana em todos os trabalhos.' },
  ],
  rais_vinculos: [
    { id: 'vinculos', unidade: 'vínculos', nome: 'o número de vínculos (empregos formais)', est: { medida: 'contagem' } },
    { id: 'rem_media', unidade: 'R$ por mês', nome: 'a remuneração média', est: { medida: 'media', y: 'vl_rem_media_nom', zeros: true },
      nota: 'Remuneração média mensal no ano, em reais do próprio ano. Vínculos sem remuneração informada ficam de fora.' },
    { id: 'rem_mediana', unidade: 'R$ por mês', nome: 'a remuneração mediana (a do meio)', est: { medida: 'mediana', y: 'vl_rem_media_nom', zeros: true },
      nota: 'Metade dos vínculos ganha menos que este valor. Em reais do próprio ano.' },
    { id: 'massa', unidade: 'R$ por mês', nome: 'a massa salarial mensal', est: { medida: 'soma', y: 'vl_rem_media_nom', zeros: true },
      nota: 'Soma das remunerações médias mensais dos vínculos, em reais do próprio ano.' },
    { id: 'idade', unidade: 'anos', nome: 'a idade média', est: { medida: 'media', y: 'idade', zeros: true } },
  ],
  rais_estab: [
    { id: 'estabelecimentos', unidade: 'estabelecimentos', nome: 'o número de estabelecimentos', est: { medida: 'contagem' },
      nota: 'Conta todos os estabelecimentos declarados, inclusive os sem empregados (RAIS negativa).' },
    { id: 'vinculos_estab', unidade: 'vínculos', nome: 'o total de vínculos ativos nos estabelecimentos', est: { medida: 'soma', y: 'qtd_vinculos_ativos', zeros: false } },
  ],
};

// ordinal: as categorias têm ordem própria (idade, escolaridade, porte); o gráfico não reordena pelo valor.
const PESSOA_PNAD = { grupo: 'Pessoa', itens: [
  { id: 'V2007', nome: 'Sexo', conceito: 'sexo' }, { id: 'V2010', nome: 'Cor ou raça', conceito: 'cor' },
  { id: 'V2009@faixa', nome: 'Faixa de idade', ordinal: true, conceito: 'idade' }, { id: 'VD3004', nome: 'Escolaridade', ordinal: true, conceito: 'escolaridade' }] };
const TRABALHO_PNAD = { grupo: 'Trabalho', itens: [
  { id: 'VD4002', nome: 'Situação: ocupado ou desocupado' }, { id: 'VD4001', nome: 'Na força de trabalho ou fora dela' },
  { id: 'VD4009', nome: 'Tipo de trabalho (com carteira, sem carteira, conta-própria…)' },
  { id: 'VD4012', nome: 'Contribui para a previdência' }, { id: 'VD4013', nome: 'Faixa de horas trabalhadas', ordinal: true }] };
const SETOR_PNAD = { grupo: 'Setor e ocupação', itens: [
  { id: 'VD4010', nome: 'Setor de atividade (grupos do IBGE)' }, { id: 'V4013@secao', nome: 'Setor de atividade (seção da CNAE)', conceito: 'setor' },
  { id: 'VD4011', nome: 'Grupo de ocupação' }, { id: 'V4010@grande_grupo', nome: 'Ocupação (grandes grupos)', conceito: 'ocupacao' }] };

const SETOR_RAIS = { grupo: 'Setor', itens: [
  { id: 'cnae_2_0_subclasse@secao', nome: 'Setor (seção da CNAE)', conceito: 'setor' }, { id: 'cnae_2_0_subclasse@divisao', nome: 'Setor detalhado (divisão da CNAE)' },
  { id: 'ibge_subsetor', nome: 'Subsetor do IBGE (25 grupos)' }] };

export const VARIAVEIS = {
  pnad: [PESSOA_PNAD, TRABALHO_PNAD, SETOR_PNAD],
  rais_vinculos: [
    { grupo: 'Pessoa', itens: [
      { id: 'sexo', nome: 'Sexo', conceito: 'sexo' }, { id: 'raca_cor', nome: 'Cor ou raça', conceito: 'cor' },
      { id: 'faixa_etaria', nome: 'Faixa de idade', ordinal: true, conceito: 'idade' }, { id: 'escolaridade_apos_2005', nome: 'Escolaridade', ordinal: true, conceito: 'escolaridade' }] },
    SETOR_RAIS,
    { grupo: 'Ocupação', itens: [
      { id: 'cbo_2002_ocupacao@grande_grupo', nome: 'Ocupação (grandes grupos)', conceito: 'ocupacao' },
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
    { grupo: 'Lugar', itens: [{ id: 'bairro_ipp_cep', nome: 'Bairro (pelo CEP)', vazio: 'Bairro não identificado (CEP sem correspondência)' }, { id: 'bairros_rj', nome: 'Bairro informado na RAIS' }] },
  ],
};

// Nomes por extenso das categorias que a RAIS traz abreviadas (pelo nome da variável; vale para as duas bases da RAIS).
export const ROTULOS = {
  escolaridade_apos_2005: { '-1': 'Ignorado', 1: 'Analfabeto', 2: 'Até o 5º ano incompleto', 3: '5º ano completo', 4: '6º ao 9º ano incompleto',
    5: 'Fundamental completo', 6: 'Médio incompleto', 7: 'Médio completo', 8: 'Superior incompleto', 9: 'Superior completo', 10: 'Mestrado', 11: 'Doutorado' },
  raca_cor: { '-1': 'Ignorado', 1: 'Indígena', 2: 'Branca', 4: 'Preta', 6: 'Amarela', 8: 'Parda', 9: 'Não identificada' },
  sexo: { '-1': 'Ignorado', 1: 'Masculino', 2: 'Feminino' },
  tamanho_estabelecimento: { '-1': 'Ignorado', 1: 'Nenhum empregado', 2: 'Até 4 empregados', 3: 'De 5 a 9', 4: 'De 10 a 19', 5: 'De 20 a 49', 6: 'De 50 a 99',
    7: 'De 100 a 249', 8: 'De 250 a 499', 9: 'De 500 a 999', 10: '1.000 ou mais' },
  faixa_etaria: { 1: '10 a 14 anos', 2: '15 a 17 anos', 3: '18 a 24 anos', 4: '25 a 29 anos', 5: '30 a 39 anos', 6: '40 a 49 anos', 7: '50 a 64 anos', 8: '65 anos ou mais' },
  tipo_vinculo: { '-1': 'Ignorado', 10: 'CLT urbano, empresa, prazo indeterminado', 15: 'CLT urbano, pessoa física, prazo indeterminado',
    20: 'CLT rural, empresa, prazo indeterminado', 25: 'CLT rural, pessoa física, prazo indeterminado', 30: 'Estatutário', 31: 'Estatutário no RGPS (INSS)',
    35: 'Estatutário não efetivo', 40: 'Avulso', 50: 'Temporário', 55: 'Aprendiz', 60: 'CLT urbano, empresa, prazo determinado',
    65: 'CLT urbano, pessoa física, prazo determinado', 70: 'CLT rural, empresa, prazo determinado', 75: 'CLT rural, pessoa física, prazo determinado',
    80: 'Diretor', 90: 'Contrato por prazo determinado', 95: 'Contrato por tempo determinado', 96: 'Contrato por lei estadual', 97: 'Contrato por lei municipal' },
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
