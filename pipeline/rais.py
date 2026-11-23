"""RAIS (PDET/MTE) do município do Rio (330455) -> Parquet com nomes e tipos canônicos.

Sempre com `python -I` (os .7z baixados são dados não confiáveis). Um ano por vez.

Etapas
  extrair BASE ROTULO ARQUIVO_7Z
      BASE = vinculos | estab; ROTULO = ano (ex.: 2007) ou 2023_legado.
      Lê o .7z em fluxo (bsdtar -xOf), guarda só as linhas cujo município do estabelecimento é
      330455, troca o cabeçalho pelos nomes canônicos (rais_colunas.mapear), mede cada coluna
      numa passada (vazios, "{ñ class}", inteiros, decimais, outros, mínimo e máximo) e grava um
      Parquet de trabalho com tudo em texto já limpo. Apaga o CSV temporário depois de conferir
      que o Parquet tem as mesmas linhas.
  tipos
      Junta as estatísticas de todos os anos e imprime o dicionário TIPOS (menor tipo inteiro que
      comporta mínimo e máximo da série) para colar em rais_colunas.py.
  final BASE ROTULO
      Aplica TIPOS com CAST estrito (valor que não cabe = erro), põe a coluna `ano`, tira as
      colunas que não se aplicam ao Rio, ordena (CONTRATO) e grava ZSTD 19 com blocos de
      1.000.000 de linhas. Estabelecimentos ganham `bairro_ipp_cep` (CEP -> bairro IPP).
      Confere linhas e não nulos contra o Parquet de trabalho.

Limpeza (regra do leiaute oficial: "-1", com ou sem zeros à esquerda, "{ñ class}", "{ñclass}"
ou parte do texto = ignorado):
  * vazio e qualquer valor que comece com "{" ou contenha "ñ" -> NULL (contados por coluna e ano);
  * "0000-1" -> -1 (o código de ignorado fica como está, só sem os zeros);
  * vírgula decimal -> ponto; separador de milhar ("1.000,00", só em vl_salario_contratual de 2018) sai.
"""
import hashlib
import json
import subprocess
import sys
import time
from pathlib import Path

import duckdb
import pyarrow.parquet as pq

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rais_colunas as RC  # noqa: E402

PROJ = Path("/home/otavio/Documents/vscode/pnad-rais-rio")
TRAB = PROJ / "trabalho_rais"
STAGE = TRAB / "stage"
STATS = TRAB / "stats"
SAIDA = PROJ / "saida_rais"
DESTINO = {"vinculos": SAIDA / "rais" / "vinculos", "estab": SAIDA / "rais" / "estabelecimentos"}
PREFIXO = {"vinculos": "rais_vinculos", "estab": "rais_estab"}
CEP_IPP = Path("/home/otavio/Documents/vscode/generic-nb-lm-agentic-search/cases/mcmv-estudo-unificado/"
               "quebra_faixas/fontes/enderecos/derivado_cep_bairro_ipp.csv")
LAYOUT_CNAE95 = PROJ / "fontes_rais/layouts/RAIS_vinculos_layout2020.xls"
MUN = b"330455"

INTEIROS = [("UTINYINT", 0, 255), ("USMALLINT", 0, 65535), ("UINTEGER", 0, 2**32 - 1),
            ("UBIGINT", 0, 2**64 - 1)]
INTEIROS_SINAL = [("TINYINT", -128, 127), ("SMALLINT", -32768, 32767), ("INTEGER", -(2**31), 2**31 - 1),
                  ("BIGINT", -(2**63), 2**63 - 1)]


def conectar():
    con = duckdb.connect()
    (TRAB / "_duck_tmp").mkdir(parents=True, exist_ok=True)
    con.execute("set memory_limit='3GB'; set threads=4; set preserve_insertion_order=false")
    con.execute(f"set temp_directory='{TRAB / '_duck_tmp'}'")
    return con


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for b in iter(lambda: f.read(1 << 22), b""):
            h.update(b)
    return h.hexdigest()


def nome_arquivo(base: str, rotulo: str) -> str:
    return f"{PREFIXO[base]}_{rotulo}.parquet"


