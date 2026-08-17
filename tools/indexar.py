#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera el índice de imágenes (CLIP) para la búsqueda por foto.
Optimizado: descarga en PARALELO y embeddings en LOTES → mucho más rápido.

Lee   : <repo>/datos/NNN.json
Escribe: <repo>/indice/img_vectores.bin, img_skus.json, img_meta.json
Caché  : $INDICE_CACHE/emb.npz  (foto->vector, para runs incrementales)

Ángulos (opcional): si <repo>/tools/galerias.json tiene {"activo": true, ...},
suma hasta N fotos por producto (los distintos ángulos de la galería del sitio)
al índice, todas apuntando al mismo SKU. Si el sitio no responde, el índice se
arma igual con la foto principal (degrada sin romper).

Modelo: openai/clip-vit-base-patch16 (= Xenova/clip-vit-base-patch16 en el navegador).
"""
import glob, io, json, os, re, sys, time
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path

import numpy as np
import requests
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
AQUI = Path(__file__).resolve().parent
DATOS = REPO / "datos"
INDICE = REPO / "indice"
CACHE = Path(os.environ.get("INDICE_CACHE") or (REPO.parent / "_cache_indice"))
_UA = {"User-Agent": "Mozilla/5.0 (IndiceImagenShoppingAsia)"}
MODELO = "openai/clip-vit-base-patch16"
MODELO_WEB = "Xenova/clip-vit-base-patch16"
METODO = "clip-b16"   # CLIP: embedding semántico proyectado (tolera fotos imperfectas)
DIM = 512             # tamaño del embedding proyectado de CLIP ViT-B/16
WORKERS = 16          # descargas en paralelo
LOTE_EMB = 32         # imágenes por pasada del modelo
CHUNK = 256           # productos por vuelta (acota memoria)
_proc = _net = None


def _modelo():
    global _proc, _net
    if _net is None:
        import torch
        from transformers import CLIPVisionModelWithProjection, AutoImageProcessor
        print(f"Cargando {MODELO}…", flush=True)
        _net = CLIPVisionModelWithProjection.from_pretrained(MODELO).eval()
        _proc = AutoImageProcessor.from_pretrained(MODELO, use_fast=False)
    return _proc, _net


def embed(pils):
    """Embedding = vector de imagen proyectado de CLIP (image_embeds),
    normalizado. Usa CLIPVisionModelWithProjection EXACTO como el navegador."""
    import torch
    nf = torch.nn.functional.normalize
    proc, net = _modelo()
    salida = []
    for i in range(0, len(pils), LOTE_EMB):
        inp = proc(images=pils[i:i + LOTE_EMB], return_tensors="pt")
        with torch.no_grad():
            out = net(**inp)                            # CLIPVisionModelOutput
        feats = nf(out.image_embeds, dim=1)             # [b, 512], igual que el navegador
        salida.append(feats.cpu().numpy().astype(np.float32))
    return np.concatenate(salida, axis=0)


def a_int8(v):
    return np.clip(np.round(v * 127), -127, 127).astype(np.int8)


def _cfg_galerias():
    """Config opcional de ángulos: tools/galerias.json.
    {"activo": bool, "categorias": [7, ...], "max_por_sku": 3}"""
    ruta = AQUI / "galerias.json"
    if not ruta.exists():
        return {}
    try:
        return json.loads(ruta.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"galerias.json ilegible: {e}", flush=True)
        return {}


def catalogo():
    """Devuelve [(sku, url), ...]. Una fila por imagen; puede haber VARIAS filas
    con el mismo SKU (los ángulos). El navegador agrupa por SKU al mostrar."""
    porsku = {}          # sku -> [urls] (principal primero), tope = cap
    skus_set = set()     # todos los SKUs del catálogo (para filtrar galerías)

    for f in sorted(glob.glob(str(DATOS / "*.json"))):
        if not re.fullmatch(r"\d{3}\.json", Path(f).name):
            continue
        d = json.loads(Path(f).read_text(encoding="utf-8"))
        for sku, v in d.items():
            skus_set.add(sku)
            foto = v[3] if isinstance(v, list) and len(v) > 3 else ""
            if foto and "placeholder" not in str(foto):
                lst = porsku.setdefault(sku, [])
                if foto not in lst:
                    lst.append(foto)

    # ── Ángulos (galerías del sitio), opcional ──
    cfg = _cfg_galerias()
    if cfg.get("activo") and cfg.get("categorias"):
        cap = int(cfg.get("max_por_sku", 3))
        try:
            sys.path.insert(0, str(AQUI))
            import galerias
            mapa = galerias.mapa_galerias(
                cfg["categorias"], max_por_sku=cap, skus_validos=skus_set)
            sumadas = 0
            for sku, urls in mapa.items():
                lst = porsku.setdefault(sku, [])
                for u in urls:
                    if len(lst) >= cap:
                        break
                    if u not in lst:
                        lst.append(u); sumadas += 1
            print(f"Ángulos sumados desde galerías: {sumadas} "
                  f"(SKUs con galería: {len(mapa)})", flush=True)
        except Exception as e:
            print(f"No se pudieron traer galerías (sigo con 1 foto/SKU): {e}",
                  flush=True)

    prods = []
    for sku, urls in porsku.items():
        for u in urls:
            prods.append((sku, u))
    prods.sort()
    return prods


def bajar(sf):
    """(sku, foto) -> (sku, foto, PIL|None). Pensado para el pool de hilos."""
    sku, foto = sf
    try:
        r = requests.get(foto, timeout=25, headers=_UA)
        if r.status_code == 200 and "image" in r.headers.get("Content-Type", ""):
            return sku, foto, Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception:
        pass
    return sku, foto, None


def cargar_emb():
    ruta = CACHE / "emb.npz"
    if not ruta.exists():
        return {}
    d = np.load(ruta, allow_pickle=True)
    # el método de embedding también forma parte de la validez del caché
    if str(d["modelo"]) != MODELO or str(d.get("metodo", "")) != METODO:
        return {}
    return {str(f): v for f, v in zip(d["fotos"], d["vecs"])}


def guardar_emb(cache):
    CACHE.mkdir(parents=True, exist_ok=True)
    np.savez(CACHE / "emb.npz", modelo=MODELO, metodo=METODO,
             fotos=np.array(list(cache.keys()), dtype=object),
             vecs=np.array(list(cache.values()), dtype=np.int8))


def main():
    lim = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 0
    prods = catalogo()
    if lim:
        prods = prods[:lim]
    emb = cargar_emb()
    print(f"Imágenes a indexar: {len(prods)} · en caché: {len(emb)} · CLIP", flush=True)

    # separar lo que ya está en caché de lo que hay que bajar
    skus, vecs, pendientes = [], [], []
    for sku, foto in prods:
        v = emb.get(foto)
        if v is not None:
            skus.append(sku); vecs.append(v)
        else:
            pendientes.append((sku, foto))
    print(f"A descargar/procesar: {len(pendientes)}", flush=True)

    t0 = time.time()
    with ThreadPoolExecutor(max_workers=WORKERS) as pool:
        for c in range(0, len(pendientes), CHUNK):
            lote = pendientes[c:c + CHUNK]
            bajados = [x for x in pool.map(bajar, lote) if x[2] is not None]
            if bajados:
                V = a_int8(embed([im for _, _, im in bajados]))
                for (sku, foto, _), v in zip(bajados, V):
                    emb[foto] = v
                    skus.append(sku); vecs.append(v)
            guardar_emb(emb)
            hechos = c + len(lote)
            vel = hechos / max(time.time() - t0, 1)
            falta = (len(pendientes) - hechos) / max(vel, 0.1) / 60
            print(f"  {hechos}/{len(pendientes)}  (índice {len(skus)}, "
                  f"{vel:.0f}/s, faltan ~{falta:.0f} min)", flush=True)

    INDICE.mkdir(parents=True, exist_ok=True)
    arr = np.array(vecs, dtype=np.int8)
    (INDICE / "img_vectores.bin").write_bytes(arr.tobytes())
    (INDICE / "img_skus.json").write_text(json.dumps(skus), encoding="utf-8")
    (INDICE / "img_meta.json").write_text(json.dumps(
        {"modelo": MODELO_WEB, "dim": DIM, "count": len(skus),
         "fecha": date.today().isoformat()}), encoding="utf-8")
    print(f"\nÍndice listo: {len(skus)} filas · {arr.nbytes/1e6:.1f} MB "
          f"· {(time.time()-t0)/60:.0f} min", flush=True)


if __name__ == "__main__":
    main()
