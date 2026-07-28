/* Verificador de Precios: la cáscara de la app se cachea para abrir al
   instante; los datos de precios van SIEMPRE a la red primero (frescura),
   con caché como respaldo si la señal del cliente falla un momento. */

const CACHE = "verificador-precios-v2";
const ARCHIVOS = ["./", "index.html", "estilos.css", "app.js",
                  "manifest.json", "icono-192.png", "icono-512.png",
                  "zxing.min.js"];

self.addEventListener("install", (ev) => {
  ev.waitUntil(caches.open(CACHE)
    .then((c) => Promise.allSettled(ARCHIVOS.map((a) => c.add(a))))
    .then(() => self.skipWaiting()));
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== CACHE)
                              .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener("fetch", (ev) => {
  if (ev.request.method !== "GET") return;
  ev.respondWith(
    fetch(ev.request).then((resp) => {
      if (resp && resp.ok) {
        const copia = resp.clone();
        caches.open(CACHE).then((c) => c.put(ev.request, copia));
      }
      return resp;
    }).catch(() => caches.match(ev.request))
  );
});
