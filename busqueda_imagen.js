/* Búsqueda por foto — Shopping Asia · corre 100% en el navegador (CLIP vía
   transformers.js). Encuentra el SKU y llama a window.consultar(sku) para
   mostrar la ficha de siempre. El índice vive en /indice/ (aparte de /datos/,
   que la sincronización de precios limpia). No modifica app.js. */
import { AutoProcessor, CLIPVisionModelWithProjection, RawImage, env }
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

let listo = false, cargando = null;
let processor, vision, SKUS = [], VEC = null, DIM = 512, N = 0;

async function preparar() {
  if (listo) return;
  if (cargando) return cargando;
  cargando = (async () => {
    estado("Cargando índice…");
    const meta = await (await fetch("indice/img_meta.json", { cache: "no-cache" })).json();
    DIM = meta.dim || 512;
    SKUS = await (await fetch("indice/img_skus.json", { cache: "no-cache" })).json();
    const buf = await (await fetch("indice/img_vectores.bin", { cache: "no-cache" })).arrayBuffer();
    VEC = new Int8Array(buf); N = SKUS.length;
    estado("Preparando la búsqueda… (descarga inicial, una sola vez)");
    processor = await AutoProcessor.from_pretrained("Xenova/clip-vit-base-patch32");
    vision = await CLIPVisionModelWithProjection.from_pretrained(
      "Xenova/clip-vit-base-patch32", { quantized: true });
    listo = true;
    estado("Sacá o elegí una foto del producto.");
  })();
  return cargando;
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
    const url = URL.createObjectURL(file);
    $("foto-query").src = url; $("foto-query").hidden = false;
    $("foto-resultados").innerHTML = "";
    estado("Analizando la foto…");
    const image = await RawImage.fromURL(url);
    const inputs = await processor(image);
    const { image_embeds } = await vision(inputs);
    const q = Float32Array.from(image_embeds.data);
    let nrm = 0; for (let k = 0; k < DIM; k++) nrm += q[k] * q[k];
    nrm = Math.sqrt(nrm) || 1; for (let k = 0; k < DIM; k++) q[k] /= nrm;
    const sims = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let s = 0, off = i * DIM;
      for (let k = 0; k < DIM; k++) s += q[k] * VEC[off + k];
      sims[i] = s;
    }
    const idx = Array.from({ length: N }, (_, i) => i)
      .sort((a, b) => sims[b] - sims[a]).slice(0, 5);
    estado("Tocá el producto correcto para ver su precio:");
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
       </div>`;
    card.addEventListener("click", () => {
      ocultarFoto();
      if (window.consultar) window.consultar(sku);
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
