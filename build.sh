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
cp site/index.html site/robots.txt site/sitemap.xml site/logo.png site/c04cc0abe797b12ebf2dec3719c0bcc7.txt "$OUT/"   # o .txt: chave do IndexNow (tools/indexnow.mjs)
for l in pt es nl; do mkdir -p "$OUT/$l" && cp "site/$l/index.html" "$OUT/$l/index.html"; done   # gerados por tools/build-home.mjs
mkdir -p "$OUT/embaralhamento" && cp embaralhamento/index.html "$OUT/embaralhamento/index.html"
mkdir -p "$OUT/cruzamento" && cp cruzamento/index.html cruzamento/core.mjs "$OUT/cruzamento/"
mkdir -p "$OUT/segredo" && cp segredo/index.html "$OUT/segredo/index.html"
mkdir -p "$OUT/encrypt" && cp encrypt/index.html "$OUT/encrypt/index.html"
mkdir -p "$OUT/votacao/vendor" && cp votacao/index.html votacao/core.mjs votacao/verifica.mjs "$OUT/votacao/" && cp votacao/vendor/noble.mjs "$OUT/votacao/vendor/"
mkdir -p "$OUT/en/votacao" && cp en/votacao/index.html "$OUT/en/votacao/index.html"
mkdir -p "$OUT/en/sorteios" && cp en/sorteios/index.html "$OUT/en/sorteios/index.html"
mkdir -p "$OUT/en/embaralhamento" && cp en/embaralhamento/index.html "$OUT/en/embaralhamento/index.html"
mkdir -p "$OUT/en/cruzamento" && cp en/cruzamento/index.html "$OUT/en/cruzamento/index.html"
for t in amigo-oculto encrypt segredo; do mkdir -p "$OUT/en/$t" && cp "en/$t/index.html" "$OUT/en/$t/index.html"; done
mkdir -p "$OUT/og" && cp site/og/*.png "$OUT/og/" && for l in en es nl; do mkdir -p "$OUT/og/$l" && cp site/og/$l/*.png "$OUT/og/$l/"; done
cp LucentSorteios.html "$OUT/sorteios/index.html"
cp amigo-oculto/index.html "$OUT/amigo-oculto/index.html"
cp spec/SPEC.md spec/SPEC-v3.md spec/lucentdraw3_ref.py spec/lucentdraw3_vectors.json spec/LICENSE "$OUT/spec/"
cp verifier/verify_draw.py verifier/LICENSE "$OUT/verifier/"
mkdir -p "$OUT/verifier/tsa-ca" && cp verifier/tsa-ca/*.pem "$OUT/verifier/tsa-ca/"
echo "site montado em $OUT/"
