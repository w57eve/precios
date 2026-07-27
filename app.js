/* Verificador de Precios — Shopping Asia · app pública para clientes */
"use strict";

const $ = (id) => document.getElementById(id);
let pantallaActual = "p-inicio";
let stream = null;
let escaneando = false;
let detectorNativo = null;
let lector = null;
let canvas = null;
let timerVolver = null;

function mostrar(id) {
  pantallaActual = id;
  clearInterval(timerVolver);
  ["p-inicio", "p-escaner", "p-resultado"].forEach(p => $(p).hidden = (p !== id));
  if (id === "p-escaner") iniciarEscaner(); else detenerEscaner();
}

const formatearGs = (n) =>
  "Gs. " + n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");

function beep(frec, dur = 0.12) {
  try {
    const ctx = beep.ctx = beep.ctx ||
      new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = frec; g.gain.value = 0.3;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + dur);
  } catch (e) {}
}

/* ══════════════ cámara y escaneo (misma técnica probada) ══════════════ */

async function pedirCamara() {
  const intentos = [
    { video: { facingMode: "environment", width: { ideal: 1920 }, height: { ideal: 1080 } } },
    { video: { facingMode: "environment" } },
    { video: true },
  ];
  let err = null;
  for (const c of intentos) {
    for (let i = 0; i < 2; i++) {
      try { return await navigator.mediaDevices.getUserMedia(c); }
      catch (e) { err = e; await new Promise(r => setTimeout(r, 400)); }
    }
  }
  throw err;
}

async function iniciarEscaner() {
  if (escaneando) return;
  escaneando = true;
  $("msj").textContent = "Apuntá al código de barras del producto";
  try {
    stream = await pedirCamara();
    if (pantallaActual !== "p-escaner") { detenerEscaner(); return; }
    $("video").srcObject = stream;
    stream.getVideoTracks().forEach(t => {
      t.onended = () => {
        if (document.visibilityState === "visible" && pantallaActual === "p-escaner")
          setTimeout(() => { detenerEscaner(); iniciarEscaner(); }, 400);
      };
    });
    if ("BarcodeDetector" in window) {
      detectorNativo = detectorNativo || new BarcodeDetector({
        formats: ["ean_13", "ean_8", "code_128", "code_39", "upc_a", "upc_e", "itf"]
      });
      cicloNativo();
    } else if (window.ZXing) {
      if (!lector) {
        const hints = new Map();
        hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
        hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [
          ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8,
          ZXing.BarcodeFormat.CODE_128, ZXing.BarcodeFormat.CODE_39,
          ZXing.BarcodeFormat.UPC_A, ZXing.BarcodeFormat.UPC_E,
          ZXing.BarcodeFormat.ITF]);
        lector = new ZXing.MultiFormatReader();
        lector.setHints(hints);
      }
      cicloZXing();
    } else {
      $("msj").textContent = "Escribí el código acá abajo 👇";
    }
  } catch (e) {
    escaneando = false;
    $("msj").textContent = "Permití el uso de la cámara, o escribí el código abajo.";
  }
}

async function cicloNativo() {
  const video = $("video");
  while (escaneando) {
    try {
      if (video.readyState >= 2) {
        const codigos = await detectorNativo.detect(video);
        if (codigos.length) { encontrado(codigos[0].rawValue); return; }
      }
    } catch (e) {}
    await new Promise(r => setTimeout(r, 160));
  }
}

async function cicloZXing() {
  const video = $("video");
  canvas = canvas || document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  while (escaneando) {
    if (video.readyState >= 2 && video.videoWidth) {
      const vw = video.videoWidth, vh = video.videoHeight;
      canvas.width = vw * 0.84; canvas.height = vh * 0.30;
      ctx.drawImage(video, vw * 0.08, vh * 0.30, canvas.width, canvas.height,
                    0, 0, canvas.width, canvas.height);
      try {
        const lum = new ZXing.HTMLCanvasElementLuminanceSource(canvas);
        const bin = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(lum));
        const res = lector.decode(bin);
        if (res && escaneando) { encontrado(res.getText()); return; }
      } catch (e) {}
      finally { if (lector.reset) lector.reset(); }
    }
    await new Promise(r => setTimeout(r, 250));
  }
}

