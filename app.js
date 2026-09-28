'use strict';
/* Visitas de obra — registro de fotografías con descripción dictada,
   almacenado primero en el móvil (funciona sin cobertura) y subido después
   a Google Drive, donde Claude lo lee. */

const CFG = window.APP_CONFIG;
const TIPOS = {
  obra:  { nombre: 'Visita de obra en curso',              corto: 'Obra en curso', carpeta: 'obra',
           ayuda: 'Seguimiento de una obra en ejecución.' },
  datos: { nombre: 'Visita de toma de datos para informe', corto: 'Toma de datos', carpeta: 'toma-datos',
           ayuda: 'Inspección para un informe técnico o pericial.' },
};

const ICONO = {
  camara: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-3h6l2 3h3v13H4z"/><circle cx="12" cy="13" r="4"/></svg>',
  galeria: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m3 17 5-5 4 4 3-3 6 6"/></svg>',
  micro: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>',
  parar: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};

/* ---------- utilidades ---------- */

const app = document.getElementById('app');
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const dos = n => String(n).padStart(2, '0');
const fechaISO = d => `${d.getFullYear()}-${dos(d.getMonth() + 1)}-${dos(d.getDate())}`;
const hora = iso => { const d = new Date(iso); return `${dos(d.getHours())}:${dos(d.getMinutes())}`; };
const fechaCorta = iso => new Date(iso).toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
const fechaLarga = iso => new Date(iso).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
const slug = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
const nFoto = n => 'F' + dos(n);
const extension = tipo => ({ 'image/png': 'png', 'image/heic': 'heic', 'image/webp': 'webp', 'audio/mp4': 'm4a', 'audio/ogg': 'ogg' }[tipo] || (tipo.startsWith('audio') ? 'webm' : 'jpg'));

let temporizadorAviso;
function aviso(texto, tipo = '') {
  const el = $('#aviso');
  el.textContent = texto;
  el.className = 'visible ' + tipo;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => { el.className = ''; }, tipo === 'error' ? 6000 : 3000);
}

/* ---------- almacenamiento local (IndexedDB) ---------- */

const DB = (() => {
  let abierta;
  const abrir = () => abierta ||= new Promise((ok, mal) => {
    const r = indexedDB.open('visitas-obra', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('visitas', { keyPath: 'id' });
      d.createObjectStore('expedientes', { keyPath: 'codigo' });
      d.createObjectStore('blobs');   // fotos, miniaturas y audios
      d.createObjectStore('kv');      // ajustes
    };
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
  });
  async function op(almacen, modo, fn) {
    const d = await abrir();
    return new Promise((ok, mal) => {
      const t = d.transaction(almacen, modo);
      const pet = fn(t.objectStore(almacen));
      let res;
      if (pet) pet.onsuccess = () => { res = pet.result; };
      t.oncomplete = () => ok(res);
      t.onerror = t.onabort = () => mal(t.error);
    });
  }
  return {
    get: (a, k) => op(a, 'readonly', s => s.get(k)),
    todos: a => op(a, 'readonly', s => s.getAll()),
    put: (a, v, k) => op(a, 'readwrite', s => (k === undefined ? s.put(v) : s.put(v, k))),
    borrar: (a, k) => op(a, 'readwrite', s => s.delete(k)),
  };
})();

const ajuste = {
  leer: k => DB.get('kv', k),
  poner: (k, v) => DB.put('kv', v, k),
};

async function idCliente() {
  return (await ajuste.leer('clientId')) || CFG.GOOGLE_CLIENT_ID || '';
}

// Toda edición del usuario sube la revisión y deja la visita pendiente de subir.
async function guardarVisita(v) {
  v.rev = (v.rev || 0) + 1;
  v.sync = 'pendiente';
  await DB.put('visitas', v);
}

async function borrarFotoLocal(fid) {
  await Promise.all(['img', 'thumb', 'audio'].map(t => DB.borrar('blobs', `${fid}:${t}`)));
}

async function miniatura(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const escala = Math.min(1, 480 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * escala);
    c.height = Math.round(bmp.height * escala);
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.75));
  } catch { return blob; }
}

// Fecha de disparo (DateTimeOriginal) leída de los metadatos EXIF de un JPEG.
// Devuelve null si la imagen no los tiene.
async function fechaExif(blob) {
  try {
    const d = new DataView(await blob.slice(0, 256 * 1024).arrayBuffer());
    if (d.getUint16(0) !== 0xFFD8) return null;
    let p = 2;
    while (p + 4 < d.byteLength) {
      const marcador = d.getUint16(p);
      const largo = d.getUint16(p + 2);
      if (marcador === 0xFFE1 && d.getUint32(p + 4) === 0x45786966) { // «Exif»
        const t = p + 10;                                          // cabecera TIFF
        const le = d.getUint16(t) === 0x4949;
        const u16 = o => d.getUint16(t + o, le);
        const u32 = o => d.getUint32(t + o, le);
        const buscar = (ifd, etiqueta) => {
          const n = u16(ifd);
          for (let i = 0; i < n; i++) {
            const e = ifd + 2 + i * 12;
            if (u16(e) === etiqueta) return e;
          }
          return null;
        };
        const texto = e => {
          let s = '';
          for (let i = 0; i < 19; i++) s += String.fromCharCode(d.getUint8(t + u32(e + 8) + i));
          return s;
        };
        const ifd0 = u32(4);
        let e = null;
        const punteroExif = buscar(ifd0, 0x8769);
        if (punteroExif) e = buscar(u32(punteroExif + 8), 0x9003);   // DateTimeOriginal
        e ||= buscar(ifd0, 0x0132);                                   // DateTime
        if (!e) return null;
        const m = texto(e).match(/^(\d{4}):(\d\d):(\d\d) (\d\d):(\d\d):(\d\d)/);
        return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
      }
      if ((marcador & 0xFF00) !== 0xFF00) break;
      p += 2 + largo;
    }
  } catch { /* EXIF ilegible */ }
  return null;
}

const textoMarca = iso => {
  const d = new Date(iso);
  return `${dos(d.getDate())}/${dos(d.getMonth() + 1)}/${d.getFullYear()}  ${dos(d.getHours())}:${dos(d.getMinutes())}`;
};