# ------------------------------------------------------------------ etapa 1
def extrair_csv(arquivo: Path, tmp_csv: Path, base: str):
    proc = subprocess.Popen(["bsdtar", "-xOf", str(arquivo)], stdout=subprocess.PIPE)
    texto = proc.stdout.readline().decode("latin-1").rstrip("\r\n")
    sep = ";" if texto.count(";") > texto.count(",") else ","
    cab = [c.strip().strip('"') for c in texto.split(sep)]
    nomes = RC.mapear(cab, base)
    i_mun = nomes.index("municipio")
    sepb = sep.encode()
    lidas = mantidas = malformadas = 0
    with open(tmp_csv, "wb") as out:
        out.write(sep.join(nomes).encode() + b"\n")
        for linha in proc.stdout:
            lidas += 1
            if MUN not in linha:
                continue
            campos = linha.rstrip(b"\r\n").split(sepb)
            if len(campos) != len(nomes):
                malformadas += 1  # tem 330455 em algum campo, mas não dá para dividir: conta e reporta
                continue
            if campos[i_mun].strip().strip(b'"').strip()[:6] != MUN:
                continue
            mantidas += 1
            out.write(linha.rstrip(b"\r\n") + b"\n")
    rc = proc.wait()
    if rc != 0:
        raise RuntimeError(f"bsdtar terminou com código {rc} em {arquivo}")
    return sep, cab, nomes, lidas, mantidas, malformadas


def limpo(c: str) -> str:
    v = f'trim("{c}")'
    if c in RC.TEXTOS:
        return f"nullif({v}, '')"
    return (f"CASE WHEN {v} IS NULL OR {v} = '' OR {v} LIKE '{{%' OR {v} LIKE '%ñ%' THEN NULL "
            f"WHEN regexp_full_match({v}, '0+-[0-9]+') THEN regexp_replace({v}, '^0+-', '-') "
            f"WHEN regexp_full_match({v}, '-?[0-9]*,[0-9]+') THEN replace({v}, ',', '.') "
            f"WHEN regexp_full_match({v}, '-?[0-9]{{1,3}}([.][0-9]{{3}})+,[0-9]+') "
            f"THEN replace(replace({v}, '.', ''), ',', '.') "
            f"ELSE {v} END")


def estatisticas(con, nomes):
    # uma view com o valor bruto (aparado) e o limpo de cada coluna, avaliados uma vez por linha
    cols = ", ".join(f'trim("{c}") as r{i}, {limpo(c)} as w{i}' for i, c in enumerate(nomes))
    con.execute(f"create or replace view dupla as select {cols} from raw")
    partes = []
    for i, c in enumerate(nomes):
        v, w = f"r{i}", f"w{i}"
        partes += [
            f"count(*) filter (where {v} is null or {v} = '') as vz{i}",
            f"count(*) filter (where {v} like '{{%' or {v} like '%ñ%') as nc{i}",
            f"count(*) filter (where regexp_full_match({w}, '-?[0-9]+')) as it{i}",
            f"count(*) filter (where regexp_full_match({w}, '-?[0-9]*[.][0-9]+')) as dc{i}",
            f"min(try_cast({w} as BIGINT)) as lo{i}",
            f"max(try_cast({w} as BIGINT)) as hi{i}",
            f"max(length(split_part({w}, '.', 2))) filter (where regexp_full_match({w}, '-?[0-9]*[.][0-9]+')) as md{i}",
            f"min({w}) filter (where not regexp_full_match({w}, '-?[0-9]*([.][0-9]+)?')) as ox{i}",
            f"max({w}) filter (where not regexp_full_match({w}, '-?[0-9]*([.][0-9]+)?')) as oy{i}",
            f"approx_count_distinct({w}) as nd{i}",
        ]
    r = con.execute(f"select count(*), {', '.join(partes)} from dupla").fetchone()
    total, r = r[0], r[1:]
    out = {}
    for i, c in enumerate(nomes):
        vz, nc, it, dc, lo, hi, md, ox, oy, nd = r[10 * i:10 * i + 10]
        nn = total - vz - nc
        out[c] = {"vazios": vz, "nao_class": nc, "nao_nulos": nn, "inteiros": it, "decimais": dc,
                  "outros": nn - it - dc, "min": lo, "max": hi, "max_casas": md,
                  "exemplo_outros": [ox, oy] if ox is not None else None, "distintos_aprox": nd}
    return total, out


