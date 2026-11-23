"""Sobe a RAIS do Rio para o Hugging Face e escreve o manifest do site.

Uso (com o Python que tem huggingface_hub e o login do `hf`):
  /home/otavio/Documents/vscode/.venv/bin/python -I rais_subir.py subir      # Parquet + README.md
  /home/otavio/Documents/vscode/.venv/bin/python -I rais_subir.py manifest   # confere tamanhos no HF e grava o manifest
  /home/otavio/Documents/vscode/.venv/bin/python -I rais_subir.py limpar     # apaga teste/ do dataset

Dataset: https://huggingface.co/datasets/OttoBoop/pnad-rais-rio-dados
Caminhos (CONTRATO): rais/vinculos/rais_vinculos_AAAA.parquet, rais/vinculos/rais_vinculos_2023_legado.parquet,
rais/estabelecimentos/rais_estab_AAAA.parquet.
"""
import json
import sys
from datetime import date
from pathlib import Path

import pyarrow.parquet as pq
from huggingface_hub import CommitOperationAdd, HfApi

REPO = "OttoBoop/pnad-rais-rio-dados"
PROJ = Path("/home/otavio/Documents/vscode/pnad-rais-rio")
SAIDA = PROJ / "saida_rais"
MANIFEST = PROJ / "repo/site/dados/manifest_rais.json"
URL = f"https://huggingface.co/datasets/{REPO}/resolve/main/"
SITE = "https://ottoboop.github.io/pnad-rais-rio/"


def arquivos():
    out = []
    for f in sorted((SAIDA / "rais").rglob("*.parquet")):
        rel = f.relative_to(SAIDA).as_posix()
        meta = pq.ParquetFile(f).metadata
        nome = f.stem
        if nome.startswith("rais_vinculos_2023_legado"):
            tabela, ano = "rais_vinculos_2023_legado", 2023
        elif nome.startswith("rais_vinculos_"):
            tabela, ano = "rais_vinculos", int(nome[-4:])
        else:
            tabela, ano = "rais_estab", int(nome[-4:])
        out.append({"tabela": tabela, "ano": ano, "caminho": rel, "local": f, "bytes": f.stat().st_size,
                    "linhas": meta.num_rows, "colunas": meta.num_columns})
    return out