// Copia de la foto con la fecha y hora de captura impresas abajo a la derecha.
// El original no se toca: esta copia pierde los metadatos EXIF.
async function imagenConMarca(blob, iso) {
  const bmp = await createImageBitmap(blob);
  const c = document.createElement('canvas');
  c.width = bmp.width;
  c.height = bmp.height;
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  bmp.close?.();
  const texto = textoMarca(iso);
  const alto = Math.round(Math.max(18, Math.min(c.width, c.height) * 0.04));
  g.font = `600 ${alto}px system-ui, sans-serif`;
  const ancho = g.measureText(texto).width;
  const relleno = Math.round(alto * 0.4);           // entre texto y borde del recuadro
  const separacion = Math.round(alto * 0.8);        // entre recuadro y borde de la foto
  const anchoCaja = ancho + relleno * 2;
  const altoCaja = alto + relleno * 2;
  const x = c.width - separacion - anchoCaja;
  const y = c.height - separacion - altoCaja;
  g.fillStyle = 'rgba(0,0,0,0.55)';
  g.fillRect(x, y, anchoCaja, altoCaja);
  g.fillStyle = '#ffd200';
  g.textBaseline = 'top';
  g.fillText(texto, x + relleno, y + relleno);
  return new Promise(ok => c.toBlob(ok, 'image/jpeg', 0.92));
}

/* ---------- dictado (reconocimiento de voz del navegador) ---------- */

const SR = window.SpeechRecognition || window.webkitSpeechRecognition;

const Dictado = {
  activo: false,
  rec: null,

  iniciar(textarea, alCambiar, alEstado) {
    this.activo = true;
    const arrancar = () => {
      const r = new SR();
      r.lang = CFG.IDIOMA;
      r.interimResults = true;
      r.continuous = false; // en Android el modo continuo duplica frases; se relanza al terminar
      if (!navigator.onLine) {
        if ('processLocally' in r) r.processLocally = true;
        else if ('mode' in r) r.mode = 'ondevice-only';
      }
      let base = textarea.value;
      if (base && !/\s$/.test(base)) base += ' ';
      r.onresult = e => {
        let texto = '';
        for (let i = 0; i < e.results.length; i++) texto += e.results[i][0].transcript;
        if (!base.trim() || /[.!?]\s*$/.test(base)) texto = texto.charAt(0).toUpperCase() + texto.slice(1);
        textarea.value = base + texto;
        alCambiar();
      };
      r.onerror = e => {
        if (e.error === 'no-speech' || e.error === 'aborted') return;
        this.activo = false;
        alEstado('error', e.error);
      };
      r.onend = () => { if (this.activo) arrancar(); else alEstado('parado'); };
      try { r.start(); } catch (err) { this.activo = false; alEstado('error', err.message); return; }
      this.rec = r;
      alEstado('escuchando');
    };
    arrancar();
  },

  parar() {
    this.activo = false;
    try { this.rec?.stop(); } catch { /* ya parado */ }
  },

  // Descarga el modelo de voz en español al móvil para dictar sin cobertura (Chrome reciente).
  async prepararSinConexion() {
    if (!SR) return 'Este navegador no tiene dictado. Usa Chrome en Android.';
    const idiomas = [CFG.IDIOMA];
    try {
      if (SR.available && SR.install) {
        const estado = await SR.available({ langs: idiomas, processLocally: true });
        if (estado === 'available') return 'El dictado sin conexión ya está listo.';
        if (estado === 'unavailable') return 'Este móvil no admite dictado sin conexión en español. Se grabará el audio cuando no haya cobertura.';
        const ok = await SR.install({ langs: idiomas, processLocally: true });
        return ok ? 'Modelo de voz descargado. Ya puedes dictar sin cobertura.' : 'No se pudo descargar el modelo de voz.';
      }
      if (SR.availableOnDevice && SR.installOnDevice) {
        const estado = await SR.availableOnDevice(CFG.IDIOMA);
        if (estado === 'available') return 'El dictado sin conexión ya está listo.';
        const ok = await SR.installOnDevice(CFG.IDIOMA);
        return ok ? 'Modelo de voz descargado.' : 'No se pudo descargar el modelo de voz.';
      }
    } catch (e) { return 'Error al preparar el dictado: ' + e.message; }
    return 'Esta versión de Chrome no permite descargar el modelo de voz. Sin cobertura se grabará el audio (o usa el micrófono del teclado).';
  },
};

/* ---------- grabación de audio (alternativa sin cobertura) ---------- */

const Grabadora = {
  rec: null,
  async iniciar() {
    const flujo = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tipo = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const trozos = [];
    this.rec = new MediaRecorder(flujo, tipo ? { mimeType: tipo } : undefined);
    this.rec.ondataavailable = e => e.data.size && trozos.push(e.data);
    this.terminado = new Promise(ok => {
      this.rec.onstop = () => {
        flujo.getTracks().forEach(t => t.stop());
        ok(new Blob(trozos, { type: (this.rec.mimeType || 'audio/webm').split(';')[0] }));
      };
    });
    this.rec.start();
  },
  async parar() {
    this.rec.stop();
    const blob = await this.terminado;
    this.rec = null;
    return blob;
  },
  get activa() { return !!this.rec; },
};

/* ---------- Google Drive ---------- */

const Drive = {
  token: null,
  caduca: 0,
  cliente: null,

  valido() { return this.token && Date.now() < this.caduca - 60000; },

  cargarGIS() {
    if (window.google?.accounts?.oauth2) return Promise.resolve();
    return new Promise((ok, mal) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.onload = ok;
      s.onerror = () => mal(new Error('No se pudo cargar el acceso de Google.'));
      document.head.appendChild(s);
    });
  },

  async autorizar(clientId) {
    if (this.valido()) return this.token;
    await this.cargarGIS();
    return new Promise((ok, mal) => {
      this.cliente = google.accounts.oauth2.initTokenClient({
        client_id: clientId,
        // drive.file: la app solo ve lo que ella misma crea; no tiene acceso al resto de tu Drive.
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: r => {
          if (r.error) return mal(new Error(r.error_description || r.error));
          this.token = r.access_token;
          this.caduca = Date.now() + r.expires_in * 1000;
          ok(this.token);
        },
        error_callback: e => mal(new Error(e.type === 'popup_closed' ? 'Se cerró la ventana de Google.' : (e.message || e.type))),
      });
      this.cliente.requestAccessToken({ prompt: '' });
    });
  },

  async api(ruta, opciones = {}) {
    const url = ruta.startsWith('http') ? ruta : 'https://www.googleapis.com/drive/v3/' + ruta;
    const r = await fetch(url, { ...opciones, headers: { Authorization: 'Bearer ' + this.token, ...(opciones.headers || {}) } });
    if (!r.ok) throw new Error(`Drive ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r;
  },

  async buscar(nombre, padre, esCarpeta) {
    const q = [`name='${nombre.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`, 'trashed=false', `'${padre}' in parents`];
    if (esCarpeta) q.push("mimeType='application/vnd.google-apps.folder'");
    const r = await this.api('files?fields=files(id)&q=' + encodeURIComponent(q.join(' and ')));
    return (await r.json()).files[0]?.id || null;
  },

  async carpeta(nombre, padre = 'root') {
    const existente = await this.buscar(nombre, padre, true);
    if (existente) return existente;
    const r = await this.api('files?fields=id', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: nombre, mimeType: 'application/vnd.google-apps.folder', parents: [padre] }),
    });
    return (await r.json()).id;
  },

  // Subida reanudable (sirve para fotos grandes). Con idExistente, reemplaza el contenido.
  async subir(blob, nombre, padre, tipo, idExistente) {
    const url = idExistente
      ? `https://www.googleapis.com/upload/drive/v3/files/${idExistente}?uploadType=resumable`
      : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
    const r = await this.api(url, {
      method: idExistente ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8', 'X-Upload-Content-Type': tipo },
      body: JSON.stringify(idExistente ? {} : { name: nombre, parents: [padre] }),
    });
    const destino = r.headers.get('Location');
    const r2 = await fetch(destino, { method: 'PUT', headers: { 'Content-Type': tipo }, body: blob });
    if (!r2.ok) throw new Error(`Drive ${r2.status} al subir ${nombre}`);
    return (await r2.json()).id;
  },

  async leerTexto(id) {
    return (await this.api(`files/${id}?alt=media`)).text();
  },

  async renombrar(id, nombre) {
    await this.api(`files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: nombre }) });
  },

  async papelera(id) {
    await this.api(`files/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{"trashed":true}' });
  },
};