def etapa_extrair(base: str, rotulo: str, arquivo: Path):
    for d in (STAGE, STATS):
        d.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    tmp = TRAB / f"_tmp_{base}_{rotulo}.csv"
    sep, cab, nomes, lidas, mantidas, malformadas = extrair_csv(arquivo, tmp, base)
    if malformadas:
        raise RuntimeError(f"{malformadas} linhas com 330455 e número errado de campos em {arquivo}")
    if mantidas < 1000:
        raise RuntimeError(f"só {mantidas} linhas do Rio em {arquivo}")
    t1 = time.time()
    con = conectar()
    con.execute(f"""create view raw as select * from read_csv('{tmp}', delim='{sep}', header=true,
                all_varchar=true, encoding='latin-1', quote='"', escape='"')""")
    total, est = estatisticas(con, nomes)
    if total != mantidas:
        raise RuntimeError(f"DuckDB leu {total} linhas, o filtro gravou {mantidas}")
    manter = [c for c in nomes if c not in RC.FORA_DO_RIO]
    stage = STAGE / nome_arquivo(base, rotulo)
    con.execute(f"""copy (select {', '.join(f'{limpo(c)} as "{c}"' for c in manter)} from raw)
                to '{stage}' (format parquet, compression zstd, compression_level 3)""")
    n_stage = con.execute(f"select count(*) from '{stage}'").fetchone()[0]
    if n_stage != mantidas:
        raise RuntimeError(f"Parquet de trabalho com {n_stage} linhas, esperado {mantidas}")
    t2 = time.time()
    listagem = subprocess.run(["bsdtar", "-tvf", str(arquivo)], capture_output=True, text=True).stdout.strip()
    info = {
        "base": base, "rotulo": rotulo, "ano": int(rotulo[:4]), "arquivo": str(arquivo),
        "bytes_7z": arquivo.stat().st_size, "sha256_7z": sha256(arquivo), "conteudo_7z": listagem,
        "separador": sep, "cabecalho_original": cab, "colunas_canonicas": nomes, "colunas_fora_do_rio":
        [c for c in nomes if c in RC.FORA_DO_RIO], "linhas_lidas": lidas, "linhas_rio": mantidas,
        "linhas_malformadas_com_330455": malformadas, "segundos_extracao": round(t1 - t0),
        "segundos_stage": round(t2 - t1), "colunas": est,
    }
    (STATS / f"{base}_{rotulo}.json").write_text(json.dumps(info, ensure_ascii=False, indent=1))
    tmp.unlink()
    resumo = {k: info[k] for k in ["base", "rotulo", "linhas_lidas", "linhas_rio", "segundos_extracao",
                                   "segundos_stage"]}
    resumo["mb_stage"] = round(stage.stat().st_size / 1e6, 1)
    resumo["outros"] = {c: (s["outros"], s["exemplo_outros"]) for c, s in est.items() if s["outros"]}
    print(json.dumps(resumo, ensure_ascii=False))


# ------------------------------------------------------------------ tipos
def tipo_inteiro(lo, hi):
    tabela = INTEIROS if lo >= 0 else INTEIROS_SINAL
    for t, a, b in tabela:
        if a <= lo and hi <= b:
            return t
    raise ValueError(f"inteiro fora de faixa: {lo}..{hi}")


def faixa(t):
    for nome, a, b in INTEIROS + INTEIROS_SINAL:
        if nome == t:
            return a, b
    return None


def juntar_stats(base: str):
    por_col = {}
    for f in sorted(STATS.glob(f"{base}_*.json")):
        info = json.loads(f.read_text())
        for c, s in info["colunas"].items():
            if c in RC.FORA_DO_RIO:
                continue
            por_col.setdefault(c, []).append((info["rotulo"], s))
    return por_col


