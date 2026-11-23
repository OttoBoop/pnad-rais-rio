#!/usr/bin/env bash
# Baixa um arquivo de microdados da RAIS (PDET/MTE) do FTP oficial, com retomada.
# Uso: baixar_rais.sh DESTINO_DIR CAMINHO_REMOTO
#   ex.: baixar_rais.sh ../brutos/rais/2007 2007/RJ2007.7z
# URL: ftp://ftp.mtps.gov.br/pdet/microdados/RAIS/<CAMINHO_REMOTO>
# Grava DESTINO_DIR/<nome>.part e renomeia ao terminar; não baixa de novo se já existe.
set -euo pipefail
dest="$1"; rem="$2"
arq="$(basename "$rem")"
mkdir -p "$dest"
url="ftp://ftp.mtps.gov.br/pdet/microdados/RAIS/$(echo "$rem" | sed 's/ /%20/g')"
if [ -f "$dest/$arq" ]; then echo "já existe: $dest/$arq"; exit 0; fi
echo "$(date '+%F %T') baixando $url"
for i in 1 2 3 4 5 6; do
  if curl --fail --disable-epsv -sS -C - --retry 5 --retry-delay 10 -o "$dest/$arq.part" "$url"; then
    mv "$dest/$arq.part" "$dest/$arq"
    echo "$(date '+%F %T') ok $dest/$arq $(stat -c %s "$dest/$arq")"
    exit 0
  fi
  echo "tentativa $i falhou; retomando"; sleep 15
done
exit 1