/* ---------- generación de visita.md y visita.json ---------- */

const nombreCarpetaExp = e => `${e.codigo}_${slug(e.nombre)}`;
const nombreCarpetaVisita = v => `${fechaISO(new Date(v.inicio))}_${hora(v.inicio).replace(':', '')}_${TIPOS[v.tipo].carpeta}`;
const archivoFoto = (f, tipo) => `${nFoto(f.n)}.${extension(tipo || f.tipoImg || 'image/jpeg')}`;
const archivoAudio = f => `${nFoto(f.n)}_audio.${extension(f.tipoAudio || 'audio/webm')}`;
const archivoMarca = f => `${nFoto(f.n)}_marca.jpg`;
// La foto que debe ir al informe: la marcada si la visita lleva marca y ya está generada.
const archivoInforme = (v, f) => (v.marcaAgua ? archivoMarca(f) : archivoFoto(f));

function generarMD(v) {
  const e = v.expediente;
  const l = [];
  l.push(`# ${TIPOS[v.tipo].nombre} — ${e.codigo} · ${e.nombre}`, '');
  l.push('| | |', '|---|---|');
  l.push(`| Expediente | ${e.codigo} — ${e.nombre} |`);
  l.push(`| Tipo de visita | ${TIPOS[v.tipo].nombre} |`);
  l.push(`| Fecha | ${fechaLarga(v.inicio)} |`);
  l.push(`| Hora | ${hora(v.inicio)}${v.fin ? ' – ' + hora(v.fin) : ' (en curso)'} |`);
  l.push(`| Estado | ${v.estado === 'cerrada' ? 'Visita cerrada' : 'Visita abierta: pueden añadirse más fotografías'} |`);
  l.push(`| Fotografías | ${v.fotos.length} |`);
  l.push(`| Marca de fecha y hora | ${v.marcaAgua ? 'Sí' : 'No'} |`);
  l.push('');
  l.push('> Registro de campo tomado con la app «Visitas de obra». Las descripciones son');
  l.push('> **observaciones del técnico dictadas en la visita** y transcritas automáticamente;');
  l.push('> pueden contener errores de transcripción. Cuando existe, el audio original prevalece');
  l.push('> sobre el texto.');
  if (v.marcaAgua) {
    l.push('>');
    l.push('> Las imágenes `Fnn_marca.jpg` llevan impresas la fecha y hora de captura y son las que');
    l.push('> se usan en el informe. `Fnn.jpg` es el **original intacto, con sus metadatos EXIF**.');
  }
  l.push('');
  l.push('## Fotografías y observaciones', '');
  for (const f of v.fotos) {
    l.push(`### ${nFoto(f.n)} — ${fechaCorta(f.hora)} ${hora(f.hora)}`, '');
    l.push(`![${nFoto(f.n)}](${archivoInforme(v, f)})`, '');
    if (v.marcaAgua) l.push(`*Original: \`${archivoFoto(f)}\`*`, '');
    l.push(f.descripcion?.trim() ? f.descripcion.trim() : '*Sin descripción.*', '');
    if (f.audio) {
      l.push(`*Audio original: \`${archivoAudio(f)}\`${f.pendienteTranscribir ? ' — **pendiente de transcribir**' : ''}.*`, '');
    }
  }
  return l.join('\n');
}

function generarJSON(v) {
  return JSON.stringify({
    formato: 'visitas-obra/2',
    expediente: v.expediente,
    tipo: v.tipo,
    tipo_nombre: TIPOS[v.tipo].nombre,
    inicio: v.inicio,
    fin: v.fin || null,
    estado: v.estado,
    marca_agua: !!v.marcaAgua,
    fotos: v.fotos.map(f => ({
      id: nFoto(f.n),
      hora: f.hora,
      hora_origen: f.origenHora || 'dispositivo', // exif = fecha de disparo leída de la propia foto
      archivo: archivoFoto(f),
      archivo_marca: v.marcaAgua ? archivoMarca(f) : null,
      descripcion: f.descripcion || '',
      audio: f.audio ? archivoAudio(f) : null,
      pendiente_transcribir: !!f.pendienteTranscribir,
    })),
  }, null, 2);
}