def etapa_tipos():
    resultado = {}
    for base in ("vinculos", "estab"):
        tipos, problemas = {}, []
        for c, lista in juntar_stats(base).items():
            outros = sum(s["outros"] for _, s in lista)
            dec = sum(s["decimais"] for _, s in lista)
            ints = [s for _, s in lista if s["min"] is not None]
            if c in RC.TEXTOS:
                tipos[c] = "VARCHAR"
            elif c in RC.DECIMAIS:
                casas = max((s["max_casas"] or 0) for _, s in lista)
                if outros or casas > 2:
                    problemas.append((c, "decimal com texto ou mais de 2 casas", outros, casas))
                tipos[c] = "DECIMAL(18,2)"
            elif outros or dec:
                problemas.append((c, "código com texto ou decimal",
                                  [(r, s["outros"], s["decimais"], s["exemplo_outros"]) for r, s in lista
                                   if s["outros"] or s["decimais"]]))
            elif not ints:
                problemas.append((c, "sempre vazia", None))
            else:
                tipos[c] = tipo_inteiro(min(s["min"] for s in ints), max(s["max"] for s in ints))
        if base == "estab":
            tipos["bairro_ipp_cep"] = "USMALLINT"
        resultado[base] = tipos
        for p in problemas:
            print("PROBLEMA", base, p, file=sys.stderr)
    print(json.dumps(resultado, indent=1))


# ------------------------------------------------------------------ etapa 2
def conferir_tipos(base: str, rotulo: str):
    info = json.loads((STATS / f"{base}_{rotulo}.json").read_text())
    tipos = RC.TIPOS[base]
    for c, s in info["colunas"].items():
        if c in RC.FORA_DO_RIO:
            continue
        t = tipos.get(c)
        if t is None:
            raise RuntimeError(f"{c} sem tipo canônico em rais_colunas.TIPOS[{base!r}]")
        f = faixa(t)
        if f and s["min"] is not None and not (f[0] <= s["min"] and s["max"] <= f[1]):
            raise RuntimeError(f"{rotulo} {c}: {s['min']}..{s['max']} não cabe em {t}")
        if f and (s["outros"] or s["decimais"]):
            raise RuntimeError(f"{rotulo} {c}: valores não inteiros num código {t}")
    return info


def mapa_cnae95() -> dict:
    """4 primeiros dígitos -> classe CNAE 95 de 5 dígitos (aba 'classe 1.0 ou 95' do leiaute oficial)."""
    import xlrd
    sh = xlrd.open_workbook(str(LAYOUT_CNAE95)).sheet_by_name("classe 1.0 ou 95")
    m = {}
    for i in range(1, sh.nrows):
        s = str(sh.cell_value(i, 0)).strip()
        cod = s.split(":", 1)[0].strip()
        if ":" in s and len(cod) == 5 and cod.isdigit():
            p4 = int(cod[:4])
            if p4 in m:
                raise RuntimeError(f"CNAE 95: prefixo {cod[:4]} repetido")
            m[p4] = int(cod)
    return m


