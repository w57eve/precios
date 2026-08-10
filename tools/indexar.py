#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Genera el índice de imágenes (DINOv2) DENTRO del repo, para correr en GitHub
Actions (o local). No depende de la notebook.

Lee   : <repo>/datos/NNN.json   (catálogo publicado)
Escribe: <repo>/indice/img_vectores.bin, img_skus.json, img_meta.json
Caché  : $INDICE_CACHE (por defecto <repo>/_cache_indice) — NO se publica.
         emb.npz = embeddings ya calculados (foto->vector), para runs incrementales.

Modelo: facebook/dinov2-small (= Xenova/dinov2-small en el navegador).
"""
import glob, io, json, os, re, sys, time
from datetime import date
from pathlib import Path

import numpy as np
import requests
from PIL import Image

REPO = Path(__file__).resolve().parents[1]
DATOS = REPO / "datos"
INDICE = REPO / "indice"
CACHE = Path(os.environ.get("INDICE_CACHE") or (REPO.parent / "_cache_indice"))
_UA = {"User-Agent": "Mozilla/5.0 (IndiceImagenShoppingAsia)"}
MODELO = "facebook/dinov2-small"
MODELO_WEB = "Xenova/dinov2-small"
DIM = 384
_proc = _net = None


def _modelo():
    global _proc, _net
    if _net is None:
        import torch
        from transformers import AutoModel, AutoImageProcessor
        print(f"Cargando {MODELO}…", flush=True)
        _net = AutoModel.from_pretrained(MODELO).eval()
        # use_fast=False -> procesador PIL (sin torchvision) y más parecido a
        # la preprocesión de transformers.js en el navegador.
        _proc = AutoImageProcessor.from_pretrained(MODELO, use_fast=False)
    return _proc, _net


def embed(pils):
    import torch
    proc, net = _modelo()
    inp = proc(images=pils, return_tensors="pt")
    with torch.no_grad():
        emb = net(**inp).last_hidden_state[:, 0]      # token CLS
    emb = torch.nn.functional.normalize(emb, dim=1)
    return emb.cpu().numpy().astype(np.float32)


def a_int8(v):
    return np.clip(np.round(v * 127), -127, 127).astype(np.int8)


def catalogo():
    prods = []
    for f in sorted(glob.glob(str(DATOS / "*.json"))):
        if not re.fullmatch(r"\d{3}\.json", Path(f).name):
            continue
        d = json.loads(Path(f).read_text(encoding="utf-8"))
        for sku, v in d.items():
            foto = v[3] if isinstance(v, list) and len(v) > 3 else ""
            if foto and "placeholder" not in str(foto):
                prods.append((sku, foto))
    prods.sort()
    return prods


def bajar(url):
    try:
        r = requests.get(url, timeout=25, headers=_UA)
        if r.status_code == 200 and "image" in r.headers.get("Content-Type", ""):
            return Image.open(io.BytesIO(r.content)).convert("RGB")
    except Exception:
        pass
    return None


def cargar_emb():
    ruta = CACHE / "emb.npz"
    if not ruta.exists():
        return {}
    d = np.load(ruta, allow_pickle=True)
    if str(d["modelo"]) != MODELO:
        return {}
    return {str(f): v for f, v in zip(d["fotos"], d["vecs"])}


def guardar_emb(cache):
    CACHE.mkdir(parents=True, exist_ok=True)
    np.savez(CACHE / "emb.npz", modelo=MODELO,
             fotos=np.array(list(cache.keys()), dtype=object),
             vecs=np.array(list(cache.values()), dtype=np.int8))


def main():
    lim = int(sys.argv[1]) if len(sys.argv) > 1 and sys.argv[1].isdigit() else 0
    prods = catalogo()
    if lim:
        prods = prods[:lim]
    print(f"Productos con foto: {len(prods)} · DINOv2", flush=True)

    emb = cargar_emb()
    if emb:
        print(f"Caché: {len(emb)} embeddings reutilizados.", flush=True)

    skus, vecs, nuevos, t0 = [], [], 0, time.time()
    for i, (sku, foto) in enumerate(prods, 1):
        v = emb.get(foto)
        if v is None:
            im = bajar(foto)
            if im is None:
                continue
            v = a_int8(embed([im])[0])
            emb[foto] = v
            nuevos += 1
        skus.append(sku); vecs.append(v)
        if i % 500 == 0:
            guardar_emb(emb)
            vel = nuevos / max(time.time() - t0, 1)
            print(f"  {i}/{len(prods)} (indexados {len(skus)}, nuevos {nuevos}, "
                  f"{vel:.1f}/s)", flush=True)

    guardar_emb(emb)
    INDICE.mkdir(parents=True, exist_ok=True)
    arr = np.array(vecs, dtype=np.int8)
    (INDICE / "img_vectores.bin").write_bytes(arr.tobytes())
    (INDICE / "img_skus.json").write_text(json.dumps(skus), encoding="utf-8")
    (INDICE / "img_meta.json").write_text(json.dumps(
        {"modelo": MODELO_WEB, "dim": DIM, "count": len(skus),
         "fecha": date.today().isoformat()}), encoding="utf-8")
    print(f"\nÍndice listo: {len(skus)} productos · {arr.nbytes/1e6:.1f} MB", flush=True)


if __name__ == "__main__":
    main()