def card(arqs):
    def linhas_tab(tabela):
        return "\n".join(f"| {a['ano']} | `{a['caminho']}` | {a['linhas']:,} | {a['colunas']} | {a['bytes'] / 1e6:.1f} |"
                         .replace(",", ".") for a in arqs if a["tabela"] == tabela)
    tot_b = sum(a["bytes"] for a in arqs)
    tot_l = sum(a["linhas"] for a in arqs)
    vinc = [a["caminho"] for a in arqs if a["tabela"] == "rais_vinculos"]
    est = [a["caminho"] for a in arqs if a["tabela"] == "rais_estab"]
    leg = [a["caminho"] for a in arqs if a["tabela"] == "rais_vinculos_2023_legado"]
    yaml_lista = lambda xs: "\n".join(f"      - {x}" for x in xs)
    return f"""---
pretty_name: RAIS do município do Rio de Janeiro (2006–2025)
language:
  - pt
license: other
license_name: dados-publicos-mte
license_link: https://www.gov.br/trabalho-e-emprego/pt-br/assuntos/estatisticas-trabalho/microdados-rais-e-caged
tags:
  - rais
  - mercado-de-trabalho
  - rio-de-janeiro
  - brasil
size_categories:
  - 10M<n<100M
configs:
  - config_name: vinculos
    data_files:
{yaml_lista(vinc)}
  - config_name: vinculos_2023_legado
    data_files:
{yaml_lista(leg)}
  - config_name: estabelecimentos
    data_files:
{yaml_lista(est)}
---

# RAIS do município do Rio de Janeiro, 2006–2025

Microdados da **Relação Anual de Informações Sociais (RAIS)** restritos ao município do Rio de Janeiro, em
Parquet, para consulta direta no navegador (DuckDB-WASM com leitura parcial por HTTP Range) no laboratório
**[pnad-rais-rio]({SITE})**, da equipe técnica da Prefeitura do Rio.

## Fonte

- **Ministério do Trabalho e Emprego (MTE)**, Programa de Disseminação das Estatísticas do Trabalho (PDET):
  microdados públicos **não identificados** da RAIS, `ftp://ftp.mtps.gov.br/pdet/microdados/RAIS/`.
  Os arquivos públicos não trazem CPF, PIS, nome, CNPJ nem razão social.
- Vínculos: `RJ<ano>.7z` (2006–2017) e `RAIS_VINC_PUB_MG_ES_RJ.7z` (2018–2025); 2023 Legado em `2023/Legado/`.
- Estabelecimentos: `Estb2006.zip`, `ESTB<ano>.7z` (2007–2017) e `RAIS_ESTAB_PUB.7z` (2018–2025).
- Nada foi alterado nos valores, exceto o que está descrito em "Tratamento".

## Recorte

Só as linhas cujo **município do estabelecimento** é **330455** (Rio de Janeiro). O município de trabalho
(`municipio_trab`) quase não é preenchido a partir de 2023, por isso o recorte usa o do estabelecimento.

## Arquivos

Um arquivo por ano. Cada arquivo tem a coluna `ano` (USMALLINT). Total: {tot_l:,} linhas, {tot_b / 1e9:.2f} GB.

### Vínculos (`rais/vinculos/`)

| Ano | Arquivo | Linhas | Colunas | MB |
|---|---|---|---|---|
{linhas_tab("rais_vinculos")}

### Vínculos 2023, versão Legado (tabela à parte)

| Ano | Arquivo | Linhas | Colunas | MB |
|---|---|---|---|---|
{linhas_tab("rais_vinculos_2023_legado")}

### Estabelecimentos (`rais/estabelecimentos/`)

| Ano | Arquivo | Linhas | Colunas | MB |
|---|---|---|---|---|
{linhas_tab("rais_estab")}

## Nomes e tipos

- **Nomes canônicos**: os do leiaute eSocial (2023+) em snake_case, sem acento e sem o sufixo " - Código"
  (`ind_vinculo_ativo_31_12`, `sexo`, `cbo_2002_ocupacao`, `vl_rem_media_nom`, `tipo_estabelecimento`,
  `municipio_trab`...). Os nomes do leiaute antigo (2006–2022 e 2023 Legado) foram mapeados para esses pela
  tabela "De-Para Microdados" do MTE. O mapa está em `pipeline/rais_colunas.py` do repositório do site.
- **Tipos iguais em todos os anos**: códigos inteiros no menor tipo que comporta o mínimo e o máximo da série;
  valores (R$ e salários mínimos) e tempo de emprego em DECIMAL(18,2). Assim
  `read_parquet([...], union_by_name=true)` lê todos os anos juntos sem conflito de tipo.
- Códigos com zeros à esquerda (CBO, CNAE) estão como inteiros: use `lpad(CAST(cbo_2002_ocupacao AS VARCHAR), 6, '0')`
  e `lpad(CAST(cnae_2_0_subclasse AS VARCHAR), 7, '0')` para cruzar com as tabelas de rótulos.
- Saíram as colunas que não se aplicam ao Rio: `bairros_sp`, `bairros_fortaleza`, `distritos_sp`, `regiao_adm_df`.
- Ordenação: vínculos por `cnae_2_0_subclasse`, `cbo_2002_ocupacao`; estabelecimentos por `cnae_2_0_subclasse`.
  ZSTD nível 19, blocos (row groups) de 1.000.000 de linhas.

## Tratamento

- `{{ñ class}}`, vazio e similares viraram NULL (a contagem por coluna e ano está no dicionário).
- O código de ignorado "-1", que a fonte grava com zeros à esquerda ("0000-1"), virou -1.
- Outros códigos de "ignorado" (9997, 999997, 999999, 9 em raça etc.) ficaram como a fonte publica; o
  dicionário lista quais são.
- **Estabelecimentos: `bairro_ipp_cep`** (coluna nova) é o código do bairro IPP (malha de bairros 2023 da
  Prefeitura) atribuído pelo CEP do estabelecimento, com a tabela CEP → bairro derivada dos pontos de endereço do
  IPP. Só existe onde há CEP (2014+).

## Quebras de série (leia antes de comparar anos)

- **2023: troca para o eSocial.** A série principal de 2023 em diante vem do arquivo eSocial. O arquivo Legado de
  2023 está à parte (`rais_vinculos_2023_legado`), para medir a quebra.
- **Bairro dos vínculos só até 2021.** Em 2022 `bairros_rj` vem como 9997 ou 0; de 2023 em diante, 999997 em
  todas as linhas. Para bairro depois de 2021, use os estabelecimentos (`bairro_ipp_cep`).
- **Faixas no eSocial**: algumas faixas mudaram de codificação em 2023 (ex.: `faixa_rem_media_sm` passa a usar
  a escala da faixa de dezembro, com 1 = até 0,50 SM). O dicionário traz as categorias por período.
- Remunerações mês a mês (`vl_rem_janeiro_sc` ... `vl_rem_novembro_sc`) só existem a partir de 2015.

## Dicionário

- Variáveis, categorias (dos leiautes oficiais do MTE) e anos em que cada coluna existe e está preenchida:
  [{SITE}dados/dic/rais_vinculos.json]({SITE}dados/dic/rais_vinculos.json) e
  [{SITE}dados/dic/rais_estab.json]({SITE}dados/dic/rais_estab.json).
- Classificações: [CBO 2002]({SITE}dados/dic/cbo.json) (MTE), [CNAE 2.0]({SITE}dados/dic/cnae.json)
  (IBGE/CONCLA) e [bairros]({SITE}dados/dic/bairros_rj.json) (código RAIS e bairros IPP).

## Como ler

```sql
-- DuckDB (Python, CLI ou WASM com httpfs)
SELECT ano, sexo, count(*) AS ativos
FROM read_parquet([
  '{URL}rais/vinculos/rais_vinculos_2023.parquet',
  '{URL}rais/vinculos/rais_vinculos_2024.parquet'], union_by_name = true)
WHERE ind_vinculo_ativo_31_12 = 1
GROUP BY ALL ORDER BY ALL;
```

Site com construtor de consultas, SQL livre e metodologia: **{SITE}**

Gerado em {date.today().isoformat()} pelo pipeline `pipeline/rais.py` do repositório OttoBoop/pnad-rais-rio.
"""


