/* PDF Facile — outils PDF 100 % hors connexion.
 * Utilise pdf-lib (fichier pdf-lib.min.js fourni localement, aucun téléchargement). */

/* ============================================================
 *  1) CŒUR PDF (aucune dépendance au DOM → testable)
 * ============================================================ */
const PdfCore = (() => {
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const A4 = { w: 595.28, h: 841.89 }; // points (1/72 pouce)

  async function finish(doc) {
    const bytes = await doc.save();
    return { bytes, pages: doc.getPageCount() };
  }

  async function loadPdf(bytes, name) {
    try {
      return await PDFDocument.load(bytes, { ignoreEncryption: true });
    } catch (e) {
      throw new Error(`Impossible de lire « ${name || 'ce fichier'} » (PDF abîmé, protégé ou ce n'est pas un PDF).`);
    }
  }

  /** "1-3,5" -> [1,2,3,5] (pages numérotées à partir de 1) */
  function parseRanges(spec, max) {
    const parts = String(spec).split(',').map(s => s.trim()).filter(Boolean);
    if (!parts.length) throw new Error('Indique les pages à garder. Exemple : 1-3,5');
    const pages = [];
    for (const part of parts) {
      const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
      if (!m) throw new Error(`Format invalide : « ${part} ». Exemple : 1-3,5`);
      const from = +m[1];
      const to = m[2] ? +m[2] : from;
      if (from < 1 || to < from || to > max) {
        throw new Error(`Pages invalides : « ${part} » (ce PDF a ${max} page${max > 1 ? 's' : ''}).`);
      }
      for (let p = from; p <= to; p++) pages.push(p);
    }
    return pages;
  }

  /** images : [{ bytes: Uint8Array, isPng: boolean }]  ;  mode : 'a4' | 'image' */
  async function imagesToPdf(images, mode = 'a4') {
    if (!images.length) throw new Error('Choisis au moins une image.');
    const doc = await PDFDocument.create();
    for (const img of images) {
      const emb = img.isPng ? await doc.embedPng(img.bytes) : await doc.embedJpg(img.bytes);
      let pw, ph, x, y, w, h;
      if (mode === 'image') {
        // la page prend exactement la forme de l'image
        const s = A4.h / Math.max(emb.width, emb.height);
        pw = w = emb.width * s;
        ph = h = emb.height * s;
        x = y = 0;
      } else {
        // A4, orientation automatique, image centrée sans déformation
        const landscape = emb.width > emb.height;
        pw = landscape ? A4.h : A4.w;
        ph = landscape ? A4.w : A4.h;
        const m = 28;
        const s = Math.min((pw - 2 * m) / emb.width, (ph - 2 * m) / emb.height);
        w = emb.width * s;
        h = emb.height * s;
        x = (pw - w) / 2;
        y = (ph - h) / 2;
      }
      doc.addPage([pw, ph]).drawImage(emb, { x, y, width: w, height: h });
    }
    return finish(doc);
  }

  /** Texte brut -> PDF A4 (retour à la ligne, pages et numérotation automatiques) */
  async function textToPdf(raw, { fontSize = 11, margin = 56 } = {}) {
    const text = String(raw).replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
    if (!text.trim()) throw new Error('Le texte est vide.');

    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);

    // caractères non gérés par la police (emoji, etc.) -> "?"
    const known = new Map();
    const clean = s => {
      let out = '';
      for (const ch of s) {
        let ok = known.get(ch);
        if (ok === undefined) {
          try { font.widthOfTextAtSize(ch, 10); ok = true; } catch { ok = false; }
          known.set(ch, ok);
        }
        out += ok ? ch : '?';
      }
      return out;
    };

    const maxW = A4.w - 2 * margin;
    const width = s => font.widthOfTextAtSize(s, fontSize);
    const lines = [];
    // un caractère « saut de page » (\f) dans le texte force le passage à une nouvelle page
    text.split('\f').forEach((section, si) => {
      if (si > 0) lines.push(null);
      for (const rawPara of section.split('\n')) {
        const para = clean(rawPara); // nettoyage par paragraphe (sinon le retour à la ligne serait remplacé par « ? »)
        if (!para.length) { lines.push(''); continue; }
        let cur = '';
        for (const word of para.split(' ')) {
          const test = cur ? cur + ' ' + word : word;
          if (width(test) <= maxW) { cur = test; continue; }
          if (cur) { lines.push(cur); cur = ''; }
          let w = word;
          while (width(w) > maxW) { // mot plus long qu'une ligne : on le coupe
            let n = w.length;
            while (n > 1 && width(w.slice(0, n)) > maxW) n--;
            lines.push(w.slice(0, n));
            w = w.slice(n);
          }
          cur = w;
        }
        lines.push(cur);
      }
    });

    const lineH = fontSize * 1.4;
    const perPage = Math.floor((A4.h - 2 * margin) / lineH);
    let page;
    let row = perPage;
    for (const line of lines) {
      if (line === null) { row = perPage; continue; }
      if (row >= perPage) {
        if (line === '') continue; // pas de ligne vide en haut d'une page
        page = doc.addPage([A4.w, A4.h]); row = 0;
      }
      if (line) {
        page.drawText(line, {
          x: margin, y: A4.h - margin - fontSize - row * lineH,
          size: fontSize, font, color: rgb(0.1, 0.1, 0.1),
        });
      }
      row++;
    }

    const pages = doc.getPages();
    if (pages.length > 1) {
      pages.forEach((p, i) => {
        const t = `${i + 1} / ${pages.length}`;
        p.drawText(t, { x: (A4.w - font.widthOfTextAtSize(t, 9)) / 2, y: 26, size: 9, font, color: rgb(0.45, 0.45, 0.45) });
      });
    }
    return finish(doc);
  }

  /** files : [{ name, bytes }] dans l'ordre voulu */
  async function mergePdfs(files) {
    if (files.length < 2) throw new Error('Choisis au moins 2 PDF à fusionner.');
    const out = await PDFDocument.create();
    for (const f of files) {
      const src = await loadPdf(f.bytes, f.name);
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach(p => out.addPage(p));
    }
    return finish(out);
  }

  /** spec : "1-3,5" (l'ordre écrit est respecté : "5,1" met la page 5 avant la 1) */
  async function extractPages(bytes, spec, name) {
    const src = await loadPdf(bytes, name);
    const wanted = parseRanges(spec, src.getPageCount());
    const out = await PDFDocument.create();
    const pages = await out.copyPages(src, wanted.map(p => p - 1));
    pages.forEach(p => out.addPage(p));
    return finish(out);
  }

  async function countPages(bytes, name) {
    return (await loadPdf(bytes, name)).getPageCount();
  }

  // ---------- traduction ----------

  /** Éléments de texte de pdf.js (page.getTextContent().items) -> liste de paragraphes */
  function itemsToParagraphs(items) {
    const lines = [];
    let cur = null;
    for (const it of items) {
      if (typeof it.str !== 'string') continue;
      const x = it.transform[4], y = it.transform[5];
      const h = it.height || Math.abs(it.transform[3]) || 10;
      if (cur && Math.abs(y - cur.y) <= h * 0.5) {
        if (it.str && x - cur.endX > h * 0.15 && !/\s$/.test(cur.text) && !/^\s/.test(it.str)) cur.text += ' ';
        cur.text += it.str;
        cur.endX = Math.max(cur.endX, x + (it.width || 0));
      } else {
        if (cur) lines.push(cur);
        cur = { text: it.str, x, y, h, endX: x + (it.width || 0) };
      }
    }
    if (cur) lines.push(cur);

    const real = lines.map(l => ({ ...l, text: l.text.replace(/\s+/g, ' ').trim() })).filter(l => l.text);
    if (!real.length) return [];
    const maxW = Math.max(...real.map(l => l.endX - l.x));
    const paras = [];
    let buf = '';
    real.forEach((l, i) => {
      const prev = real[i - 1];
      if (!prev) { buf = l.text; return; }
      const gapY = prev.y - l.y;
      const shortEnd = (prev.endX - prev.x) < maxW * 0.7 && /[.!?:»”"]$/.test(prev.text);
      const newPara = gapY > prev.h * 1.7 || gapY < -prev.h * 0.5 ||
        /^([•▪·\-–]\s|\d{1,2}[.)]\s)/.test(l.text) || (shortEnd && /^[A-ZÀ-Ý0-9]/.test(l.text));
      if (newPara) { paras.push(buf); buf = l.text; }
      else if (/[A-Za-z]-$/.test(buf) && /^[a-z]/.test(l.text)) buf = buf.slice(0, -1) + l.text; // mot coupé en fin de ligne
      else buf += ' ' + l.text;
    });
    if (buf) paras.push(buf);
    return paras;
  }

  const hasLetters = s => /\p{L}/u.test(s);
  const countChars = pages => pages.reduce((n, ps) => n + ps.reduce((m, t) => m + (hasLetters(t) ? t.length : 0), 0), 0);
  const pagesToText = pages => pages.map(ps => ps.join('\n\n')).filter(s => s.trim()).join('\f');

  /** Coupe un très long paragraphe en morceaux (aux fins de phrases si possible) */
  function splitLong(text, max = 4500) {
    const parts = [];
    let rest = text;
    while (rest.length > max) {
      let cut = rest.lastIndexOf('. ', max);
      if (cut > max * 0.5) { parts.push(rest.slice(0, cut + 1)); rest = rest.slice(cut + 1).trimStart(); continue; }
      cut = rest.lastIndexOf(' ', max);
      if (cut <= 0) cut = max;
      parts.push(rest.slice(0, cut)); rest = rest.slice(cut).trimStart();
    }
    if (rest) parts.push(rest);
    return parts;
  }

  class Fatal extends Error {}
  const wait = (ms, signal) => new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('Annulé.')); }, { once: true });
  });

  /** Envoie un lot de textes au serveur de traduction (avec nouvelles tentatives) */
  async function translateBatch(texts, cfg) {
    const f = cfg.fetchFn || fetch;
    const base = cfg.url.replace(/\/+$/, '');
    const pause = cfg.pauseFn || wait;
    for (let attempt = 0; attempt < 6; attempt++) {
      if (cfg.signal && cfg.signal.aborted) throw new Error('Annulé.');
      let retryAfter = 0;
      try {
        const res = await f(base + '/translate', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ texts, source: 'EN', target: 'FR' }), signal: cfg.signal,
        });
        let data = {};
        try { data = await res.json(); } catch { /* corps vide */ }
        if (res.ok) {
          if (!Array.isArray(data.translations) || data.translations.length !== texts.length) throw new Fatal('Réponse inattendue du serveur.');
          return data.translations;
        }
        const retryable = (res.status === 429 && data.code !== 'DAILY_LIMIT') || res.status === 502 ||
          res.status === 504 || (res.status === 503 && data.code !== 'UPSTREAM_QUOTA');
        if (!retryable) throw new Fatal(data.error || `Erreur du serveur (${res.status}).`);
        retryAfter = Number(res.headers && res.headers.get && res.headers.get('Retry-After')) || 0;
      } catch (e) {
        if (e instanceof Fatal) throw e;
        if (e && (e.name === 'AbortError' || e.message === 'Annulé.')) throw new Error('Annulé.');
        // erreur réseau ou réponse « réessayable » : on retente
      }
      if (attempt === 5) break;
      if (cfg.onRetry) cfg.onRetry(attempt + 1);
      await pause(retryAfter ? retryAfter * 1000 : Math.min(2000 * 2 ** attempt, 20000), cfg.signal);
    }
    throw new Error('Le serveur ne répond pas (connexion internet ? serveur endormi ?). Réessaie dans un instant.');
  }

  /** pages : string[][] (paragraphes par page) -> même forme, traduite */
  async function translatePages(pages, cfg, onProgress) {
    const jobs = [];
    pages.forEach((paras, p) => paras.forEach((text, i) => {
      if (hasLetters(text)) jobs.push({ p, i, pieces: splitLong(text), parts: [] });
    }));
    const units = [];
    jobs.forEach(j => j.pieces.forEach((t, k) => units.push({ j, k, t })));
    const total = units.reduce((n, u) => n + u.t.length, 0) || 1;
    const out = pages.map(a => a.slice());
    let u = 0, done = 0;
    while (u < units.length) {
      const batch = [];
      let chars = 0;
      while (u < units.length && batch.length < 40 && (batch.length === 0 || chars + units[u].t.length <= 20000)) {
        chars += units[u].t.length;
        batch.push(units[u++]);
      }
      const tr = await translateBatch(batch.map(b => b.t), cfg);
      batch.forEach((b, n) => { b.j.parts[b.k] = tr[n]; });
      done += chars;
      if (onProgress) onProgress(done / total);
    }
    jobs.forEach(j => { out[j.p][j.i] = j.parts.join(' '); });
    return out;
  }

  return {
    parseRanges, imagesToPdf, textToPdf, mergePdfs, extractPages, countPages,
    itemsToParagraphs, countChars, pagesToText, splitLong, translateBatch, translatePages,
  };
})();

