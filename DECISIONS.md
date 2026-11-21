# Decisões de implementação

Pontos em que a SPEC (`spec/SPEC.md`, LucentDraw/2) ou a SPEC-v3 (`spec/SPEC-v3.md`, LucentDraw/3) era
ambígua, contraditória ou dependia de fatos externos. Em cada caso foi escolhida a leitura mais
conservadora. Nenhuma decisão altera entradas de hash, rótulos, nomes de campos ou ordem marcados
como MUST.

## Decisões do responsável

1. **Sem calendário de sorteios (2026-11-19).** Substitui o "draw calendar" da SPEC-v3 4 e a sugestão de
   concurso da SPEC 4.5. A página não guarda calendário, não sugere concurso nem data e não mostra
   contagem regressiva para loterias. O operador digita o concurso como aparece no site da Caixa, com
   link para `https://loterias.caixa.gov.br` e o aviso de usar o PRÓXIMO concurso. O calendário antigo
   guardado no navegador é ignorado. A SPEC-v3 4 e 7 foram atualizadas.
2. **"Este concurso já foi sorteado".** Ao lacrar, a página consulta a Caixa (e o relay, se configurado)
   com tempo máximo de 8 s; se houver resultado, recusa o lacre. Falha de rede não impede o lacre: é só
   melhor esforço.
3. **Checagem de horário das loterias** (HTML e Python, todas as versões): o carimbo de tempo válido mais
   antigo precisa ser anterior às 00:00 de Brasília (UTC−3) da data do sorteio. Vale a data oficial
   quando a conferência obteve o resultado; senão, a `drawDate` do certificado. Sem carimbo: *não
   verificado*, mostrando o `sealedAt` declarado ao lado da data. Id da checagem: `megasenaTiming` /
   `federalTiming`. A checagem geral `timing` passa a cobrir só `eth` e `drand` (e não aparece num
   sorteio só com loteria).

## A confirmar pelo responsável

4. **Endpoint da Caixa** (`https://servicebus2.caixa.gov.br/portaldeloterias/api/<jogo>/<concurso>`):
   nada foi testado contra o serviço real. Formato assumido: `numero`, `dataApuracao` (`dd/mm/aaaa`),
   `listaDezenas` (ou `dezenasSorteadasOrdemSorteio`); para a Federal, os 5 bilhetes **na ordem dos
   prêmios**. Para LucentDraw/3 assume-se que um concurso com sufixo ("6054-2") é pedido com o sufixo na
   URL e que `numero` vem igual ao texto do concurso; se não vier, o resultado é tratado como
   indisponível e a página pede a entrada manual.
5. **Páginas oficiais de resultado** usadas como link: `https://loterias.caixa.gov.br/Paginas/Mega-Sena.aspx`
   e `.../Federal.aspx`.
6. **TSAs padrão** (freetsa.org, DigiCert) e agendas OpenTimestamps: não testadas ao vivo.

## LucentDraw/3

7. **Gramática dos pesos**: só algarismos ASCII `0–9` (o `\d` da referência Python aceitaria algarismos
   de outras escritas, como `٣`); espaço ou tab permitidos só em volta de `/` (como o `\s*` da
   referência, mas só ASCII). "Trim" é o de `String.prototype.trim` (decisão 22). Códigos de erro:
   vazio, sintaxe, negativo, denominador zero.
8. **Frações reduzidas** antes do mmc, como a referência (`Fraction`). O resultado não depende disso
   (a regra é invariante a um fator comum), mas o W mostrado sim; assim W bate com os vetores (489).
9. **Booleano no spec**: a SPEC 3.1 proíbe "booleans as numbers"; em LucentDraw/3 um booleano é aceito
   **só** em `spec.task.replace`. Em /1 e /2 nenhum booleano é aceito (um spec /2 com `task.replace` não
   tem compromisso calculável).