const VERSION_LEEME = 3; // subir al cambiar el texto, para que se vuelva a copiar a Drive
const LEEME_DRIVE = `# VISITAS-OBRA — Registro de campo del estudio

Carpeta generada por la app «Visitas de obra». No renombrar ni mover las carpetas a mano.

## Estructura

    VISITAS-OBRA/
      expedientes.json                 lista de expedientes (código y nombre)
      <CÓDIGO>_<nombre>/               una carpeta por expediente
        <AAAA-MM-DD>_<HHMM>_<tipo>/    una carpeta por visita; tipo = obra | toma-datos
          F01.jpg, F02.jpg…            fotografías ORIGINALES, intactas y con metadatos EXIF
          F01_marca.jpg…               copia con fecha y hora impresas (si la visita lleva marca)
          F01_audio.webm…              audio original, solo si se grabó
          visita.md                    fotos + observaciones dictadas (legible)
          visita.json                  los mismos datos, estructurados

## Instrucciones para Claude

- Las descripciones son observaciones del técnico transcritas de voz: respetar el
  contenido y corregir solo errores evidentes de transcripción, señalándolo.
- Una foto marcada «pendiente de transcribir» tiene el audio pero no el texto.
- La numeración F01, F02… es siempre correlativa y sigue el orden de toma. Si en la
  visita se borra una foto, las siguientes se renumeran (y sus archivos se renombran),
  de modo que nunca hay huecos: la lista de visita.md es completa y consecutiva.
- En los informes se inserta la imagen que indica visita.md: la copia _marca si existe.
  El original sin marca es la prueba con metadatos; no se edita ni se sustituye.
  La fecha impresa procede del EXIF de la foto (hora_origen = "exif" en visita.json).
- Para los informes, el contenido de visita.md alimenta el diario de visitas del
  expediente (00-SISTEMA/plantillas/informes/PLANTILLA_diario-de-visitas.md),
  apartado «Lo que se observa» y tabla «Fotografías y vídeo».
`;

/* ---------- sincronización ---------- */

let sincronizando = false;

// Copia los identificadores de Drive sobre la versión actual de la visita,
// sin pisar ediciones que el usuario haya hecho durante la subida.
async function guardarProgresoDrive(v, terminado, tirados = new Set()) {
  const actual = await DB.get('visitas', v.id);
  if (!actual) return;
  // La papelera se conserva de la versión actual: pudo recibir borrados durante la subida.
  const papelera = (actual.drive?.papelera || []).filter(id => !tirados.has(id));
  actual.drive = { ...v.drive, papelera };
  for (const f of actual.fotos) {
    const subida = v.fotos.find(x => x.id === f.id);
    if (subida) f.drive = subida.drive;
  }
  if (terminado) {
    actual.sync = actual.rev === v.rev ? 'subida' : 'pendiente';
    actual.subidaEn = new Date().toISOString();
  }
  await DB.put('visitas', actual);
}

async function subirVisita(id, raiz) {
  const v = await DB.get('visitas', id);
  v.drive ||= {};
  const carpetaExp = await Drive.carpeta(nombreCarpetaExp(v.expediente), raiz);
  if (!v.drive.carpeta) {
    v.drive.carpeta = await Drive.carpeta(nombreCarpetaVisita(v), carpetaExp);
    await guardarProgresoDrive(v);
  }
  const carpeta = v.drive.carpeta;
  // Primero la papelera, para que al renumerar no convivan dos archivos con el mismo nombre.
  const tirados = new Set(v.drive.papelera || []);
  for (const idDrive of tirados) {
    try { await Drive.papelera(idDrive); } catch { /* ya no existe */ }
  }
  v.drive.papelera = [];
  const progreso = () => guardarProgresoDrive(v, false, tirados);

  // Cada foto tiene hasta tres archivos en Drive: original, copia con marca y audio.
  // Para cada uno: se sube si falta y se renombra si la foto cambió de número.
  const archivos = [
    { id: 'img', nom: 'nombreImg', nombre: archivoFoto, quiere: () => true,
      contenido: f => DB.get('blobs', f.id + ':img') },
    { id: 'marca', nom: 'nombreMarca', nombre: archivoMarca, quiere: () => !!v.marcaAgua,
      contenido: async f => {
        const b = await DB.get('blobs', f.id + ':img');
        return b && imagenConMarca(b, f.hora);
      } },
    { id: 'audio', nom: 'nombreAudio', nombre: archivoAudio, quiere: f => f.audio,
      contenido: f => DB.get('blobs', f.id + ':audio') },
  ];

  for (const f of v.fotos) {
    f.drive ||= {};
    for (const a of archivos) {
      const id = f.drive[a.id];
      if (!a.quiere(f)) {
        if (id) { // p. ej. se desactivó la marca: la copia marcada va a la papelera
          try { await Drive.papelera(id); } catch { /* ya no existe */ }
          f.drive[a.id] = null;
          await progreso();
        }
        continue;
      }
      if (!id) {
        const b = await a.contenido(f);
        if (!b) continue;
        f.drive[a.id] = await Drive.subir(b, a.nombre(f), carpeta, b.type || 'application/octet-stream');
        f.drive[a.nom] = a.nombre(f);
        await progreso();
      } else if (f.drive[a.nom] !== a.nombre(f)) {
        await Drive.renombrar(id, a.nombre(f));
        f.drive[a.nom] = a.nombre(f);
        await progreso();
      }
    }
  }
  v.drive.md = await Drive.subir(new Blob([generarMD(v)], { type: 'text/markdown' }), 'visita.md', carpeta, 'text/markdown', v.drive.md);
  v.drive.json = await Drive.subir(new Blob([generarJSON(v)], { type: 'application/json' }), 'visita.json', carpeta, 'application/json', v.drive.json);
  await guardarProgresoDrive(v, true, tirados);
}

// expedientes.json en Drive es la lista común entre dispositivos; se fusiona con la local.
async function sincronizarExpedientes(raiz) {
  const locales = await DB.todos('expedientes');
  const id = await Drive.buscar('expedientes.json', raiz, false);
  let remotos = [];
  if (id) { try { remotos = JSON.parse(await Drive.leerTexto(id)); } catch { remotos = []; } }
  const todos = new Map(remotos.map(e => [e.codigo, e]));
  for (const e of locales) if (!todos.has(e.codigo)) todos.set(e.codigo, e);
  const lista = [...todos.values()].sort((a, b) => b.codigo.localeCompare(a.codigo));
  for (const e of lista) await DB.put('expedientes', e);
  await Drive.subir(new Blob([JSON.stringify(lista, null, 2)], { type: 'application/json' }), 'expedientes.json', raiz, 'application/json', id);
}

