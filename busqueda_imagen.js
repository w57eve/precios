/* Búsqueda por foto — Shopping Asia · corre 100% en el navegador (CLIP vía
   transformers.js). Encuentra el SKU y llama a window.consultar(sku) para
   mostrar la ficha de siempre. El índice vive en /indice/ (aparte de /datos/,
   que la sincronización de precios limpia). No modifica app.js. */
import { AutoModel, AutoProcessor, RawImage, env }
  from "https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2";

env.allowLocalModels = false;          // ir directo al CDN

const $ = (id) => document.getElementById(id);
const fmtGs = (n) => "Gs. " + n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
const fragmentoDe = (sku) => {
  const l = String(sku).toLowerCase().replace(/[^a-z0-9]/g, "");
  return (l.slice(-3) || "xxx").padStart(3, "0");
};
const estado = (t) => { const e = $("foto-estado"); if (e) e.textContent = t; };
const ocultarFoto = () => { const el = $("p-foto"); if (el) el.hidden = true; };

let MODELO = "Xenova/dinov2-small";          // se toma de img_meta.json (coincide con el índice)
let listo = false, cargando = null;
let processor, red, SKUS = [], VEC = null, DIM = 768, N = 0;

async function preparar() {
  if (listo) return;
  if (cargando) return cargando;
  cargando = (async () => {
    estado("Cargando índice…");
    const meta = await (await fetch("indice/img_meta.json", { cache: "no-cache" })).json();
    DIM = meta.dim || 512;
    if (meta.modelo) MODELO = meta.modelo;   // el navegador usa SIEMPRE el modelo del índice publicado
    SKUS = await (await fetch("indice/img_skus.json", { cache: "no-cache" })).json();
    const buf = await (await fetch("indice/img_vectores.bin", { cache: "no-cache" })).arrayBuffer();
    VEC = new Int8Array(buf); N = SKUS.length;
    estado("Preparando la búsqueda… (descarga inicial, una sola vez)");
    processor = await AutoProcessor.from_pretrained(MODELO);
    red = await AutoModel.from_pretrained(MODELO);
    listo = true;
    estado("Sacá o elegí una foto del producto.");
  })();
  return cargando;
}

// ── Alinear la foto del cliente con el catálogo ──────────────────────────
// Quita el fondo (librería libre, en el navegador) y deja el producto sobre
// blanco, centrado — igual encuadre que las fotos del catálogo. Mejora mucho
// la coincidencia. Si algo falla, se usa la foto original (degrada sin romper).
let _remover = null;
async function cargarRemover() {
  if (_remover) return _remover;
  const mod = await import("https://cdn.jsdelivr.net/npm/@imgly/background-removal@1.5.8/dist/index.mjs");
  _remover = mod.removeBackground || mod.default;
  return _remover;
}
function cargarImagen(src) {
  return new Promise((ok, err) => { const im = new Image(); im.onload = () => ok(im); im.onerror = err; im.src = src; });
}
function componerBlanco(img, margen) {
  margen = margen || 0.06;
  const w = img.width, h = img.height;
  const t = document.createElement("canvas"); t.width = w; t.height = h;
  const tx = t.getContext("2d", { willReadFrequently: true }); tx.drawImage(img, 0, 0);
  let d; try { d = tx.getImageData(0, 0, w, h).data; } catch (e) { return null; }
  let mnX = w, mnY = h, mxX = 0, mxY = 0, hay = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (d[(y * w + x) * 4 + 3] > 16) { if (x < mnX) mnX = x; if (x > mxX) mxX = x; if (y < mnY) mnY = y; if (y > mxY) mxY = y; hay = true; }
  }
  if (!hay) return null;
  const cw = mxX - mnX + 1, ch = mxY - mnY + 1, lado = Math.max(cw, ch);
  const S = Math.round(lado / (1 - 2 * margen));      // lienzo cuadrado con margen simétrico
  const c = document.createElement("canvas"); c.width = S; c.height = S;
  const cx = c.getContext("2d");
  cx.fillStyle = "#fff"; cx.fillRect(0, 0, S, S);
  cx.drawImage(t, mnX, mnY, cw, ch, (S - cw) / 2, (S - ch) / 2, cw, ch);
  return c;
}
async function alinearFoto(file) {
  try {
    const rb = await cargarRemover();
    const blob = await rb(file, { model: "isnet_quint8", output: { format: "image/png" } });
    const img = await cargarImagen(URL.createObjectURL(blob));
    return componerBlanco(img);
  } catch (e) { return null; }   // sin fondo removido: se usa la foto original
}

