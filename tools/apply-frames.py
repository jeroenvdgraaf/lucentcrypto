# SPDX-License-Identifier: AGPL-3.0-only
# Copyright (C) 2026 Jeroen van de Graaf
#
# Aplica a moldura do site às seis páginas: Laboratório (Encrypt, Segredo, Amigo Oculto: barra escura, fim
# «Mais no Laboratório») e Soluções (Votação, Sorteios, Embaralhamento: cabeçalho da página inicial, fim
# «Para usar na sua organização»). Reescreve só o que está entre os marcadores FRAME-*; pode rodar de novo.
# Uso: python3 tools/apply-frames.py
import re, html
import os
ROOT=os.path.join(os.path.dirname(os.path.abspath(__file__)), "..") + "/"
LAB=[("encrypt/index.html","/encrypt/","Encrypt"),("segredo/index.html","/segredo/","Segredo"),("amigo-oculto/index.html","/amigo-oculto/","Amigo Oculto")]
LAB_DESC={"/encrypt/":"Cifra clássica e pós-quântica, lado a lado.","/segredo/":"Divida um segredo entre pessoas de confiança.","/amigo-oculto/":"Cada um recebe o seu amigo pelo próprio link."}
SOL=[("votacao/index.html","votacao","Votação",["Eleições com até 10.000 eleitores","Autenticação conforme o estatuto","Ata"],"Conte como é a sua eleição. Respondemos com uma proposta.","Votação segura"),
     ("LucentSorteios.html","sorteios","Sorteios",["Seleções públicas e amostras para auditoria","Carimbo do tempo ICP-Brasil, com valor jurídico","Ata"],"Conte o que precisa ser sorteado, e para quem. Respondemos com uma proposta.","Orçamento: sorteio verificável"),
     ("embaralhamento/index.html","conformidade","Conformidade",["Publicação verificável de dados salariais","Cruzar listas sem revelar quem está nelas (PSI)","Cadeia de custódia de documentos e evidências"],"Conte o que você precisa provar, e para quem. Conversamos sobre um piloto.","Piloto: conformidade sem exposição")]
import urllib.parse
q=lambda s: urllib.parse.quote(s, safe="")

def css(top):
    return f'''/* FRAME-BEGIN (moldura do site: Laboratório ou Soluções; mesma em todas as páginas) */
.lcf-bar {{ margin: calc(-1 * {top}) calc(-1 * max(16px, env(safe-area-inset-left, 0px))) 24px; font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }}
.lcf-in {{ max-width: 1120px; margin: 0 auto; padding: 14px 24px; display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px 24px; }}
.lcf-logo {{ font: 800 20px "Avenir Next", "Segoe UI", system-ui, sans-serif; letter-spacing: -0.02em; text-decoration: none; white-space: nowrap; }}
.lcf-logo span {{ color: #a85d08; }}
.lcf-nav {{ display: flex; flex-wrap: wrap; gap: 6px 20px; font-size: 14.5px; font-weight: 500; }}
.lcf-nav a {{ text-decoration: none; padding-bottom: 2px; border-bottom: 2px solid transparent; }}
.lcf-tag {{ font: 600 11.5px ui-monospace, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; }}
.lcf-lab {{ background: #13232b; border-bottom: 1px solid #26363d; }}
.lcf-lab .lcf-logo {{ color: #ffffff; }} .lcf-lab .lcf-logo span {{ color: #f0a443; }}
.lcf-lab .lcf-logo i {{ font: normal 600 12px ui-monospace, Menlo, monospace; letter-spacing: .14em; color: #f0a443; margin-left: 10px; }}
.lcf-lab .lcf-nav a {{ color: #98abb2; }} .lcf-lab .lcf-nav a[aria-current="page"] {{ color: #ffffff; border-color: #f0a443; }}
.lcf-lab .lcf-tag {{ color: #f0a443; border: 1px solid #f0a443; border-radius: 99px; padding: 3px 10px; }}
.lcf-sol {{ background: var(--surface, #ffffff); border-bottom: 1px solid var(--line, #cdd8dc); }}
.lcf-sol .lcf-logo {{ color: var(--ink, #13232b); }}
.lcf-sol .lcf-nav a {{ color: var(--ink, #13232b); }} .lcf-sol .lcf-nav a.lcf-muted {{ color: var(--muted, #50646d); }}
.lcf-sol .lcf-nav a[aria-current="page"] {{ border-color: currentColor; }}
.lcf-btn {{ display: inline-flex; align-items: center; min-height: 40px; padding: 8px 16px; border-radius: 10px; font-weight: 600; font-size: 14.5px; text-decoration: none; background: #1f5a44; color: #ffffff; }}
.lcf-end {{ border-radius: 16px; padding: 26px; display: grid; gap: 16px; }}
.lcf-end h2 {{ margin: 0; font: 800 24px "Avenir Next", "Segoe UI", system-ui, sans-serif; letter-spacing: -0.02em; }}
.lcf-end .lcf-cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }}
.lcf-labend {{ background: #13232b; color: #e2ebee; }}
.lcf-labend .lcf-kick {{ font: 600 12px ui-monospace, Menlo, monospace; letter-spacing: .14em; text-transform: uppercase; color: #f0a443; margin: 0; }}
.lcf-labend a.lcf-card {{ background: #1b2f38; border: 1px solid #26363d; border-radius: 14px; padding: 16px; text-decoration: none; color: #e2ebee; display: grid; gap: 4px; }}
.lcf-labend a.lcf-card:hover {{ border-color: #f0a443; }}
.lcf-labend a.lcf-card b {{ color: #ffffff; }} .lcf-labend a.lcf-card span {{ color: #98abb2; font-size: 14px; }}
.lcf-labend p {{ margin: 0; color: #98abb2; font-size: 14px; }} .lcf-labend p a {{ color: #f0a443; }}
.lcf-solend {{ background: var(--surface, #ffffff); border: 1px solid var(--line, #cdd8dc); grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); align-items: center; gap: 24px; }}
.lcf-solend ul {{ margin: 8px 0 0; padding-left: 20px; display: grid; gap: 4px; }}
.lcf-solend .lcf-box {{ background: var(--bg, #eef2f3); border: 1px solid var(--line, #cdd8dc); border-radius: 14px; padding: 20px; display: grid; gap: 12px; justify-items: start; }}
.lcf-solend .lcf-box p {{ margin: 0; }}
/* FRAME-END */
'''

