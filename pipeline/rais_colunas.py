"""Mapa de colunas da RAIS (PDET/MTE): nome de cada leiaute -> nome canônico, e tipo canônico.

Nome canônico = nome do leiaute eSocial (2023+) em snake_case, sem acento e sem o sufixo
" - Código". Os nomes do leiaute antigo (2006–2022 e 2023 Legado) são mapeados para esses pela
tabela "De-Para Microdados.xlsx" do MTE (aba VINC_PUB e ESTAB_PUB), conferida nome a nome:
https://www.gov.br/trabalho-e-emprego/pt-br/acesso-a-informacao/acoes-e-programas/programas-projetos-acoes-obras-e-atividades/estatisticas-trabalho/rais/rais-2024/rais-2024-1/de-para-microdados.xlsx
(Na aba VINC_PUB do De-Para, as três faixas de remuneração/hora estão desalinhadas por posição;
aqui o casamento é pelo nome, e a ordem dos dados foi conferida: faixa_hora_contrat = 6 quando
qtd_hora_contr = 44.)

O tipo canônico de cada coluna é o mesmo em todos os anos. Para os códigos inteiros, é o menor
tipo que comporta o mínimo e o máximo observados na série 2006–2025 (medidos por
`rais.py tipos` sobre as estatísticas de cada ano). Um ano novo com valor fora do tipo faz a
conversão falhar (CAST estrito), nunca vira NULL em silêncio.
"""
import re
import unicodedata


def chave(nome: str) -> str:
    """Normaliza um nome de cabeçalho: sem acento, minúsculo, sem ' - Código', snake_case."""
    s = unicodedata.normalize("NFKD", nome).encode("ascii", "ignore").decode().lower()
    s = s.replace('"', "").replace("- codigo", "")
    return re.sub(r"[^a-z0-9]+", "_", s).strip("_")


# ---------------------------------------------------------------- Vínculos
# Ordem canônica = ordem do arquivo eSocial.
VINC_CANONICAS = [
    "bairros_sp", "bairros_fortaleza", "bairros_rj", "causa_afastamento_1", "causa_afastamento_2",
    "causa_afastamento_3", "motivo_desligamento", "cbo_2002_ocupacao", "cnae_2_0_classe", "cnae_95_classe",
    "distritos_sp", "ind_vinculo_ativo_31_12", "faixa_etaria", "faixa_rem_media_sm", "faixa_hora_contrat",
    "faixa_rem_dez_sm", "faixa_tempo_emprego", "escolaridade_apos_2005", "qtd_hora_contr", "idade",
    "ind_cei_vinculado", "ind_estabelecimento_participante_simples", "mes_admissao", "mes_desligamento",
    "municipio_trab", "municipio", "nacionalidade", "natureza_juridica", "ind_portador_defic",
    "qtd_dias_afastamento", "raca_cor", "regiao_adm_df", "vl_rem_dezembro_nom", "vl_rem_dezembro_sm",
    "vl_rem_media_nom", "vl_rem_media_sm", "cnae_2_0_subclasse", "sexo", "tamanho_estabelecimento",
    "tempo_emprego", "tipo_admissao_trabalhador", "tipo_estabelecimento", "tipo_estabelecimento_nome",
    "tipo_deficiencia", "tipo_vinculo", "ibge_subsetor",
    "vl_rem_janeiro_sc", "vl_rem_fevereiro_sc", "vl_rem_marco_sc", "vl_rem_abril_sc", "vl_rem_maio_sc",
    "vl_rem_junho_sc", "vl_rem_julho_sc", "vl_rem_agosto_sc", "vl_rem_setembro_sc", "vl_rem_outubro_sc",
    "vl_rem_novembro_sc", "ano_chegada_brasil", "ind_trabalho_intermitente", "ind_trabalho_parcial",
    "ind_vinculo_abandonado", "categoria_trabalhador",
    # Só no arquivo público de 2018 (fora do leiaute eSocial público); nomes do De-Para do MTE, aba VINC_ID:
    # "tiposalário -> tiposaláriocódigo" e "vlsaláriocontratual -> vlsaláriocontratual".
    "tipo_salario", "vl_salario_contratual",
]
# nome normalizado do leiaute antigo -> canônico (De-Para do MTE)
VINC_ALIASES = {
    "cbo_ocupacao_2002": "cbo_2002_ocupacao",
    "vinculo_ativo_31_12": "ind_vinculo_ativo_31_12",
    "faixa_remun_dezem_sm": "faixa_rem_dez_sm",
    "faixa_remun_media_sm": "faixa_rem_media_sm",
    "ind_simples": "ind_estabelecimento_participante_simples",
    "mun_trab": "municipio_trab",
    "regioes_adm_df": "regiao_adm_df",
    "vl_remun_dezembro_nom": "vl_rem_dezembro_nom",
    "vl_remun_dezembro_sm": "vl_rem_dezembro_sm",
    "vl_remun_media_nom": "vl_rem_media_nom",
    "vl_remun_media_sm": "vl_rem_media_sm",
    "sexo_trabalhador": "sexo",
    "tipo_admissao": "tipo_admissao_trabalhador",
    "tipo_estab": "tipo_estabelecimento",
    "tipo_defic": "tipo_deficiencia",
    "ind_trab_intermitente": "ind_trabalho_intermitente",
    "ind_trab_parcial": "ind_trabalho_parcial",
}
# 2015–2017: as remunerações mês a mês se chamam "Vl Rem Janeiro CC" ... "Vl Rem Novembro CC"; de 2018 em
# diante, "... SC". Os leiautes oficiais de 2016, 2017, 2018e2019 e 2020 dão a mesma descrição ("Remuneração do
# trabalhador em <mês> (valor nominal) - a partir de 2015") e o mesmo tamanho (15) às duas: é a mesma variável.
MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro",
         "novembro"]