function detenerEscaner() {
  escaneando = false;
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && pantallaActual === "p-escaner") {
    detenerEscaner(); iniciarEscaner();
  }
});

/* ══════════════ consulta del precio (fragmentos estáticos) ══════════════ */

function fragmentoDe(sku) {
  const limpio = sku.toLowerCase().replace(/[^a-z0-9]/g, "");
  return (limpio.slice(-3) || "xxx").padStart(3, "0");
}

async function buscarProducto(sku) {
  const r = await fetch(`datos/${fragmentoDe(sku)}.json`, { cache: "no-cache" });
  if (!r.ok) return null;
  const frag = await r.json();
  return frag[sku] || null;
}

function encontrado(codigo) {
  codigo = String(codigo).trim();
  if (!/^[A-Za-z0-9._-]{3,30}$/.test(codigo)) return;
  detenerEscaner();
  if (navigator.vibrate) navigator.vibrate(50);
  beep(880);
  consultar(codigo);
}

async function consultar(sku) {
  mostrar("p-resultado");
  $("res-nombre").textContent = "Buscando…";
  $("res-precio").textContent = "";
  $("res-foto").hidden = true; $("res-sin-foto").hidden = true;
  $("res-precio-tachado").hidden = true; $("res-oferta").hidden = true;
  $("res-nota").textContent = "";

  let prod = null;
  try { prod = await buscarProducto(sku); } catch (e) {}

  if (!prod) {
    $("res-sin-foto").hidden = false;
    $("res-nombre").textContent = "Producto no encontrado";
    $("res-nota").textContent =
      "Código " + sku + " — consultá el precio en caja, con gusto te atendemos.";
    volverEnSegundos(7);
    return;
  }

  const [nombre, retail, oferta, foto] = prod;
  $("res-nombre").textContent = nombre || "Producto " + sku;

  if (foto) { $("res-foto").src = foto; $("res-foto").hidden = false; }
  else $("res-sin-foto").hidden = false;

  const hayOferta = oferta > 0 && oferta < retail;
  const precioFinal = hayOferta ? oferta : retail;
  $("res-precio").textContent = precioFinal > 0 ? formatearGs(precioFinal)
                                                : "Consultar en caja";
  $("res-precio").classList.toggle("oferta", hayOferta);
  if (hayOferta) {
    $("res-precio-tachado").textContent = formatearGs(retail);
    $("res-precio-tachado").hidden = false;
    $("res-oferta").hidden = false;
  }
  beep(1320);
  volverEnSegundos(8);
}

function volverEnSegundos(seg) {
  let resta = seg;
  const el = $("cuenta-regresiva");
  el.textContent = "";
  clearInterval(timerVolver);
  timerVolver = setInterval(() => {
    resta -= 1;
    el.textContent = "Volviendo al escáner en " + resta + "…";
    if (resta <= 0) { clearInterval(timerVolver); mostrar("p-escaner"); }
  }, 1000);
}

/* ══════════════ eventos y arranque ══════════════ */

$("btn-comenzar").onclick = () => mostrar("p-escaner");
$("btn-otro").onclick = () => mostrar("p-escaner");
$("form-manual").onsubmit = (ev) => {
  ev.preventDefault();
  const v = $("in-codigo").value.trim();
  if (v) { $("in-codigo").value = ""; detenerEscaner(); consultar(v); }
};

(async function arrancar() {
  if ("serviceWorker" in navigator) {
    try { await navigator.serviceWorker.register("sw.js"); } catch (e) {}
  }
  try {
    const meta = await (await fetch("datos/meta.json", { cache: "no-cache" })).json();
    $("fecha-datos").textContent = meta.actualizado;
  } catch (e) { $("fecha-datos").textContent = "—"; }
})();