function abrir() {
  ["p-inicio", "p-escaner", "p-resultado"].forEach(p => { const el = $(p); if (el) el.hidden = true; });
  if (window.detenerEscaner) window.detenerEscaner();
  $("p-foto").hidden = false;
  $("foto-resultados").innerHTML = "";
  $("foto-query").hidden = true;
  preparar().catch(e => estado("Error al preparar: " + e.message));
  const inp = $("foto-file"); if (inp) inp.click();   // abre cámara/galería directo
}

async function buscar(file) {
  try {
    await preparar();
    $("foto-resultados").innerHTML = "";
    estado("Quitando el fondo de la foto…");
    const alineada = await alinearFoto(file);        // canvas (producto sobre blanco) o null
    const src = alineada ? alineada.toDataURL("image/png") : URL.createObjectURL(file);
    $("foto-query").src = alineada ? alineada.toDataURL("image/jpeg", 0.9) : src;
    $("foto-query").hidden = false;
    estado("Analizando la foto…");
    const image = await RawImage.fromURL(src);
    const inputs = await processor(image);
    const out = await red(inputs);
    // Embedding = [CLS normalizado | promedio de patches normalizado], normalizado.
    // Igual que el índice: aspecto global (CLS) + detalle local (patches/líneas).
    const hs = out.last_hidden_state;
    const seq = hs.dims[1], H = hs.dims[2];
    const dd = hs.data;
    const cls = new Float32Array(H), patch = new Float32Array(H);
    for (let k = 0; k < H; k++) cls[k] = dd[k];
    for (let t = 1; t < seq; t++) { const o = t * H; for (let k = 0; k < H; k++) patch[k] += dd[o + k]; }
    for (let k = 0; k < H; k++) patch[k] /= (seq - 1);
    const norm = (a) => { let s = 0; for (const x of a) s += x * x; s = Math.sqrt(s) || 1; for (let i = 0; i < a.length; i++) a[i] /= s; };
    norm(cls); norm(patch);
    const q = new Float32Array(H * 2); q.set(cls, 0); q.set(patch, H); norm(q);
    const sims = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0, off = i * DIM;
      for (let k = 0; k < DIM; k++) s += q[k] * VEC[off + k];
      sims[i] = s;
    }
    const idx = Array.from({ length: N }, (_, i) => i)
      .sort((a, b) => sims[b] - sims[a]).slice(0, 8);
    estado("Tocá el producto correcto para ver su precio y código:");
    await render(idx, sims);
  } catch (e) {
    estado("No se pudo procesar la foto: " + e.message);
  }
}

async function infoProducto(sku) {
  try {
    const f = await (await fetch(`datos/${fragmentoDe(sku)}.json`, { cache: "no-cache" })).json();
    return f[sku] || null;
  } catch (e) { return null; }
}

async function render(idx, sims) {
  const cont = $("foto-resultados"); cont.innerHTML = "";
  const maxS = sims[idx[0]] || 1;
  for (const i of idx) {
    const sku = SKUS[i];
    const p = await infoProducto(sku);
    const nombre = p ? (p[0] || "") : "(no está en el catálogo)";
    const retail = p ? p[1] : 0, oferta = p ? p[2] : 0, foto = p ? p[3] : "";
    const precio = (oferta > 0 && oferta < retail) ? oferta : retail;
    const rel = Math.round(100 * sims[i] / (maxS || 1));
    const card = document.createElement("button");
    card.className = "foto-card"; card.type = "button";
    card.innerHTML =
      `<img src="${foto || ""}" onerror="this.style.visibility='hidden'">
       <div class="foto-info">
         <div class="foto-sim">${rel}% parecido</div>
         <div class="foto-nombre">${nombre}</div>
         <div class="foto-precio">${precio > 0 ? fmtGs(precio) : "Consultar en caja"}</div>
         <div class="foto-codigo">Código: ${sku}</div>
       </div>`;
    card.addEventListener("click", async () => {
      ocultarFoto();
      if (window.consultar) {
        await window.consultar(sku);
        const rn = $("res-nota");                 // mostrar el código en la ficha
        if (rn && !rn.textContent) rn.textContent = "Código: " + sku;
      }
    });
    cont.appendChild(card);
  }
}

/* enganches — el módulo corre con el DOM ya parseado.
   btn-comenzar y form-manual ya los cablea app.js; acá solo sumamos ocultar
   la pantalla de foto al cambiar de sección. */
const bComenzar = $("btn-comenzar"); if (bComenzar) bComenzar.addEventListener("click", ocultarFoto);
const fm = $("form-manual"); if (fm) fm.addEventListener("submit", ocultarFoto);
const bFoto = $("btn-foto"); if (bFoto) bFoto.addEventListener("click", abrir);
const inFile = $("foto-file");
if (inFile) inFile.addEventListener("change", (e) => {
  if (e.target.files && e.target.files[0]) buscar(e.target.files[0]);
});