def subir():
    api = HfApi()
    arqs = arquivos()
    ops = [CommitOperationAdd(path_in_repo=a["caminho"], path_or_fileobj=str(a["local"])) for a in arqs]
    readme = PROJ / "trabalho_rais" / "README_hf.md"
    readme.write_text(card(arqs))
    ops.append(CommitOperationAdd(path_in_repo="README.md", path_or_fileobj=str(readme)))
    # em lotes, para não perder tudo se a rede cair no meio
    for i in range(0, len(ops), 6):
        lote = ops[i:i + 6]
        api.create_commit(repo_id=REPO, repo_type="dataset", operations=lote,
                          commit_message=f"RAIS Rio: {', '.join(o.path_in_repo.split('/')[-1] for o in lote)}")
        print("ok", [o.path_in_repo for o in lote], flush=True)


def manifest():
    api = HfApi()
    info = api.dataset_info(REPO, files_metadata=True)
    remoto = {s.rfilename: s.size for s in info.siblings}
    arqs = arquivos()
    for a in arqs:
        if remoto.get(a["caminho"]) != a["bytes"]:
            raise SystemExit(f"{a['caminho']}: local {a['bytes']} bytes, HF {remoto.get(a['caminho'])}")
    titulos = {"rais_vinculos": "RAIS Vínculos", "rais_vinculos_2023_legado": "RAIS Vínculos 2023 (versão Legado)",
               "rais_estab": "RAIS Estabelecimentos"}
    tabelas = {}
    for t in ("rais_vinculos", "rais_vinculos_2023_legado", "rais_estab"):
        d = {"titulo": titulos[t], "fonte": "MTE/PDET, microdados públicos não identificados da RAIS", "peso": None,
             "periodo": ["ano"],
             "dicionario": "dados/dic/rais_estab.json" if t == "rais_estab" else "dados/dic/rais_vinculos.json"}
        if t == "rais_estab":
            d["chave_bairro"] = "bairro_ipp_cep"
            d["chave_bairro_codigo_rais"] = "bairros_rj"
            d["nota"] = ("bairro_ipp_cep: bairro IPP pelo CEP (2014+); bairros_rj: código de bairro da RAIS, "
                         "informado até 2021.")
        else:
            d["ativo"] = "ind_vinculo_ativo_31_12"
            d["chave_bairro"] = "bairros_rj"
            d["nota"] = ("Série principal 2023+ = eSocial; bairros_rj só é informado até 2021."
                         if t == "rais_vinculos" else
                         "Arquivo Legado de 2023 (leiaute antigo), à parte da série principal, para medir a quebra do eSocial.")
        d["arquivos"] = [{"ano": a["ano"], "url": URL + a["caminho"], "bytes": a["bytes"], "linhas": a["linhas"]}
                         for a in arqs if a["tabela"] == t]
        tabelas[t] = d
    MANIFEST.write_text(json.dumps({"gerado_em": date.today().isoformat(), "tabelas": tabelas},
                                   ensure_ascii=False, indent=1))
    print("manifest:", MANIFEST, {t: len(d["arquivos"]) for t, d in tabelas.items()})


def limpar():
    api = HfApi()
    api.delete_folder("teste", repo_id=REPO, repo_type="dataset", commit_message="Apaga arquivos de teste da medição")
    print("teste/ apagado")


if __name__ == "__main__":
    {"subir": subir, "manifest": manifest, "limpar": limpar}[sys.argv[1]]()