10. **Concurso em texto**: `^[1-9][0-9]*(-[1-9][0-9]*)?$` (sem zeros à esquerda, um sufixo opcional), para
    que o `:` e o `-` da string de valor não fiquem ambíguos.
11. **Bilhetes da Federal em LucentDraw/3**: inteiros de 0 a 999999 na evidência (`prizes`), não texto; a
    Mega-Sena continua com 6 inteiros distintos de 1 a 60. Na conferência, um certificado v3 com bilhetes
    em texto com zeros (formato /2) falha.
12. **Relay**: nova rota `/v3/lottery/<jogo>/<concurso>` no formato v3; `/v1/lottery` ficou igual para
    certificados e lacres /2.
13. **Campos extras**: `spec` e `task` precisam ter exatamente os campos da SPEC-v3 2. Um certificado v3
    sem `result`/`picks` mas com `order` falha em `result`. Para `picks` a comparação é estrita (no
    Python, `True` não vale como `1`).
14. **`preset`** só é conferido como um dos quatro valores; a conferência não exige que as opções
    correspondam ao preset (a SPEC-v3 diz que ele é informativo).
15. **Mínimos da interface**: a Lista exige pelo menos 2 opções com nome (a SPEC permite 1); linhas sem
    nome são ignoradas; moeda, dados e listas com reposição vão até 1000 resultados. A conferência
    segue só a SPEC.
16. **Modo padrão**: Verificável quando a página vem de um endereço web, Rápido quando aberta de um
    arquivo local; a última escolha fica no navegador.
17. **Barra de intervalos**: com reposição, uma barra com todas as agulhas; sem reposição, uma barra por
    escolha (as 8 primeiras, o resto num botão). Larguras e agulhas são calculadas em BigInt e só
    convertidas para porcentagem na hora de desenhar; a regra em si não usa ponto flutuante.
18. **Lacres LucentDraw/2 guardados antes da atualização** continuam a ser concluídos pela regra /2 (ordem).
    Novos lacres são sempre /3.
19. **"Loteria + drand"** não é mais oferecido (sem calendário não há horário seguro para a rodada drand);
    a conferência continua aceitando certificados com essa combinação.
20. **Aviso de milhar**: um peso como `1.000` ou `1,000` vale 1 pela gramática; a lista mostra um aviso
    ("para mil, digite 1000"), sem mudar o valor.

## Protocolo e conferência (de LucentDraw/2, continuam valendo)

21. **Veredito com três estados.** A SPEC 9.7 só define "confere" e "não confere". Itens *atenção* e
    *não verificado* não são falhas, mas também não permitem dizer "confere": "Conferência incompleta:
    nenhum item falhou, mas estes não puderam ser confirmados: …". Exceção: loteria *não verificada* com
    "conferi a olho" marcado (`--confirm-lottery` no Python). `verify_draw.py` sai com 0 = confere,
    1 = não confere, 2 = incompleta.
22. **"Trim"** = conjunto de espaços de `String.prototype.trim` do ECMAScript, também no Python.
23. **Lacre sem aleatoriedade**: fontes ficam *não verificado* ("ainda não registrado"), não *falhou*.
24. **Rodada drand "at or after"**: `r = ceil((t − genesis) / 3) + 1`.
25. **Horário da aleatoriedade** (SPEC 6.4): Ethereum = timestamp do bloco alvo (ou `notBefore + 1` se o
    bloco não puder ser lido); drand = horário da rodada; loterias: decisão 3. Só tokens RFC 3161 que
    carimbam o compromisso (e cuja assinatura não falhou, no Python) entram na comparação.
26. **Validação estrita** de campos de topo e de cada fonte em /2 e /3; para /1, a do protótipo.
27. **Evidência Ethereum inconsistente** falha; bloco com menos confirmações que o exigido é *atenção*;
    reorganização falha com mensagem explícita e o resultado é recalculado com o bloco canônico.
28. **Beacon com BLS inválido**: na página, *não verificado* (a falha é da fonte); no Python, falha.
29. **BLS em Python puro** (RFC 9380), cerca de 1 s por rodada; **TSAs no Python** via `openssl`.

