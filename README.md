# Lucent Sorteios

Sorteios que qualquer pessoa pode conferir sem confiar em quem os organiza (protocolo
**LucentDraw/3**, família LucentCrypto): listas com pesos, moeda, dados e cartas. No modo
**verificável**, as opções e os pesos são lacrados (hash SHA-256) antes de existir o valor aleatório;
o valor vem de uma fonte pública que ninguém controla (bloco Ethereum, farol drand, Mega-Sena ou
Loteria Federal); cada escolha sai de uma regra publicada, só com aritmética inteira. No modo
**rápido**, o resultado sai na hora, com a mesma regra, mas sem comprovante.
Especificação: [`spec/SPEC.md`](spec/SPEC.md) (LucentDraw/2) e [`spec/SPEC-v3.md`](spec/SPEC-v3.md);
decisões de implementação: [`DECISIONS.md`](DECISIONS.md).

## Conteúdo

| Arquivo | O que é |
|---|---|
| `LucentSorteios.html` | O aplicativo: um único arquivo, abas **Lista · Moeda · Dado · Cartas · Conferir**. |
| `verifier/verify_draw.py` | Verificador de referência em Python (LucentDraw/3, /2 e /1). |
| `relay/` | Relay de carimbo de tempo e resultados de loteria (Cloudflare Worker), opcional. |
| `site/index.html`, `build.sh` | Página inicial do site e montagem de `dist/`. |
| `amigo-oculto/` | Lucent Amigo Oculto (página separada). |
| `tests/` | Testes automáticos, todos sem rede. |

## Usar o HTML

Abra `LucentSorteios.html` num navegador atual (também no celular), direto do disco ou de um servidor
estático. Não há instalação nem cadastro.

- **Lista**: uma opção e um peso por linha (1 = chance normal, 0 = fora; aceita `3`, `0,35`, `1/7`); a
  chance de cada uma aparece em porcentagem. *Ordenar todos* ou *Escolher N*, com ou sem reposição.
- **Moeda**, **Dado** (4 a 20 faces, dado viciado em Detalhes) e **Cartas** (1 a 52; 52 embaralha).
- **Verificável**: lacre, divulgação do lacre, espera pela fonte, resultado, comprovante (`.json`) e ata.
  Para loterias, digite o número do **próximo** concurso como aparece no site da Caixa; um concurso já
  sorteado é recusado quando a consulta funciona. Sorteios agendados podem ser fechados e reabertos;
  se a Caixa recusar a consulta, a página pede o resultado e a data oficiais digitados (entrada manual).
- **Rápido**: resultado instantâneo neste aparelho, sem lacre e sem comprovante. Padrão quando a página
  é aberta de um arquivo local.

Para carimbo de tempo, configure a URL do relay em **Detalhes técnicos**. Sem relay a página funciona,
mas avisa que não há carimbo de tempo, e a conferência não consegue provar que o lacre veio antes.

## Conferir com Python

Aceita comprovantes LucentDraw/3, /2 e /1 e mostra os pesos digitados, os pesos inteiros e W.
Requer Python 3.9+ e, para buscar os valores nas fontes, o pacote `requests`.

```sh
pip install requests
python3 verifier/verify_draw.py comprovante-sorteio-<id>.json
python3 verifier/verify_draw.py comprovante.json --rpc https://meu-no.exemplo   # seu próprio nó Ethereum
python3 verifier/verify_draw.py comprovante.json --confirm-lottery              # conferi os números a olho
python3 verifier/verify_draw.py comprovante.json --tsa-ca freetsa-cacert.pem    # valida a cadeia da TSA
```

Saída: 0 = confere, 1 = não confere, 2 = conferência incompleta. A assinatura BLS do drand é
verificada em Python puro; a dos carimbos RFC 3161 usa o `openssl`, se instalado.

## Publicar o site

Um projeto do Cloudflare Pages ligado a este repositório. Comando de build: `./build.sh`; pasta de
saída: `dist`. O resultado tem `/` (página inicial), `/sorteios/`, `/amigo-oculto/`, `/spec/` e
`/verifier/`. Localmente: `./build.sh` e sirva a pasta `dist/`.

## Publicar o relay

Veja [`relay/README.md`](relay/README.md). Em resumo: `cd relay && npx wrangler@3 login && npx wrangler@3 deploy`,
e cole a URL obtida nas configurações da página.

## Testes

```sh
./run_tests.sh      # ou: make test
```

Requer Node.js 18+ e Python 3.9+; `openssl` para os testes de carimbo de tempo. Os testes rodam o
núcleo do protocolo extraído do próprio HTML (marcadores `CORE-BEGIN`/`CORE-END`) e o
`verify_draw.py` sobre os mesmos vetores (SPEC 11 e SPEC-v3 8), comprovantes e adulterações, além de
um teste estatístico da regra de escolha e da montagem do site. O teste de interface com jsdom é
opcional (`JSDOM_DIR=<node_modules com jsdom> ./run_tests.sh`). Comprovantes de teste:
`make fixtures` (ou só os de v3: `node tests/tools/gen_fixtures_v3.mjs`).

## Limitações atuais

- **Nada foi testado contra os serviços reais** (servidores Ethereum, drand, Caixa, TSAs,
  OpenTimestamps): todo o comportamento de rede foi testado com simulações.
- O endpoint da Caixa é não oficial; formato, bloqueio de CORS/IP e a forma dos concursos com sufixo
  ("6054-2") precisam ser confirmados (ver `DECISIONS.md`). Não há calendário de sorteios: o
  operador digita o concurso, e a conferência compara o carimbo com o início do dia do sorteio.
- A página lê os tokens RFC 3161 (horário e hash carimbado), mas não valida a assinatura da TSA;
  isso é feito pelo `verify_draw.py`. A prova OpenTimestamps é guardada e atualizada, mas não é
  verificada aqui (use `ots verify`).
- A regra "um lacre por ID" vale só dentro do mesmo navegador.
- Carimbo do tempo ICP-Brasil: previsto na configuração, desligado.

## Licença

Copyright (C) 2026 Jeroen van de Graaf.

- **Especificação e verificador** ([`spec/`](spec/) e [`verifier/`](verifier/)): [Apache-2.0](spec/LICENSE). Qualquer pessoa pode usar, adaptar e reimplementar a conferência, inclusive em produtos fechados.
- **Todo o resto** (a página `LucentSorteios.html`, a página inicial, o relay, os testes, o `build.sh`): [GNU AGPL-3.0](LICENSE). Quem oferecer uma versão modificada como serviço on-line precisa publicar o código-fonte dessas modificações.
- **Licença comercial:** para usar a aplicação sem as obrigações da AGPL, entre em contato com o autor.
- Cada arquivo indica sua licença na linha `SPDX-License-Identifier`. A cópia do `drand-client` em `tests/vendor/` mantém a sua própria licença (Apache-2.0 ou MIT).
- **Contribuições externas** só são aceitas com um acordo de contribuição (CLA) que preserve a possibilidade de licenciamento comercial.
