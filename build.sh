#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Jeroen van de Graaf
# Monta o site estático (SPEC-v3 9). Comando de build no Cloudflare Pages: ./build.sh  (saída: dist)
#   /                -> site/index.html
#   /sorteios/       -> LucentSorteios.html
#   /amigo-oculto/   -> amigo-oculto/index.html
#   /spec/, /verifier/ -> especificação, vetores e verificador (Apache-2.0)
# Uso: ./build.sh [pasta de saída]   (padrão: dist)
set -eu
cd "$(dirname "$0")"
OUT="${1:-dist}"
case "$OUT" in ""|/|.|..) echo "pasta de saída inválida: $OUT" >&2; exit 1 ;; esac
rm -rf "$OUT"
mkdir -p "$OUT/sorteios" "$OUT/amigo-oculto" "$OUT/spec" "$OUT/verifier"
cp site/index.html "$OUT/index.html"
cp LucentSorteios.html "$OUT/sorteios/index.html"
cp amigo-oculto/index.html "$OUT/amigo-oculto/index.html"
cp spec/SPEC.md spec/SPEC-v3.md spec/lucentdraw3_ref.py spec/lucentdraw3_vectors.json spec/LICENSE "$OUT/spec/"
cp verifier/verify_draw.py verifier/LICENSE "$OUT/verifier/"
echo "site montado em $OUT/"