VINC_ALIASES.update({f"vl_rem_{m}_cc": f"vl_rem_{m}_sc" for m in MESES})

# ---------------------------------------------------------------- Estabelecimentos
ESTAB_CANONICAS = [
    "bairros_sp", "bairros_fortaleza", "bairros_rj", "cnae_2_0_classe", "cnae_95_classe", "distritos_sp",
    "qtd_vinculos_clt", "qtd_vinculos_ativos", "qtd_vinculos_estatutarios", "ind_atividade_ano",
    "ind_cei_vinculado", "ind_estab_participante_pat", "ind_rais_negativa", "ind_estab_participante_simples",
    "municipio", "natureza_juridica", "regiao_adm_df", "cnae_2_0_subclasse", "tamanho_estabelecimento",
    "tipo_estabelecimento", "tipo_estabelecimento_nome", "uf", "ibge_subsetor", "cep_estab",
]
ESTAB_ALIASES = {
    "ind_estab_participa_pat": "ind_estab_participante_pat",
    "ind_simples": "ind_estab_participante_simples",
    "regioes_adm_df": "regiao_adm_df",
    "tipo_estab": "tipo_estabelecimento",
}
# Coluna derivada pelo pipeline (não existe no arquivo do MTE).
ESTAB_DERIVADAS = ["bairro_ipp_cep"]

# Quando o leiaute repete um nome (o antigo traz "Tipo Estab" duas vezes: código e nome),
# a segunda ocorrência recebe este nome.
SEGUNDA_OCORRENCIA = {"tipo_estabelecimento": "tipo_estabelecimento_nome"}

# Colunas que não se aplicam ao Rio (bairros/distritos de outras cidades): saem do Parquet.
FORA_DO_RIO = {"bairros_sp", "bairros_fortaleza", "distritos_sp", "regiao_adm_df"}

