# pnad-rais-rio

Consulta aos microdados da PNAD Contínua (IBGE) e da RAIS (Ministério do Trabalho) do município do Rio de Janeiro, direto no navegador. Feito para quem trabalha com dados de emprego e renda da cidade: economistas, pesquisadores e equipes técnicas.

**Site:** https://ottoboop.github.io/pnad-rais-rio/

## O que dá para fazer

- Montar a pergunta em menus (o quê, de quem, em quais anos) e ver o resultado em tabela e em gráfico, com a margem de erro à vista.
- Baixar o resultado em CSV e o gráfico em PNG.
- Para quem quiser, escrever a consulta em SQL, ver o SQL de cada resultado e consultar o dicionário de variáveis.

## Dados cobertos

Todos cortados para o município do Rio de Janeiro.

- **RAIS, vínculos e estabelecimentos:** 2006 a 2025.
- **PNAD Contínua, trimestral:** 2012T1 a 2026T3.
- **PNAD Contínua, visitas anuais:** visita 1 (2012 a 2019 e 2022 a 2025; o IBGE não divulgou 2020 e 2021) e visita 5 (2016 a 2025).

Limitação da fonte: a partir de 2022 a RAIS deixa de informar o bairro dos vínculos.

## Como funciona

Os dados ficam em arquivos Parquet, que o DuckDB lê aos pedaços dentro do próprio navegador. Não há servidor: cada consulta baixa só as colunas e os blocos de que precisa, e o site mostra quantos MB foram baixados.

## Como os números foram conferidos

- **PNAD:** as estimativas e os coeficientes de variação foram comparados com o SIDRA (IBGE) para o Rio (62 de 62 trimestres e 12 de 12 anuais).
- **RAIS:** as contagens de vínculos de 2010 a 2017 batem com resumos de referência já auditados, e os ativos em 31/12 de 2016 e de 2021 batem com os números publicados.

Fontes: [PNAD Contínua](https://www.ibge.gov.br/estatisticas/sociais/trabalho/9171-pesquisa-nacional-por-amostra-de-domicilios-continua-mensal.html) (IBGE) e [RAIS](https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/estatisticas-trabalho/rais) (Ministério do Trabalho e Emprego).
