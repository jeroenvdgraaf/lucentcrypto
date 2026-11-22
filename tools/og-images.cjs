const { chromium } = require('playwright');
// Imagens de pré-visualização (og:image), 1200×630. Uso: node tools/og-images.cjs  (precisa do Playwright)
const path = require('path');
const OUT = path.join(__dirname, '..', 'site', 'og') + '/';
const card = (word, line, motif) => `<!doctype html><html><head><meta charset="utf-8"><style>
*{margin:0;box-sizing:border-box}
body{width:1200px;height:630px;background:#eef2f3;font-family:"Inter Display","Inter",sans-serif;color:#13232b;position:relative;overflow:hidden}
.k{position:absolute;left:84px;top:78px;font:500 22px "DejaVu Sans Mono",monospace;letter-spacing:.14em;color:#50646d}
h1{position:absolute;left:80px;top:128px;font-weight:800;font-size:100px;letter-spacing:-.035em;line-height:1}
h1 span{color:#a85d08}
p{position:absolute;left:84px;top:280px;width:680px;font-size:36px;line-height:1.3;color:#2c3d45;font-weight:500}
.u{position:absolute;left:84px;bottom:66px;font:600 26px "Inter",sans-serif;color:#1f5a44}
.m{position:absolute;right:84px;top:262px;width:300px;height:240px}
.rule{position:absolute;left:84px;right:84px;bottom:120px;height:2px;background:#cdd8dc}
</style></head><body>
<div class="k">LUCENTCRYPTO</div>
<h1${word.includes('<') ? ' style="font-size:70px;white-space:nowrap;top:140px"' : ''}>${word.includes('<') ? word : word === 'LucentCrypto' ? 'Lucent<span>Crypto</span>' : 'Lucent <span>' + word + '</span>'}</h1>
<p>${line}</p><div class="rule"></div><div class="u">lucentcrypto.org</div>
<svg class="m" viewBox="0 0 360 330">${motif}</svg></body></html>`;
// motifs: weighted bars with a needle; a gift cycle; both
const bars = `<g font-family="Inter" font-size="15">
${[[0,0.26],[0.26,0.18],[0.44,0.34],[0.78,0.22]].map(([x,w],i)=>`<rect x="${20+x*320}" y="${40+i*0}" width="${w*320-4}" height="54" rx="8" fill="${i==2?'#f2cf9e':'#d7e1e4'}"/>`).join('')}
<rect x="${20+0.61*320}" y="28" width="4" height="78" fill="#b3261e"/>
${[[0,0.4],[0.4,0.32],[0.72,0.28]].map(([x,w],i)=>`<rect x="${20+x*320}" y="140" width="${w*320-4}" height="54" rx="8" fill="${i==0?'#f2cf9e':'#d7e1e4'}"/>`).join('')}
<rect x="${20+0.13*320}" y="128" width="4" height="78" fill="#b3261e"/>
${[[0,0.55],[0.55,0.45]].map(([x,w],i)=>`<rect x="${20+x*320}" y="240" width="${w*320-4}" height="54" rx="8" fill="${i==1?'#f2cf9e':'#d7e1e4'}"/>`).join('')}
<rect x="${20+0.83*320}" y="228" width="4" height="78" fill="#b3261e"/></g>`;
const ring = (() => { const n=7, cx=180, cy=165, r=128; let s='';
  const pts=[...Array(n)].map((_,i)=>[cx+r*Math.sin(2*Math.PI*i/n), cy-r*Math.cos(2*Math.PI*i/n)]);
  pts.forEach((p,i)=>{ const q=pts[(i+1)%n]; const a=Math.atan2(q[1]-p[1],q[0]-p[0]); const d=30;
    const x1=p[0]+d*Math.cos(a), y1=p[1]+d*Math.sin(a), x2=q[0]-d*Math.cos(a), y2=q[1]-d*Math.sin(a);
    s+=`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#a85d08" stroke-width="4" marker-end="url(#ah)"/>`; });
  pts.forEach((p,i)=>{ s+=`<circle cx="${p[0]}" cy="${p[1]}" r="24" fill="${i==0?'#a85d08':'#ffffff'}" stroke="#13232b" stroke-width="3"/>`; });
  return `<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#a85d08"/></marker></defs>`+s; })();