# Ordenação do Parquet (CONTRATO): vínculos por subclasse e CBO; estabelecimentos por subclasse.
ORDEM = {"vinculos": ["cnae_2_0_subclasse", "cbo_2002_ocupacao"], "estab": ["cnae_2_0_subclasse"]}

# Colunas de valor (R$, salários mínimos) e de tempo: DECIMAL(18,2) em todos os anos.
DECIMAIS = {
    "vl_rem_dezembro_nom", "vl_rem_dezembro_sm", "vl_rem_media_nom", "vl_rem_media_sm", "tempo_emprego",
    "vl_rem_janeiro_sc", "vl_rem_fevereiro_sc", "vl_rem_marco_sc", "vl_rem_abril_sc", "vl_rem_maio_sc",
    "vl_rem_junho_sc", "vl_rem_julho_sc", "vl_rem_agosto_sc", "vl_rem_setembro_sc", "vl_rem_outubro_sc",
    "vl_rem_novembro_sc", "vl_salario_contratual",
}
# Colunas de texto (o resto é código ou quantidade inteira).
TEXTOS = {"tipo_estabelecimento_nome"}

CANONICAS = {"vinculos": VINC_CANONICAS, "estab": ESTAB_CANONICAS}
ALIASES = {"vinculos": VINC_ALIASES, "estab": ESTAB_ALIASES}


def mapear(cabecalho: list[str], base: str) -> list[str]:
    """Cabeçalho original -> nomes canônicos (na mesma ordem). Nome desconhecido = erro."""
    canon, alias = set(CANONICAS[base]), ALIASES[base]
    vistos, saida = set(), []
    for bruto in cabecalho:
        k = chave(bruto)
        k = alias.get(k, k)
        if k in vistos:
            if k not in SEGUNDA_OCORRENCIA:
                raise ValueError(f"coluna repetida sem regra: {bruto!r}")
            k = SEGUNDA_OCORRENCIA[k]
        if k not in canon:
            raise ValueError(f"coluna sem nome canônico em {base}: {bruto!r} (normalizada {k!r})")
        vistos.add(k)
        saida.append(k)
    return saida


# Correções explícitas (aplicadas e conferidas em rais.py final; cada uma falha se a premissa não vale
# em 100% das linhas do ano):
#  * estab 2023+ (arquivo eSocial): a coluna "CNAE 2.0 Classe - Código" traz a subclasse (7 dígitos), igual
#    a "CNAE 2.0 Subclasse"; grava-se a classe = 5 primeiros dígitos da subclasse;
#  * estab 2023+: "CNAE 95 Classe - Código" vem com 4 dígitos (sem o dígito verificador); o código de 5 dígitos
#    é recuperado pela lista de classes CNAE 95 do leiaute (os 4 primeiros dígitos identificam a classe).
CORRECOES_ESTAB_DESDE = 2023
# No eSocial, a CNAE 95 "9999" marca classe CNAE 2.0 sem correspondente na CNAE 95 (ex.: subclasse 8130300,
# paisagismo); no leiaute antigo (2018–2022) a mesma situação vem como "00999" (= 999). Grava-se 999.
CNAE95_SEM_CORRESPONDENCIA = {9999: 999}