def lab_bar(cur):
    nav="".join(f'<a href="{p}"{" aria-current=\"page\"" if p==cur else ""}>{n}</a>' for _,p,n in LAB)
    return f'''<!-- FRAME-BAR -->
<div class="lcf-bar lcf-lab" id="lcfBar"><div class="lcf-in">
  <a class="lcf-logo" href="/pt/#laboratorio">Lucent<span>Crypto</span><i>LAB</i></a>
  <nav class="lcf-nav" aria-label="Laboratório">{nav}</nav>
  <span class="lcf-tag">Demonstração</span>
</div></div>
<!-- /FRAME-BAR -->
'''
def lab_end(cur):
    cards="".join(f'<a class="lcf-card" href="{p}"><b>{n}</b><span>{LAB_DESC[p]}</span></a>' for _,p,n in LAB if p!=cur)
    return f'''<!-- FRAME-END -->
<section class="lcf-end lcf-labend" id="lcfEnd" aria-label="Mais no Laboratório">
  <p class="lcf-kick">Mais no Laboratório</p>
  <div class="lcf-cards">{cards}</div>
  <p>Feito pela <a href="/pt/">LucentCrypto</a>, que faz sorteios, publicações de dados e votações verificáveis para organizações.</p>
</section>
<!-- /FRAME-END -->
'''
NAV=[("sorteios","Sorteios"),("conformidade","Conformidade"),("votacao","Votação"),("servicos","Serviços")]
def sol_bar(cur):
    nav="".join(f'<a href="/pt/#{a}"{" aria-current=\"page\"" if a==cur else ""}>{n}</a>' for a,n in NAV)+'<a class="lcf-muted" href="/pt/#laboratorio">Laboratório</a>'
    return f'''<!-- FRAME-BAR -->
<div class="lcf-bar lcf-sol" id="lcfBar"><div class="lcf-in">
  <a class="lcf-logo" href="/pt/">Lucent<span>Crypto</span></a>
  <nav class="lcf-nav" aria-label="Principal">{nav}</nav>
  <a class="lcf-btn" href="/pt/#contato">Fale conosco</a>
</div></div>
<!-- /FRAME-BAR -->
'''
def sol_end(items, text, subject):
    lis="".join(f"<li>{html.escape(i)}</li>" for i in items)
    return f'''<!-- FRAME-END -->
<section class="lcf-end lcf-solend" id="lcfEnd" aria-label="Para usar na sua organização">
  <div><h2>Para usar na sua organização</h2><ul>{lis}</ul></div>
  <div class="lcf-box"><p>{html.escape(text)}</p><a class="lcf-btn" href="mailto:info@lucentcrypto.org?subject={q(subject)}">info@lucentcrypto.org</a></div>
</section>
<!-- /FRAME-END -->
'''

def apply(path, bar, end, top):
    p=ROOT+path; s=open(p).read()
    s=re.sub(r"/\* FRAME-BEGIN.*?/\* FRAME-END \*/\n", "", s, flags=re.S)
    s=re.sub(r"<!-- FRAME-BAR -->.*?<!-- /FRAME-BAR -->\n", "", s, flags=re.S)
    s=re.sub(r"<!-- FRAME-END -->.*?<!-- /FRAME-END -->\n", "", s, flags=re.S)
    i=s.index("</style>"); s=s[:i]+css(top)+s[i:]
    i=s.index("<body>")+len("<body>\n"); s=s[:i]+bar+s[i:]
    # o fim vai logo antes do rodapé da página
    m=re.search(r"\n\s*<footer[ >]", s); i=m.start()+1; s=s[:i]+end+s[i:]
    open(p,"w").write(s)

for path,cur,_ in LAB:
    apply(path, lab_bar(cur), lab_end(cur), "max(20px, env(safe-area-inset-top, 0px))" if "amigo" in path else "24px")
for path,cur,_,items,text,subj in SOL:
    apply(path, sol_bar(cur), sol_end(items,text,subj), "24px")
print("ok")