const shuffle = (() => { let s='';
  const L=[0,1,2,3,4], R=[3,0,4,1,2];
  L.forEach((i)=>{ s+=`<rect x="10" y="${20+i*58}" width="90" height="40" rx="8" fill="#d7e1e4"/>`; });
  L.forEach((i)=>{ s+=`<rect x="260" y="${20+i*58}" width="90" height="40" rx="8" fill="#f2cf9e" stroke="#a85d08" stroke-dasharray="5 4" stroke-width="2"/>`; });
  L.forEach((i)=>{ const y1=40+i*58, y2=40+R[i]*58; s+=`<path d="M100 ${y1} C180 ${y1}, 180 ${y2}, 260 ${y2}" fill="none" stroke="#1d7a4e" stroke-width="3"/>`; });
  return s; })();
const keyshare = (() => { let s = ''; const cx = 180, cy = 165, r = 120;
  const pts = [...Array(5)].map((_, i) => [cx + r * Math.sin(2 * Math.PI * i / 5), cy - r * Math.cos(2 * Math.PI * i / 5)]);
  pts.forEach((p, i) => { if (i < 3) s += `<line x1="${cx}" y1="${cy}" x2="${p[0]}" y2="${p[1]}" stroke="#a85d08" stroke-width="4" stroke-dasharray="6 6"/>`; });
  s += `<circle cx="${cx}" cy="${cy}" r="30" fill="#a85d08"/><rect x="${cx - 9}" y="${cy - 4}" width="18" height="16" rx="3" fill="#fff"/><path d="M${cx - 6} ${cy - 4} v-6 a6 6 0 0 1 12 0 v6" fill="none" stroke="#fff" stroke-width="3"/>`;
  pts.forEach((p, i) => { s += `<circle cx="${p[0]}" cy="${p[1]}" r="24" fill="${i < 3 ? '#f2cf9e' : '#ffffff'}" stroke="#13232b" stroke-width="3"/>`; });
  return s; })();
const sizesMotif = (() => { let s = '';
  [[32, 'X25519'], [1184, 'ML-KEM-768'], [1216, 'X-Wing']].forEach(([n, l], i) => {
    const w = 30 + 270 * n / 1216, y = 150 + i * 56;
    s += `<rect x="20" y="${y}" width="${w}" height="36" rx="8" fill="${i == 2 ? '#f2cf9e' : '#d7e1e4'}"/><text x="${28}" y="${y + 25}" font-family="DejaVu Sans Mono" font-size="17" fill="#13232b">${l}</text>`; });
  s += `<rect x="130" y="40" width="100" height="78" rx="12" fill="#a85d08"/><path d="M150 40 v-16 a30 30 0 0 1 60 0 v16" fill="none" stroke="#a85d08" stroke-width="12"/><circle cx="180" cy="76" r="10" fill="#fff"/><rect x="176" y="80" width="8" height="20" rx="3" fill="#fff"/>`;
  return s; })();
const ballotMotif = ((yes = 'Sim', no = 'Não') => { let s = '';
  s += `<rect x="60" y="150" width="240" height="150" rx="14" fill="#d7e1e4" stroke="#13232b" stroke-width="3"/><rect x="130" y="140" width="100" height="16" rx="6" fill="#13232b"/>`;
  s += `<g transform="rotate(-8 180 90)"><rect x="135" y="30" width="90" height="120" rx="8" fill="#fff" stroke="#13232b" stroke-width="3"/><path d="M155 90 l16 18 l30 -40" fill="none" stroke="#a85d08" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/></g>`;
  s += `<text x="180" y="240" text-anchor="middle" font-family="DejaVu Sans Mono" font-size="26" fill="#13232b">${yes} 12 · ${no} 7</text>`;
  return s; });