## Interface e segurança

30. **Sem fontes externas**: a página usa fontes do sistema; o único script de terceiros é o
    `drand-client` fixado por versão e hash.
31. **Chave da quicknet fixada na página**; `fetchBeacon` recebe um ChainClient próprio com fallback.
32. **Um lacre por ID** no localStorage; "Novo sorteio com outro ID" troca o ID sugerido.
33. **Entrada manual de loteria**: aparece quando a busca automática falha, ou pelo botão "Inserir o
    resultado manualmente"; exige números, data e a confirmação de que foram conferidos na página oficial.
34. **ICP-Brasil**: presente na configuração do relay (`enabled: false`), sem código que dependa dela.
35. **Não foi construído** o resto da SPEC 12 (grupos de prioridade, FilaLúcida, interface em inglês etc.).

## Feito: Amigo Oculto (21/11/2026)
- Coluna "Celular ou e-mail" por participante; o link vai para o contato do ajudante, quando houver. Celular: WhatsApp direto ao número; e-mail: "Enviar por e-mail"; sem contato: WhatsApp escolhendo o contato. Os contatos ficam só no aparelho (não vão no link de recuperação).
- "Colar uma lista" e "Importar arquivo (.csv)", com o mesmo leitor da Votação; a lista colada substitui o exemplo.

## Feito (21/11/2026): Embaralhamento, símbolos que assustam
- Resolvido: as explicações das moedas e as mensagens de erro falam em «número de ajuste» e «qual caixa é de quem»; as fórmulas (σ, ρ, Δ) ficam só no parágrafo técnico do rodapé. «Certificado» virou «comprovante», como no Sorteios.
- O Δ (e σ, ρ, h^Δ) aparece na seção técnica (linha "Resposta ao 0…") e na mensagem de erro "Número errado de valores Δ." Assusta o leitor comum. Rever: esconder a notação na parte técnica recolhida, ou trocar por palavras ("diferença de sorteio"), e tirar o Δ das mensagens de erro.

## Faróis (21/11/2026)
- Inmetro: só a cadeia de produção (cipherSuite 0, SHA-512). Sem Sloth com o Inmetro (a cadeia Sloth deles é protótipo).
- Chile (CLCERT, random.uchile.cl, 2.1-beta): cipherSuite 1 usa Sloth (SHA3-512 + raízes quadradas encadeadas, com
  iterations e witness), e a mensagem assinada começa em cipherSuite (sem uri e version). Implementar só quando houver
  demanda no mercado de língua espanhola; até lá, a página em espanhol diz «a pedido».

## Versões em inglês das ferramentas (nov/2026)
- Cada ferramenta tem PT e EN; o PT também atende quem lê espanhol, o EN quem lê holandês.
- A página em português é a fonte. `tools/translate-pages.mjs` gera `en/<ferramenta>/index.html` com uma
  tabela de substituições exatas (`<ferramenta>/en.json`, mais `tools/i18n/frame-sol.en.json` para a moldura).
  Se o português mudar e uma chave sumir, a geração falha; o teste `tests/translate.test.mjs` confere que o
  arquivo gerado está atualizado e que não sobrou português.
- Os valores do protocolo não mudam com a língua (por exemplo, as opções continuam "Sim", "Candidato"…;
  a página em inglês só mostra traduzido).
- Sorteios: a tabela de textos inteira (const STR) vem de `sorteios/strings.en.js`; o teste confere que tem as mesmas
  chaves e os mesmos argumentos que a portuguesa. A ata sai na língua da página onde o sorteio é feito; o certificado
  (JSON) é o mesmo nas duas línguas, e um certificado feito numa confere na outra.
- Feito: Votação (/en/votacao/), Sorteios (/en/sorteios/). Próximo: Embaralhamento; depois Amigo Oculto, Encrypt, Segredo.