async function sincronizar(interactivo) {
  if (sincronizando) return;
  const cid = await idCliente();
  if (!cid) { if (interactivo) aviso('Falta conectar con Google Drive (Ajustes).', 'error'); return; }
  if (!navigator.onLine) { if (interactivo) aviso('Sin cobertura. Se subirá cuando vuelva la conexión.'); return; }
  const pendientes = (await DB.todos('visitas')).filter(v => v.sync !== 'subida');
  // Sin pulsar el botón no se puede abrir la ventana de Google: solo se sube si ya hay sesión.
  if (!interactivo && (!pendientes.length || !Drive.valido())) return;

  sincronizando = true;
  pintarEstadoSync();
  try {
    await Drive.autorizar(cid);
    const raiz = await Drive.carpeta(CFG.DRIVE_ROOT);
    if ((await ajuste.leer('leemeVersion')) !== VERSION_LEEME) {
      await Drive.subir(new Blob([LEEME_DRIVE], { type: 'text/markdown' }), 'LEEME.md', raiz, 'text/markdown', await Drive.buscar('LEEME.md', raiz, false));
      await ajuste.poner('leemeVersion', VERSION_LEEME);
    }
    await sincronizarExpedientes(raiz);
    for (const v of pendientes) await subirVisita(v.id, raiz);
    aviso(pendientes.length ? `${pendientes.length} visita(s) subida(s) a Drive.` : 'Todo al día en Drive.', 'ok');
  } catch (e) {
    console.error(e);
    aviso('No se pudo sincronizar: ' + e.message, 'error');
  } finally {
    sincronizando = false;
    render();
  }
}

function pintarEstadoSync() {
  const b = $('#sync');
  if (b) { b.disabled = true; b.innerHTML = '<span class="girando">↻</span> Subiendo…'; }
}

/* ---------- captura de fotos ---------- */

let destinoFotos = null; // id de la visita que recibe las fotos

function pedirFoto(vid, galeria) {
  destinoFotos = vid;
  const entrada = $(galeria ? '#entrada-galeria' : '#entrada-camara');
  entrada.value = '';
  entrada.click();
}

async function recibirFotos(archivos) {
  if (!destinoFotos || !archivos.length) return;
  const v = await DB.get('visitas', destinoFotos);
  let ultima;
  for (const archivo of archivos) {
    // La hora de la foto es la de disparo guardada en la propia imagen; si no la tiene,
    // la del momento (cámara) o la del archivo (galería).
    const exif = await fechaExif(archivo);
    const f = {
      id: uid(),
      n: v.fotos.length + 1,
      hora: (exif || new Date(archivos.length > 1 ? archivo.lastModified : Date.now())).toISOString(),
      origenHora: exif ? 'exif' : 'dispositivo',
      tipoImg: archivo.type || 'image/jpeg',
      descripcion: '',
      audio: false,
      pendienteTranscribir: false,
      drive: {},
    };
    await DB.put('blobs', archivo, f.id + ':img');
    await DB.put('blobs', await miniatura(archivo), f.id + ':thumb');
    v.fotos.push(f);
    ultima = f;
  }
  await guardarVisita(v);
  location.hash = archivos.length === 1 ? `#/foto/${v.id}/${ultima.id}` : `#/visita/${v.id}`;
  if (archivos.length > 1) render();
}

$('#entrada-camara').addEventListener('change', e => recibirFotos([...e.target.files]));
$('#entrada-galeria').addEventListener('change', e => recibirFotos([...e.target.files]));

/* ---------- vistas ---------- */

let urlsTemporales = [];
const urlDe = blob => { const u = URL.createObjectURL(blob); urlsTemporales.push(u); return u; };

function etiquetaSync(v) {
  const cuando = v.subidaEn ? ` · ${fechaISO(new Date(v.subidaEn)) === fechaISO(new Date()) ? '' : fechaCorta(v.subidaEn) + ' '}${hora(v.subidaEn)}` : '';
  if (v.sync === 'subida') return `<span class="etiqueta ok">✓ En Drive${cuando}</span>`;
  return v.subidaEn
    ? '<span class="etiqueta pend">● Cambios sin subir</span>'
    : '<span class="etiqueta pend">● Pendiente de subir</span>';
}

// Marca de fecha y hora por defecto en visitas nuevas: activada salvo que se desactive en Ajustes.
const marcaPorDefecto = async () => (await ajuste.leer('marcaAgua')) !== false;

async function vistaInicio() {
  const visitas = (await DB.todos('visitas')).sort((a, b) => b.inicio.localeCompare(a.inicio));
  const pendientes = visitas.filter(v => v.sync !== 'subida').length;
  const enLinea = navigator.onLine;
  app.innerHTML = `
    <header class="barra"><h1>Visitas de obra</h1><a class="icono" href="#/ajustes" aria-label="Ajustes">⚙</a></header>
    <main>
      <a class="btn primario grande" href="#/nueva">+ Nueva visita</a>
      <div class="estado ${pendientes ? 'pendiente' : ''}">
        <span><i class="punto ${enLinea ? '' : 'off'}"></i>${enLinea ? 'Con conexión' : 'Sin cobertura'}<br>
          <b>${pendientes ? `${pendientes} visita(s) con cambios sin subir` : '✓ Todo subido a Drive'}</b></span>
        <button id="sync" class="btn peq ${pendientes ? 'primario' : ''}" ${enLinea ? '' : 'disabled'}>Subir a Drive</button>
      </div>
      <h2>Visitas registradas</h2>
      ${visitas.length ? `<ul class="lista">${visitas.map(v => `
        <li><a class="tarjeta" href="#/visita/${v.id}">
          <b>${esc(v.expediente.codigo)} · ${esc(v.expediente.nombre)}</b>
          <small>${TIPOS[v.tipo].corto} · ${fechaCorta(v.inicio)} ${hora(v.inicio)} · ${v.fotos.length} foto(s)</small><br>
          ${v.estado === 'abierta' ? '<span class="etiqueta abierta">En curso</span> ' : ''}${etiquetaSync(v)}
        </a></li>`).join('')}</ul>` : '<p class="vacio">Aún no hay visitas.<br>Empieza con «Nueva visita».</p>'}
    </main>`;
  $('#sync').onclick = () => sincronizar(true);
}