const venn = `<circle cx="130" cy="165" r="105" fill="#d7e1e4" stroke="#13232b" stroke-width="3" fill-opacity=".9"/><circle cx="230" cy="165" r="105" fill="#d7e1e4" stroke="#13232b" stroke-width="3" fill-opacity=".6"/><path d="M180 76 A105 105 0 0 1 180 254 A105 105 0 0 1 180 76 Z" fill="#f2cf9e" stroke="#a85d08" stroke-width="3"/><text x="180" y="174" text-anchor="middle" font-family="DejaVu Sans Mono" font-size="30" fill="#13232b">A∩B</text>`;
(async () => { const b = await chromium.launch(); const p = await b.newPage({ viewport: { width: 1200, height: 630 } });
  for (const [f, w, l, m] of [
    ['sorteios.png', 'Sorteios', 'Sorteio online que qualquer pessoa pode conferir: vagas de garagem, listas, moeda, dados e cartas.', bars],
    ['amigo-oculto.png', 'Amigo Oculto', 'Amigo secreto online: cada pessoa recebe o seu amigo pelo próprio link, no WhatsApp.', ring],
    ['lucentcrypto.png', 'LucentCrypto', "Sorteios, publicações de dados e votações cujo resultado qualquer pessoa pode conferir, sem expor ninguém.", bars],
    ['segredo.png', 'Segredo', 'Divida um segredo entre pessoas de confiança: só o número combinado, juntos, recupera.', keyshare],
    ['encrypt.png', 'Encrypt', 'Uma frase de 7 palavras vira a sua chave. Clássico, pós-quântico e híbrido, lado a lado.', sizesMotif],
    ['votacao.png', 'Votação', 'Votações secretas numa reunião: cada pessoa vota pelo celular, só os totais são abertos.', ballotMotif()],
    ['cruzamento.png', 'Cruzamento <span>de listas</span>', 'Descubra o que duas listas têm em comum sem entregar nenhuma delas.', venn],
    ['embaralhamento.png', 'Embaralhamento <span>verificável</span>', 'Prove que a lista publicada corresponde aos dados lacrados, sem revelar quem é quem.', shuffle],
    // inglês (páginas em /en/) e a página inicial em espanhol e holandês
    ['en/sorteios.png', 'Draw', 'Online draws anyone can check: parking spaces, lists, coins, dice and cards.', bars],
    ['en/amigo-oculto.png', 'Secret Santa', 'Secret Santa online: everyone gets their match through their own link, on WhatsApp.', ring],
    ['en/lucentcrypto.png', 'LucentCrypto', "Draws, data publications and elections whose results anyone can verify, without exposing anyone.", bars],
    ['es/lucentcrypto.png', 'LucentCrypto', "Sorteos, publicaciones de datos y votaciones cuyo resultado cualquier persona puede verificar, sin exponer a nadie.", bars],
    ['nl/lucentcrypto.png', 'LucentCrypto', "Lotingen, gegevenspublicaties en verkiezingen waarvan iedereen de uitslag kan controleren, zonder iemand bloot te stellen.", bars],
    ['en/segredo.png', 'Secret', 'Split a secret among people you trust: only the agreed number, together, can recover it.', keyshare],
    ['en/encrypt.png', 'Encrypt', 'A 7-word phrase becomes your key. Classic, post-quantum and hybrid, side by side.', sizesMotif],
    ['en/votacao.png', 'Vote', 'Secret votes in a meeting: everyone votes on their phone, only the totals are opened.', ballotMotif('Yes', 'No')],
    ['en/cruzamento.png', 'Private list <span>matching</span>', 'Find out what two lists have in common without handing over either of them.', venn],
    ['en/embaralhamento.png', 'Verifiable <span>shuffle</span>', 'Prove that the published list matches the sealed data, without revealing who is who.', shuffle],
  ]) { require('fs').mkdirSync(path.dirname(OUT + f), { recursive: true }); await p.setContent(card(w, l, m)); await p.screenshot({ path: OUT + f }); }
  await b.close(); })();