if (typeof module !== 'undefined') module.exports = PdfCore;

/* ============================================================
 *  2) INTERFACE
 * ============================================================ */
function initUI() {
  const $ = s => document.querySelector(s);
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = n => (n < 1024 ? n + ' o' : n < 1048576 ? Math.round(n / 1024) + ' Ko' : (n / 1048576).toFixed(1) + ' Mo');
  const baseName = n => n.replace(/\.[^.]+$/, '');
  const tick = () => new Promise(r => setTimeout(r, 0));

  const TOOLS = {
    images: { icon: '🖼️', title: 'Images → PDF', desc: 'JPG, PNG, WebP…', accept: 'image/*', multiple: true, min: 1,
      hint: 'Choisis une ou plusieurs images : une image par page, dans l’ordre de la liste.' },
    text: { icon: '📝', title: 'Texte → PDF', desc: 'Fichier .txt ou texte collé', accept: '.txt,text/plain', multiple: false, min: 0,
      hint: 'Choisis un fichier .txt, ou colle simplement ton texte ci-dessous.' },
    merge: { icon: '🧩', title: 'Fusionner des PDF', desc: 'Plusieurs PDF en un seul', accept: 'application/pdf,.pdf', multiple: true, min: 2,
      hint: 'Choisis au moins 2 PDF. Change l’ordre avec les flèches.' },
    extract: { icon: '✂️', title: 'Extraire des pages', desc: 'Diviser / garder certaines pages', accept: 'application/pdf,.pdf', multiple: false, min: 1,
      hint: 'Choisis un PDF puis écris les pages à garder.' },
    translate: { icon: '🌍', title: 'Traduire EN → FR', desc: 'Nécessite internet', accept: 'application/pdf,.pdf', multiple: false, min: 1,
      hint: 'Le texte du PDF anglais est traduit en français. C’est la seule option qui utilise internet. Les images ne sont pas conservées.' },
  };

  // Adresse de ton serveur Render (tu peux la mettre ici une fois pour toutes, ou la saisir dans l'appli)
  const DEFAULT_API = '';
  const API_KEY = 'pdf-facile-api';
  const loadApi = () => { try { return localStorage.getItem(API_KEY) || DEFAULT_API; } catch { return DEFAULT_API; } };

  // pdf.js (lecture du texte) n'est chargé que pour la traduction
  let pdfjsPromise = null;
  const loadPdfJs = () => pdfjsPromise || (pdfjsPromise = import('./pdfjs.js').then(m => {
    m.GlobalWorkerOptions.workerSrc = new URL('pdfjs-worker.js', location.href).href;
    return m;
  }).catch(e => { pdfjsPromise = null; throw e; }));

  const home = $('#home');
  const panel = $('#panel');
  let tool = null;
  let files = [];
  let pdfPages = 0;
  let lastUrl = null;

  // ---- accueil ----
  $('#grid').innerHTML = Object.entries(TOOLS).map(([k, t]) =>
    `<button class="card" data-tool="${k}"><span class="ic">${t.icon}</span><b>${t.title}</b><small>${t.desc}</small></button>`
  ).join('');
  $('#grid').addEventListener('click', e => {
    const b = e.target.closest('[data-tool]');
    if (b) openTool(b.dataset.tool);
  });

  function openTool(key) {
    tool = key; files = []; pdfPages = 0;
    if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
    const T = TOOLS[key];
    let options = '';
    if (key === 'images') {
      options = `<label>Taille de page
        <select id="mode"><option value="a4">A4 (image centrée, orientation auto)</option>
        <option value="image">Même taille que l’image</option></select></label>`;
    } else if (key === 'text') {
      options = `<label>Texte à convertir
        <textarea id="txt" rows="7" placeholder="…ou colle ton texte ici"></textarea></label>`;
    } else if (key === 'extract') {
      options = `<label>Pages à garder
        <input id="range" type="text" inputmode="text" placeholder="Ex : 1-3,5" autocomplete="off"></label>
        <p class="hint" id="info"></p>`;
    } else if (key === 'translate') {
      options = `<details id="apiBox"><summary>Serveur de traduction</summary>
        <label>Adresse du serveur
        <input id="api" type="text" inputmode="url" placeholder="https://mon-serveur.onrender.com" autocomplete="off"></label></details>`;
    }
    panel.innerHTML = `
      <button class="back" id="back">← Outils</button>
      <h2>${T.icon} ${T.title}</h2>
      <p class="hint">${T.hint}</p>
      <label class="pick" for="file">＋ Choisir ${T.multiple ? 'des fichiers' : 'un fichier'}</label>
      <input id="file" type="file" hidden accept="${T.accept}" ${T.multiple ? 'multiple' : ''}>
      <ul id="list" class="files"></ul>
      ${options}
      <button id="go" class="primary" disabled>${key === 'translate' ? 'Traduire en français' : 'Créer le PDF'}</button>
      <button id="cancel" type="button" hidden>Annuler</button>
      <div id="status" role="status" aria-live="polite"></div>
      <div id="result"></div>`;
    home.hidden = true; panel.hidden = false;
    window.scrollTo(0, 0);

    $('#back').onclick = () => { panel.hidden = true; home.hidden = false; };
    $('#file').onchange = onFiles;
    $('#go').onclick = run;
    if (key === 'translate') {
      $('#api').value = loadApi();
      if (!$('#api').value) $('#apiBox').open = true; // pas encore configuré : on montre le champ
    }
    ['#txt', '#range', '#api'].forEach(s => { const el = $(s); if (el) el.addEventListener('input', refresh); });
    refresh();
  }

  function canGo() {
    if (tool === 'text') return files.length === 1 || !!$('#txt').value.trim();
    if (tool === 'extract') return files.length === 1 && !!$('#range').value.trim();
    if (tool === 'translate') return files.length === 1 && !!$('#api').value.trim();
    return files.length >= TOOLS[tool].min;
  }

  async function onFiles(e) {
    const picked = [...e.target.files];
    e.target.value = '';
    if (!picked.length) return;
    files = TOOLS[tool].multiple ? files.concat(picked) : picked.slice(0, 1);
    if (tool === 'extract') {
      $('#info').textContent = 'Lecture du PDF…';
      try {
        pdfPages = await PdfCore.countPages(new Uint8Array(await files[0].arrayBuffer()), files[0].name);
        $('#info').textContent = `Ce PDF contient ${pdfPages} page${pdfPages > 1 ? 's' : ''}.`;
      } catch (err) {
        files = []; pdfPages = 0;
        $('#info').textContent = '❌ ' + err.message;
      }
    }
    refresh();
  }

  function small(label, title, fn) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'mini'; b.textContent = label; b.title = title; b.setAttribute('aria-label', title);
    b.onclick = fn;
    return b;
  }

  function refresh() {
    const ul = $('#list');
    ul.innerHTML = '';
    const T = TOOLS[tool];
    files.forEach((f, i) => {
      const li = document.createElement('li');
      const nm = document.createElement('span'); nm.className = 'fname'; nm.textContent = f.name;
      const sz = document.createElement('small'); sz.textContent = fmt(f.size);
      li.append(nm, sz);
      if (T.multiple && files.length > 1) {
        const move = d => () => { const j = i + d; if (j < 0 || j >= files.length) return; [files[i], files[j]] = [files[j], files[i]]; refresh(); };
        li.append(small('↑', 'Monter', move(-1)), small('↓', 'Descendre', move(1)));
      }
      li.append(small('✕', 'Retirer', () => { files.splice(i, 1); pdfPages = 0; refresh(); }));
      ul.append(li);
    });
    $('#go').disabled = !canGo();
  }

  function setStatus(msg, bad) {
    const s = $('#status');
    s.textContent = msg;
    s.className = bad ? 'bad' : '';
  }

  // ---- image -> octets prêts pour pdf-lib (orientation EXIF corrigée, taille raisonnable) ----
  async function prepareImage(file) {
    let bmp;
    try { bmp = await createImageBitmap(file, { imageOrientation: 'from-image' }); }
    catch { try { bmp = await createImageBitmap(file); } catch { throw new Error(`« ${file.name} » : format d’image non pris en charge.`); } }
    const MAX = 2600;
    const s = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    const png = /png|webp|gif|svg/.test(file.type);
    if (!png) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const blob = await new Promise(r => c.toBlob(r, png ? 'image/png' : 'image/jpeg', 0.9));
    if (!blob) throw new Error(`« ${file.name} » : conversion impossible (image trop grande ?).`);
    return { bytes: new Uint8Array(await blob.arrayBuffer()), isPng: png };
  }

  // ---- traduction : lecture du texte (local) puis traduction par lots (via ton serveur) ----
  async function translateFlow(api) {
    setStatus('Chargement de l’outil de lecture PDF…'); await tick();
    const pdfjs = await loadPdfJs();
    setStatus('Ouverture du PDF…'); await tick();
    const data = new Uint8Array(await files[0].arrayBuffer());
    const task = pdfjs.getDocument({ data });
    let doc;
    try { doc = await task.promise; }
    catch (e) { throw new Error(e && e.name === 'PasswordException' ? 'Ce PDF est protégé par un mot de passe.' : 'Impossible de lire ce PDF (abîmé ?).'); }

    const pages = [];
    let blank = 0;
    try {
      for (let p = 1; p <= doc.numPages; p++) {
        if (p % 5 === 1) { setStatus(`Lecture du texte : page ${p}/${doc.numPages}…`); await tick(); }
        const page = await doc.getPage(p);
        const tc = await page.getTextContent();
        const paras = PdfCore.itemsToParagraphs(tc.items);
        if (!paras.length) blank++;
        pages.push(paras);
        page.cleanup();
      }
    } finally { task.destroy(); } // libère la mémoire (important pour les gros PDF)

    const chars = PdfCore.countChars(pages);
    if (!chars) throw new Error('Aucun texte trouvé : ce PDF semble être un scan (images). La lecture des images (OCR) n’est pas encore disponible.');
    if (chars > 50000 && !confirm(`Ce PDF contient environ ${chars.toLocaleString('fr-FR')} caractères à traduire. Lancer la traduction ?`)) {
      throw new Error('Annulé.');
    }

    const ctl = new AbortController();
    const cancel = $('#cancel');
    cancel.hidden = false;
    cancel.onclick = () => ctl.abort();
    try {
      setStatus('Connexion au serveur… (le serveur gratuit peut mettre environ 1 minute à se réveiller)');
      const translated = await PdfCore.translatePages(
        pages,
        { url: api, signal: ctl.signal, onRetry: n => setStatus(`Le serveur tarde à répondre… nouvelle tentative (${n}/5)`) },
        f => setStatus(`Traduction : ${Math.round(f * 100)} %`)
      );
      setStatus('Création du PDF français…'); await tick();
      const out = await PdfCore.textToPdf(PdfCore.pagesToText(translated));
      const note = blank ? `${blank} page${blank > 1 ? 's' : ''} sans texte (images) ignorée${blank > 1 ? 's' : ''}.` : '';
      return { out, name: baseName(files[0].name) + '-fr', note };
    } finally { cancel.hidden = true; }
  }

  async function run() {
    const go = $('#go');
    go.disabled = true;
    $('#result').innerHTML = '';
    setStatus('Traitement en cours…');
    await tick();
    try {
      let out, name, note = '';
      if (tool === 'translate') {
        const api = $('#api').value.trim();
        if (!/^https?:\/\//i.test(api)) throw new Error('Adresse du serveur invalide : elle doit commencer par https://');
        try { localStorage.setItem(API_KEY, api); } catch { /* stockage indisponible */ }
        if (navigator.onLine === false) throw new Error('Pas de connexion internet : cette option en a besoin.');
        ({ out, name, note } = await translateFlow(api));
      } else if (tool === 'images') {
        const imgs = [];
        for (let i = 0; i < files.length; i++) {
          setStatus(`Préparation de l’image ${i + 1}/${files.length}…`);
          await tick();
          imgs.push(await prepareImage(files[i]));
        }
        setStatus('Création du PDF…'); await tick();
        out = await PdfCore.imagesToPdf(imgs, $('#mode').value);
        name = files.length === 1 ? baseName(files[0].name) : 'images';
      } else if (tool === 'text') {
        const content = files.length ? await files[0].text() : $('#txt').value;
        out = await PdfCore.textToPdf(content);
        name = files.length ? baseName(files[0].name) : 'texte';
      } else if (tool === 'merge') {
        const list = [];
        for (const f of files) list.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        out = await PdfCore.mergePdfs(list);
        name = 'fusion';
      } else {
        out = await PdfCore.extractPages(new Uint8Array(await files[0].arrayBuffer()), $('#range').value, files[0].name);
        name = baseName(files[0].name) + '-extrait';
      }
      setStatus('');
      showResult(out, name, note);
    } catch (err) {
      if (err.message === 'Annulé.') setStatus('Annulé.');
      else setStatus('❌ ' + (err.message || 'Erreur inconnue'), true);
    }
    go.disabled = !canGo();
  }

  function showResult(out, defName, note = '') {
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    const blob = new Blob([out.bytes], { type: 'application/pdf' });
    lastUrl = URL.createObjectURL(blob);
    $('#result').innerHTML = `
      <div class="ok">✅ PDF créé : ${out.pages} page${out.pages > 1 ? 's' : ''} · ${fmt(out.bytes.length)}</div>
      ${note ? `<p class="hint">${esc(note)}</p>` : ''}
      <label>Nom du fichier <input id="name" type="text" value="${esc(defName)}.pdf"></label>
      <div class="row"><button id="dl" class="primary">⬇️ Télécharger</button><button id="share">📤 Partager</button></div>`;
    const fileName = () => {
      let n = ($('#name').value.trim() || 'document').replace(/[\\/:*?"<>|]+/g, '-');
      return /\.pdf$/i.test(n) ? n : n + '.pdf';
    };
    $('#dl').onclick = () => {
      const a = document.createElement('a');
      a.href = lastUrl; a.download = fileName();
      document.body.append(a); a.click(); a.remove();
    };
    const share = $('#share');
    const probe = new File([blob], 'x.pdf', { type: 'application/pdf' });
    if (!(navigator.canShare && navigator.canShare({ files: [probe] }))) share.hidden = true;
    share.onclick = async () => {
      const f = new File([blob], fileName(), { type: 'application/pdf' });
      try { await navigator.share({ files: [f], title: f.name }); } catch { /* annulé */ }
    };
    $('#result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ---- installation + hors connexion ----
  let deferred = null;
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (standalone) $('#tip').hidden = true;
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferred = e; $('#install').hidden = false; });
  $('#install').onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null; $('#install').hidden = true;
  };
  window.addEventListener('appinstalled', () => { $('#install').hidden = true; $('#tip').hidden = true; });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(() => navigator.serviceWorker.ready)
      .then(() => { const o = $('#offline'); o.textContent = '✅ Prête hors connexion'; o.hidden = false; })
      .catch(() => {});
  }
}

if (typeof document !== 'undefined') initUI();