async function vistaNueva() {
  const expedientes = (await DB.todos('expedientes')).sort((a, b) => b.codigo.localeCompare(a.codigo));
  const ultimo = await ajuste.leer('ultimoExpediente');
  const ultimoTipo = (await ajuste.leer('ultimoTipo')) || 'obra';
  app.innerHTML = `
    <header class="barra"><a class="icono" href="#/" aria-label="Volver">←</a><h1>Nueva visita</h1></header>
    <main>
      <h2>Tipo de visita</h2>
      <div class="tipos">
        ${Object.entries(TIPOS).map(([k, t]) => `
          <label class="tipo"><input type="radio" name="tipo" value="${k}" ${k === ultimoTipo ? 'checked' : ''}>
            <b>${t.nombre}</b><small>${t.ayuda}</small></label>`).join('')}
      </div>
      <h2>Expediente</h2>
      <select id="exp">
        ${expedientes.map(e => `<option value="${esc(e.codigo)}" ${e.codigo === ultimo ? 'selected' : ''}>${esc(e.codigo)} · ${esc(e.nombre)}</option>`).join('')}
        <option value="__nuevo" ${expedientes.length ? '' : 'selected'}>+ Nuevo expediente…</option>
      </select>
      <div id="nuevo-exp" hidden>
        <label for="codigo">Código</label>
        <input id="codigo" type="text" placeholder="26-025-INF" autocapitalize="characters">
        <label for="nombre">Nombre / obra</label>
        <input id="nombre" type="text" placeholder="Rúa Vila de Noia 70-72">
        <p class="ayuda">Se añadirá a la lista común al sincronizar con Drive.</p>
      </div>
      <h2>Fotografías</h2>
      <label class="interruptor"><input id="marca" type="checkbox" ${(await marcaPorDefecto()) ? 'checked' : ''}>
        <span>Imprimir fecha y hora en las fotos<small>Se conserva además el original sin marca.</small></span></label>
      <div style="margin-top:24px"><button id="empezar" class="btn primario grande">Empezar visita</button></div>
    </main>`;
  const sel = $('#exp');
  const alternar = () => { $('#nuevo-exp').hidden = sel.value !== '__nuevo'; };
  sel.onchange = alternar;
  alternar();
  $('#empezar').onclick = async () => {
    const tipo = $('input[name=tipo]:checked').value;
    let exp;
    if (sel.value === '__nuevo') {
      const codigo = $('#codigo').value.trim().toUpperCase();
      const nombre = $('#nombre').value.trim();
      if (!codigo || !nombre) return aviso('Indica código y nombre del expediente.', 'error');
      exp = { codigo, nombre, alta: new Date().toISOString() };
      await DB.put('expedientes', exp);
    } else {
      exp = expedientes.find(e => e.codigo === sel.value);
    }
    await ajuste.poner('ultimoExpediente', exp.codigo);
    await ajuste.poner('ultimoTipo', tipo);
    const v = {
      id: uid(), tipo, expediente: { codigo: exp.codigo, nombre: exp.nombre },
      inicio: new Date().toISOString(), fin: null, estado: 'abierta',
      marcaAgua: $('#marca').checked, fotos: [], drive: {},
    };
    await guardarVisita(v);
    location.hash = `#/visita/${v.id}`;
  };
}

async function vistaVisita(vid) {
  const v = await DB.get('visitas', vid);
  if (!v) { location.hash = '#/'; return; }
  const minis = await Promise.all(v.fotos.map(f => DB.get('blobs', f.id + ':thumb')));
  const abierta = v.estado === 'abierta';
  const sinTexto = v.fotos.filter(f => !f.descripcion?.trim() && !f.audio).length;
  app.innerHTML = `
    <header class="barra"><a class="icono" href="#/" aria-label="Volver">←</a>
      <h1>${esc(v.expediente.codigo)}</h1></header>
    <div class="cabecera-visita">
      <b>${esc(v.expediente.nombre)}</b><br>
      ${TIPOS[v.tipo].nombre}<br>
      ${fechaLarga(v.inicio)} · ${hora(v.inicio)}${v.fin ? '–' + hora(v.fin) : ''} · ${etiquetaSync(v)}
    </div>
    <main>
      ${sinTexto ? `<p class="falta">${sinTexto} foto(s) sin descripción.</p>` : ''}
      ${v.fotos.length ? `<div class="rejilla">${v.fotos.map((f, i) => `
        <a class="miniatura" href="#/foto/${v.id}/${f.id}">
          ${minis[i] ? `<img src="${urlDe(minis[i])}" alt="${nFoto(f.n)}">` : '<div style="aspect-ratio:4/3"></div>'}
          <span class="num">${nFoto(f.n)}</span>
          <button class="quitar" data-fid="${f.id}" aria-label="Eliminar ${nFoto(f.n)}">✕</button>
          <div class="pie">${hora(f.hora)}${f.audio ? ' · 🎙' : ''}
            <p class="${f.descripcion?.trim() ? '' : 'falta'}">${esc(f.descripcion?.trim() || (f.pendienteTranscribir ? 'Audio pendiente de transcribir' : 'Sin descripción'))}</p></div>
        </a>`).join('')}</div>` : '<p class="vacio">Haz la primera fotografía.</p>'}
      <label class="interruptor" style="margin-top:20px"><input id="marca" type="checkbox" ${v.marcaAgua ? 'checked' : ''}>
        <span>Imprimir fecha y hora en las fotos<small>En Drive: copia Fnn_marca.jpg junto al original.</small></span></label>
      <div class="pila" style="margin-top:20px">
        ${abierta
          ? '<button id="cerrar" class="btn">Cerrar visita y subir a Drive</button>'
          : '<button id="reabrir" class="btn">Reabrir visita para añadir fotos</button>'}
        ${abierta || v.sync === 'subida' ? '' : '<button id="subir" class="btn primario">Subir cambios a Drive</button>'}
        ${abierta && v.fotos.length ? '<button id="subir" class="btn">Subir lo hecho hasta ahora a Drive</button>' : ''}
        <button id="borrar" class="btn peligro">Eliminar visita del móvil</button>
      </div>
    </main>
    ${abierta ? `<div class="barra-inferior">
      <button id="foto" class="btn primario grande">${ICONO.camara} Foto</button>
      <button id="galeria" class="btn grande" aria-label="Añadir desde galería">${ICONO.galeria}</button>
    </div>` : ''}`;

  if (abierta) {
    $('#foto').onclick = () => pedirFoto(v.id, false);
    $('#galeria').onclick = () => pedirFoto(v.id, true);
    $('#cerrar').onclick = async () => {
      const act = await DB.get('visitas', vid);
      act.estado = 'cerrada';
      act.fin = new Date().toISOString();
      await guardarVisita(act);
      aviso('Visita cerrada.');
      render();
      if (navigator.onLine && (await idCliente())) sincronizar(true);
    };
  } else {
    $('#reabrir').onclick = async () => {
      const act = await DB.get('visitas', vid);
      act.estado = 'abierta';
      await guardarVisita(act);
      render();
    };
  }
  $('#subir')?.addEventListener('click', () => sincronizar(true));
  $('#marca').onchange = async e => {
    const act = await DB.get('visitas', vid);
    act.marcaAgua = e.target.checked;
    await guardarVisita(act);
    aviso(act.marcaAgua ? 'Se imprimirá fecha y hora al subir a Drive.' : 'Sin marca: en Drive quedarán solo los originales.');
    render();
  };
  app.querySelectorAll('.quitar').forEach(b => {
    b.onclick = async e => {
      e.preventDefault(); // la ✕ está dentro del enlace a la foto
      if (await eliminarFoto(vid, b.dataset.fid)) render();
    };
  });
  $('#borrar').onclick = async () => {
    const aviso1 = v.sync === 'subida'
      ? '¿Eliminar esta visita del móvil? Lo que ya está en Drive se conserva.'
      : 'Esta visita NO está subida a Drive. ¿Eliminarla del móvil de todas formas? Se perderán sus fotos.';
    if (!confirm(aviso1)) return;
    for (const f of v.fotos) await borrarFotoLocal(f.id);
    await DB.borrar('visitas', vid);
    location.hash = '#/';
  };
}

