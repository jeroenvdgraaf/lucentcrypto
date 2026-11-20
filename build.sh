#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Jeroen van de Graaf
# Monta o site estático (SPEC-v3 9). Comando de build no Cloudflare Pages: ./build.sh  (saída: dist)
#   /                -> site/index.html   (Cloudflare Workers: wrangler.jsonc aponta para dist/)
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
cp site/index.html site/robots.txt site/sitemap.xml "$OUT/"
mkdir -p "$OUT/embaralhamento" && cp embaralhamento/index.html "$OUT/embaralhamento/index.html"
mkdir -p "$OUT/segredo" && cp segredo/index.html "$OUT/segredo/index.html"
mkdir -p "$OUT/votacao/vendor" && cp votacao/index.html votacao/core.mjs "$OUT/votacao/" && cp votacao/vendor/noble.mjs "$OUT/votacao/vendor/"
mkdir -p "$OUT/og" && cp site/og/*.png "$OUT/og/"
cp LucentSorteios.html "$OUT/sorteios/index.html"
cp amigo-oculto/index.html "$OUT/amigo-oculto/index.html"
cp spec/SPEC.md spec/SPEC-v3.md spec/lucentdraw3_ref.py spec/lucentdraw3_vectors.json spec/LICENSE "$OUT/spec/"
cp verifier/verify_draw.py verifier/LICENSE "$OUT/verifier/"
mkdir -p "$OUT/verifier/tsa-ca" && cp verifier/tsa-ca/*.pem "$OUT/verifier/tsa-ca/"
echo "site montado em $OUT/"