def etapa_final(base: str, rotulo: str):
    info = conferir_tipos(base, rotulo)
    tipos = RC.TIPOS[base]
    stage = STAGE / nome_arquivo(base, rotulo)
    DESTINO[base].mkdir(parents=True, exist_ok=True)
    final = DESTINO[base] / nome_arquivo(base, rotulo)
    ano = info["ano"]
    con = conectar()
    presentes = [c for c in RC.CANONICAS[base] if c in info["colunas"] and c not in RC.FORA_DO_RIO]
    sel = [f"{ano}::USMALLINT as ano"]
    correcoes = []
    corrigir = base == "estab" and ano >= RC.CORRECOES_ESTAB_DESDE
    for c in presentes:
        if corrigir and c == "cnae_2_0_classe":
            dif = con.execute(f"""select count(*) from '{stage}' where cnae_2_0_classe is distinct from
                              cnae_2_0_subclasse""").fetchone()[0]
            if dif:
                raise RuntimeError(f"{rotulo}: premissa da correção falhou, {dif} linhas com classe != subclasse")
            sel.append(f'cast(cast(s.cnae_2_0_subclasse as BIGINT) // 100 as {tipos[c]}) as "{c}"')
            correcoes.append("cnae_2_0_classe = 5 primeiros dígitos da subclasse (a fonte repete a subclasse)")
        elif corrigir and c == "cnae_95_classe":
            con.execute("create table c95 (p4 UINTEGER, c5 UINTEGER)")
            con.executemany("insert into c95 values (?, ?)", list({**mapa_cnae95(), **RC.CNAE95_SEM_CORRESPONDENCIA}.items()))
            sem = con.execute(f"""select distinct s.cnae_95_classe from '{stage}' s left join c95
                              on c95.p4 = cast(s.cnae_95_classe as UINTEGER)
                              where s.cnae_95_classe is not null and c95.c5 is null""").fetchall()
            if sem:
                raise RuntimeError(f"{rotulo}: CNAE 95 de 4 dígitos sem classe correspondente: {sem[:20]}")
            sel.append(f'cast(c95.c5 as {tipos[c]}) as "{c}"')
            n9 = con.execute(f"select count(*) from '{stage}' where cnae_95_classe = '9999'").fetchone()[0]
            correcoes.append("cnae_95_classe: dígito verificador recuperado pela lista CNAE 95 do leiaute; "
                             f"{n9} linhas com 9999 (sem correspondente) gravadas como 999, como no leiaute antigo")
        else:
            sel.append(f'cast(s."{c}" as {tipos[c]}) as "{c}"')
    juntar = ""
    if any(c.startswith("cnae_95") for c in correcoes):
        juntar += " left join c95 on c95.p4 = cast(s.cnae_95_classe as UINTEGER)"
    if base == "estab":
        con.execute(f"""create table cep as select cep::UINTEGER as cep, cod_bairro::USMALLINT as cod
                    from read_csv('{CEP_IPP}', all_varchar=true)""")
        dup = con.execute("select count(*) - count(distinct cep) from cep").fetchone()[0]
        if dup:
            raise RuntimeError(f"tabela CEP -> bairro com {dup} CEPs repetidos")
        if "cep_estab" in presentes:
            juntar += " left join cep on cep.cep = cast(s.cep_estab as UINTEGER)"
            sel.append("cep.cod as bairro_ipp_cep")
        else:
            sel.append("NULL::USMALLINT as bairro_ipp_cep")
    ordem = ", ".join(f'"{c}"' for c in RC.ORDEM[base])
    t0 = time.time()
    con.execute(f"""copy (select {', '.join(sel)} from '{stage}' s {juntar} order by {ordem})
                to '{final}' (format parquet, compression zstd, compression_level 19,
                row_group_size 1000000)""")
    t1 = time.time()
    # conferência: linhas, não nulos por coluna e tipo gravado
    n = con.execute(f"select count(*) from '{final}'").fetchone()[0]
    if n != info["linhas_rio"]:
        raise RuntimeError(f"{final}: {n} linhas, esperado {info['linhas_rio']}")
    nn_s = con.execute(f"select {', '.join(f'count({chr(34)}{c}{chr(34)})' for c in presentes)} "
                       f"from '{stage}'").fetchone()
    nn_f = con.execute(f"select {', '.join(f'count({chr(34)}{c}{chr(34)})' for c in presentes)} "
                       f"from '{final}'").fetchone()
    for c, a, b in zip(presentes, nn_s, nn_f):
        if a != b:
            raise RuntimeError(f"{c}: {a} não nulos no trabalho, {b} no final")
    esquema = dict(con.execute(f"select column_name, column_type from (describe select * from '{final}')").fetchall())
    for c in presentes:
        if esquema[c] != tipos[c]:
            raise RuntimeError(f"{c}: gravado como {esquema[c]}, canônico {tipos[c]}")
    meta = pq.ParquetFile(final).metadata
    res = {"base": base, "rotulo": rotulo, "linhas": n, "colunas": meta.num_columns,
           "row_groups": meta.num_row_groups, "mb": round(final.stat().st_size / 1e6, 2),
           "segundos": round(t1 - t0)}
    if base == "estab":
        res["com_bairro_cep"] = con.execute(f"select count(bairro_ipp_cep) from '{final}'").fetchone()[0]
    if correcoes:
        res["correcoes"] = correcoes
    (STATS / f"final_{base}_{rotulo}.json").write_text(json.dumps(res, ensure_ascii=False, indent=1))
    print(json.dumps(res, ensure_ascii=False))


def main():
    cmd = sys.argv[1]
    if cmd == "extrair":
        etapa_extrair(sys.argv[2], sys.argv[3], Path(sys.argv[4]))
    elif cmd == "tipos":
        etapa_tipos()
    elif cmd == "final":
        etapa_final(sys.argv[2], sys.argv[3])
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