async function vistaFoto(vid, fid) {
  const v = await DB.get('visitas', vid);
  const f = v?.fotos.find(x => x.id === fid);
  if (!f) { location.hash = v ? `#/visita/${vid}` : '#/'; return; }
  const [img, audio] = await Promise.all([DB.get('blobs', fid + ':img'), DB.get('blobs', fid + ':audio')]);
  const editable = v.estado === 'abierta';

  app.innerHTML = `
    <header class="barra"><a class="icono" href="#/visita/${vid}" aria-label="Volver">←</a>
      <h1>${nFoto(f.n)} · ${hora(f.hora)}</h1></header>
    ${img ? `<div class="marco-foto"><img class="foto-grande" src="${urlDe(img)}" alt="${nFoto(f.n)}">
      ${v.marcaAgua ? `<span class="sello" title="Así se imprimirá en la copia de Drive">${textoMarca(f.hora)}</span>` : ''}</div>`
      : '<p class="vacio">Imagen no disponible en este móvil (ya está en Drive).</p>'}
    <main>
      <label for="desc">Descripción de lo observado</label>
      <textarea id="desc" placeholder="Pulsa el micrófono y describe lo que se ve: elemento, lesión, ubicación exacta, extensión…">${esc(f.descripcion)}</textarea>
      <button id="micro" class="micro" aria-label="Dictar">${ICONO.micro}</button>
      <div id="estado-micro" class="estado-micro">${SR ? 'Pulsa para dictar' : 'Dictado no disponible en este navegador'}</div>
      <div id="zona-audio">${audio ? `
        <div class="caja ${f.pendienteTranscribir ? 'aviso' : ''}">
          <b>Audio grabado</b>${f.pendienteTranscribir ? ' · pendiente de transcribir' : ''}
          <audio controls src="${urlDe(audio)}"></audio>
          <div class="fila" style="margin-top:8px">
            ${f.pendienteTranscribir ? '<button id="transcrito" class="btn peq">Ya está transcrito</button>' : ''}
            <button id="borrar-audio" class="btn peq peligro">Borrar audio</button>
          </div>
        </div>` : ''}
      </div>
      <p class="ayuda" id="ayuda-audio"></p>
      <div class="pila" style="margin-top:20px">
        ${editable ? `<button id="otra" class="btn primario grande">${ICONO.camara} Guardar y otra foto</button>` : ''}
        <a class="btn" href="#/visita/${vid}">Guardar y volver</a>
        <button id="grabar" class="btn">${ICONO.micro} ${audio ? 'Volver a grabar audio' : 'Grabar solo audio (sin transcribir)'}</button>
        <button id="eliminar" class="btn peligro">Eliminar esta foto</button>
      </div>
    </main>`;

  const ta = $('#desc');
  const estado = $('#estado-micro');
  const boton = $('#micro');

  let temporizador;
  const guardarTexto = () => {
    clearTimeout(temporizador);
    temporizador = setTimeout(async () => {
      const act = await DB.get('visitas', vid);
      const fa = act.fotos.find(x => x.id === fid);
      if (!fa || fa.descripcion === ta.value) return;
      fa.descripcion = ta.value;
      await guardarVisita(act);
    }, 400);
  };
  ta.addEventListener('input', guardarTexto);
  ta.addEventListener('blur', guardarTexto);

  const pararTodo = async () => {
    if (Dictado.activo) Dictado.parar();
    if (Grabadora.activa) await terminarGrabacion();
  };

  boton.onclick = () => {
    if (!SR) return aviso('Usa Chrome en Android para dictar, o el micrófono del teclado.', 'error');
    if (Dictado.activo) { Dictado.parar(); return; }
    Dictado.iniciar(ta, guardarTexto, (e, detalle) => {
      if (e === 'escuchando') {
        boton.classList.add('activo'); boton.innerHTML = ICONO.parar;
        estado.textContent = navigator.onLine ? 'Escuchando… pulsa para terminar' : 'Escuchando (sin conexión)…';
      } else {
        boton.classList.remove('activo'); boton.innerHTML = ICONO.micro;
        estado.textContent = 'Pulsa para dictar';
        if (e === 'error') {
          const sinRed = ['network', 'language-not-supported', 'service-not-allowed'].includes(detalle);
          estado.textContent = sinRed
            ? 'Sin cobertura para transcribir: usa «Grabar solo audio».'
            : detalle === 'not-allowed' ? 'Permite el uso del micrófono en el navegador.' : 'Error de dictado: ' + detalle;
          if (sinRed) $('#grabar').classList.add('primario');
        }
      }
    });
  };

  async function terminarGrabacion() {
    const blob = await Grabadora.parar();
    const act = await DB.get('visitas', vid);
    const fa = act.fotos.find(x => x.id === fid);
    if (fa.drive?.audio) { (act.drive.papelera ||= []).push(fa.drive.audio); fa.drive.audio = null; }
    fa.audio = true;
    fa.tipoAudio = blob.type;
    fa.pendienteTranscribir = !ta.value.trim();
    await DB.put('blobs', blob, fid + ':audio');
    await guardarVisita(act);
    render();
  }

  $('#grabar').onclick = async () => {
    if (Grabadora.activa) return terminarGrabacion();
    if (Dictado.activo) Dictado.parar();
    try {
      await Grabadora.iniciar();
      $('#grabar').innerHTML = `${ICONO.parar} Terminar grabación`;
      $('#grabar').classList.add('peligro');
      estado.textContent = 'Grabando audio…';
    } catch (e) { aviso('No se pudo usar el micrófono: ' + e.message, 'error'); }
  };

  $('#transcrito')?.addEventListener('click', async () => {
    const act = await DB.get('visitas', vid);
    act.fotos.find(x => x.id === fid).pendienteTranscribir = false;
    await guardarVisita(act);
    render();
  });

  $('#borrar-audio')?.addEventListener('click', async () => {
    if (!confirm('¿Borrar el audio de esta foto?')) return;
    const act = await DB.get('visitas', vid);
    const fa = act.fotos.find(x => x.id === fid);
    if (fa.drive?.audio) { (act.drive.papelera ||= []).push(fa.drive.audio); fa.drive.audio = null; }
    fa.audio = false;
    fa.pendienteTranscribir = false;
    await DB.borrar('blobs', fid + ':audio');
    await guardarVisita(act);
    render();
  });

  $('#otra')?.addEventListener('click', async () => {
    pedirFoto(vid, false); // primero, para no perder el gesto del usuario
    await pararTodo();
    guardarTexto();
  });

  $('#eliminar').onclick = async () => {
    if (!(await eliminarFoto(vid, fid, pararTodo))) return;
    location.hash = `#/visita/${vid}`;
  };
}