# ---------------------------------------------------------------- Tipos canônicos
# Gerado por `rais.py tipos` a partir das estatísticas de 2006–2025 (mínimo e máximo de cada
# coluna em toda a série) e conferido a cada conversão. Não editar à mão sem rodar a conferência.
TIPOS = {
    "vinculos": {
        "bairros_rj": "UINTEGER", "causa_afastamento_1": "USMALLINT", "causa_afastamento_2": "USMALLINT",
        "causa_afastamento_3": "USMALLINT", "motivo_desligamento": "UTINYINT", "cbo_2002_ocupacao": "INTEGER",
        "cnae_2_0_classe": "UINTEGER", "cnae_95_classe": "UINTEGER", "ind_vinculo_ativo_31_12": "UTINYINT",
        "faixa_etaria": "UTINYINT", "faixa_hora_contrat": "UTINYINT", "faixa_rem_dez_sm": "UTINYINT",
        "faixa_rem_media_sm": "UTINYINT", "faixa_tempo_emprego": "UTINYINT", "escolaridade_apos_2005": "UTINYINT",
        "qtd_hora_contr": "UTINYINT", "idade": "UTINYINT", "ind_cei_vinculado": "UTINYINT",
        "ind_estabelecimento_participante_simples": "UTINYINT", "mes_admissao": "UTINYINT", "mes_desligamento": "UTINYINT",
        "municipio_trab": "INTEGER", "municipio": "UINTEGER", "nacionalidade": "UTINYINT",
        "natureza_juridica": "USMALLINT", "qtd_dias_afastamento": "USMALLINT", "raca_cor": "UTINYINT",
        "vl_rem_dezembro_nom": "DECIMAL(18,2)", "vl_rem_dezembro_sm": "DECIMAL(18,2)", "vl_rem_media_nom": "DECIMAL(18,2)",
        "vl_rem_media_sm": "DECIMAL(18,2)", "cnae_2_0_subclasse": "INTEGER", "sexo": "UTINYINT",
        "tamanho_estabelecimento": "UTINYINT", "tempo_emprego": "DECIMAL(18,2)", "tipo_admissao_trabalhador": "UTINYINT",
        "tipo_estabelecimento": "UTINYINT", "tipo_estabelecimento_nome": "VARCHAR", "tipo_vinculo": "UTINYINT",
        "ind_portador_defic": "UTINYINT", "tipo_deficiencia": "UTINYINT", "ibge_subsetor": "UTINYINT",
        "vl_rem_janeiro_sc": "DECIMAL(18,2)", "vl_rem_fevereiro_sc": "DECIMAL(18,2)", "vl_rem_marco_sc": "DECIMAL(18,2)",
        "vl_rem_abril_sc": "DECIMAL(18,2)", "vl_rem_maio_sc": "DECIMAL(18,2)", "vl_rem_junho_sc": "DECIMAL(18,2)",
        "vl_rem_julho_sc": "DECIMAL(18,2)", "vl_rem_agosto_sc": "DECIMAL(18,2)", "vl_rem_setembro_sc": "DECIMAL(18,2)",
        "vl_rem_outubro_sc": "DECIMAL(18,2)", "vl_rem_novembro_sc": "DECIMAL(18,2)", "ano_chegada_brasil": "USMALLINT",
        "ind_trabalho_parcial": "UTINYINT", "ind_trabalho_intermitente": "UTINYINT", "tipo_salario": "UTINYINT",
        "vl_salario_contratual": "DECIMAL(18,2)", "ind_vinculo_abandonado": "UTINYINT", "categoria_trabalhador": "USMALLINT",
    },
    "estab": {
        "bairros_rj": "UINTEGER", "cnae_2_0_classe": "INTEGER", "cnae_95_classe": "UINTEGER",
        "qtd_vinculos_clt": "UINTEGER", "qtd_vinculos_ativos": "UINTEGER", "qtd_vinculos_estatutarios": "UINTEGER",
        "ind_atividade_ano": "UTINYINT", "ind_cei_vinculado": "UTINYINT", "ind_estab_participante_pat": "UTINYINT",
        "ind_rais_negativa": "UTINYINT", "ind_estab_participante_simples": "UTINYINT", "municipio": "UINTEGER",
        "natureza_juridica": "USMALLINT", "cnae_2_0_subclasse": "INTEGER", "tamanho_estabelecimento": "UTINYINT",
        "tipo_estabelecimento": "UTINYINT", "tipo_estabelecimento_nome": "VARCHAR", "uf": "UTINYINT",
        "ibge_subsetor": "UTINYINT", "cep_estab": "UINTEGER", "bairro_ipp_cep": "USMALLINT",
    },
}