// Borra la foto con su texto y audio, y renumera las siguientes para que no queden huecos.
// Lo que ya estaba en Drive va a la papelera y se renombra en la próxima sincronización.
async function eliminarFoto(vid, fid, antes) {
  const v = await DB.get('visitas', vid);
  const i = v.fotos.findIndex(x => x.id === fid);
  if (i < 0) return false;
  const f = v.fotos[i];
  const siguientes = v.fotos.length - i - 1;
  const texto = `¿Eliminar ${nFoto(f.n)} y su descripción?` +
    (siguientes ? `\n\nLas fotos posteriores se renumeran: ${nFoto(f.n + 1)} pasará a ser ${nFoto(f.n)}, etc.` : '');
  if (!confirm(texto)) return false;
  if (antes) await antes();
  v.drive ||= {};
  for (const id of [f.drive?.img, f.drive?.marca, f.drive?.audio]) if (id) (v.drive.papelera ||= []).push(id);
  v.fotos.splice(i, 1);
  v.fotos.forEach((x, j) => { x.n = j + 1; });
  await borrarFotoLocal(fid);
  await guardarVisita(v);
  aviso(`${nFoto(f.n)} eliminada.`);
  return true;
}

async function vistaAjustes() {
  const cid = await idCliente();
  let espacio = '';
  try {
    const e = await navigator.storage.estimate();
    const persistente = await navigator.storage.persisted?.();
    espacio = `${(e.usage / 1048576).toFixed(0)} MB usados en el móvil${persistente ? ' · almacenamiento protegido' : ''}`;
  } catch { /* no disponible */ }
  const subidas = (await DB.todos('visitas')).filter(v => v.sync === 'subida' && v.estado === 'cerrada');

  app.innerHTML = `
    <header class="barra"><a class="icono" href="#/" aria-label="Volver">←</a><h1>Ajustes</h1></header>
    <main>
      <h2>Google Drive</h2>
      <label for="cid">ID de cliente de Google</label>
      <input id="cid" type="text" value="${esc(cid)}" placeholder="xxxx.apps.googleusercontent.com">
      <p class="ayuda">Se obtiene una sola vez en Google Cloud (ver README). La app solo puede ver
        los archivos que ella misma crea en la carpeta <b>${esc(CFG.DRIVE_ROOT)}</b>.</p>
      <div class="pila" style="margin-top:12px">
        <button id="guardar-cid" class="btn">Guardar y conectar con Drive</button>
      </div>

      <h2>Fotografías</h2>
      <label class="interruptor"><input id="marca-def" type="checkbox" ${(await marcaPorDefecto()) ? 'checked' : ''}>
        <span>Fecha y hora impresas por defecto<small>Valor inicial en cada visita nueva; se puede cambiar en cada una.
          El original sin marca, con sus metadatos, se guarda siempre.</small></span></label>

      <h2>Dictado sin cobertura</h2>
      <p class="ayuda" style="margin-top:0">Descarga el modelo de voz en español al móvil para poder transcribir
        en obra sin conexión (Chrome reciente en Android). Hazlo con wifi.</p>
      <div class="pila" style="margin-top:12px"><button id="offline" class="btn">Preparar dictado sin conexión</button></div>
      <p id="res-offline" class="ayuda"></p>

      <h2>Espacio</h2>
      <p class="ayuda" style="margin-top:0">${espacio}</p>
      <div class="pila" style="margin-top:12px">
        <button id="liberar" class="btn" ${subidas.length ? '' : 'disabled'}>
          Borrar del móvil ${subidas.length} visita(s) cerrada(s) ya subida(s)</button>
      </div>
    </main>`;

  $('#guardar-cid').onclick = async () => {
    const valor = $('#cid').value.trim();
    await ajuste.poner('clientId', valor);
    if (!valor) return aviso('ID de cliente borrado.');
    Drive.token = null;
    await sincronizar(true);
  };
  $('#marca-def').onchange = e => ajuste.poner('marcaAgua', e.target.checked);
  $('#offline').onclick = async () => {
    $('#res-offline').textContent = 'Comprobando…';
    $('#res-offline').textContent = await Dictado.prepararSinConexion();
  };
  $('#liberar').onclick = async () => {
    if (!confirm(`Se borrarán del móvil ${subidas.length} visita(s). Siguen completas en Drive. ¿Continuar?`)) return;
    for (const v of subidas) {
      for (const f of v.fotos) await borrarFotoLocal(f.id);
      await DB.borrar('visitas', v.id);
    }
    aviso('Espacio liberado.', 'ok');
    render();
  };
}

/* ---------- enrutado ---------- */

async function render() {
  if (Dictado.activo) Dictado.parar();
  urlsTemporales.forEach(URL.revokeObjectURL);
  urlsTemporales = [];
  const [, ruta, a, b] = (location.hash || '#/').split('/');
  try {
    if (ruta === 'nueva') await vistaNueva();
    else if (ruta === 'visita') await vistaVisita(a);
    else if (ruta === 'foto') await vistaFoto(a, b);
    else if (ruta === 'ajustes') await vistaAjustes();
    else await vistaInicio();
  } catch (e) {
    console.error(e);
    app.innerHTML = `<main><p class="falta">Error: ${esc(e.message)}</p><a class="btn" href="#/">Volver al inicio</a></main>`;
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
window.addEventListener('online', () => { if (location.hash === '' || location.hash === '#/') render(); sincronizar(false); });
window.addEventListener('offline', () => { if (location.hash === '' || location.hash === '#/') render(); });

(async function inicio() {
  // Pide al navegador que no borre las fotos guardadas si el móvil anda justo de espacio.
  try { await navigator.storage?.persist?.(); } catch { /* no disponible */ }
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (navigator.onLine) Drive.cargarGIS().catch(() => {});
  render();
})();
