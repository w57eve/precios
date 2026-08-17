# -*- coding: utf-8 -*-
"""
Galerías de producto (varios ángulos) para la búsqueda por foto — Shopping Asia.

Lee el endpoint público de catálogo del sitio (el mismo que usa la web para
listar productos por categoría) y arma un mapa:

    { SKU (codigo_articulo) : [url_1, url_2, ...] }   # hasta `max_por_sku`

Cada producto trae su galería completa en `imagenes[]` (campo `ubicacion` = URL
absoluta, `orden` = orden de la foto). Con esto el indexador suma esos ángulos
al índice, todos apuntando al mismo SKU. Si el sitio no responde, devuelve {}
y el índice sigue como siempre (una foto por producto): degrada sin romper.

No requiere credenciales: es el catálogo público.
"""
import time
import requests

BASE = "https://www.shoppingasia.com.py"
UA = {"User-Agent": "Mozilla/5.0 (IndiceGaleriaShoppingAsia)"}
PAGINA_TAM = 16          # el endpoint pagina de a ~16
MAX_PAGINAS = 4000       # tope de seguridad (evita bucles)


def _get_productos(categoria, page, timeout=30):
    params = {
        "page": page, "categoria": categoria, "precio": 0, "ordenar_por": 2,
        "marcas": "", "categorias": "", "categorias_top": "",
        "porcentajes": "", "atributos": "",
    }
    r = requests.get(BASE + "/get-productos", params=params,
                     headers=UA, timeout=timeout)
    r.raise_for_status()
    return r.json()


def _urls_de_producto(prod, max_por_sku):
    """URLs de la galería (absolutas), en orden, sin repetir, hasta el tope."""
    imgs = prod.get("imagenes") or []
    try:
        imgs = sorted(imgs, key=lambda im: im.get("orden") or 0)
    except Exception:
        pass
    urls = []
    for im in imgs:
        u = (im.get("ubicacion") or "").strip()
        if u.startswith("http") and u not in urls:
            urls.append(u)
        if len(urls) >= max_por_sku:
            break
    return urls


def galerias_de_categoria(categoria, max_por_sku=3, skus_validos=None,
                          pausa=0.15):
    """Recorre TODAS las páginas de una categoría y junta las galerías.
    skus_validos: si se pasa (set), solo se toman esos SKUs (los del catálogo
    de precios), para no indexar códigos que la app no puede mostrar."""
    out = {}
    vistos_ids = set()
    page = 1
    while page <= MAX_PAGINAS:
        try:
            data = _get_productos(categoria, page)
        except Exception as e:
            print(f"  [galerías] cat {categoria} pág {page}: error {e}",
                  flush=True)
            break
        prods = ((data or {}).get("paginacion") or {}).get("data") or []
        if not prods:
            break
        nuevos = 0
        for prod in prods:
            pid = prod.get("id")
            if pid in vistos_ids:
                continue
            vistos_ids.add(pid); nuevos += 1
            sku = str(prod.get("codigo_articulo") or "").strip()
            if not sku:
                continue
            if skus_validos is not None and sku not in skus_validos:
                continue
            urls = _urls_de_producto(prod, max_por_sku)
            if not urls:
                continue
            lst = out.setdefault(sku, [])
            for u in urls:
                if u not in lst and len(lst) < max_por_sku:
                    lst.append(u)
        # Fin: sin ítems nuevos, o página incompleta (última)
        if nuevos == 0 or len(prods) < PAGINA_TAM:
            break
        page += 1
        if pausa:
            time.sleep(pausa)
    return out


def mapa_galerias(categorias, max_por_sku=3, skus_validos=None):
    """Une las galerías de varias categorías en un solo mapa SKU -> [urls]."""
    mapa = {}
    for c in categorias:
        t0 = time.time()
        m = galerias_de_categoria(c, max_por_sku, skus_validos)
        total_urls = sum(len(v) for v in m.values())
        print(f"  [galerías] categoría {c}: {len(m)} SKUs, "
              f"{total_urls} fotos ({time.time()-t0:.0f}s)", flush=True)
        for sku, urls in m.items():
            lst = mapa.setdefault(sku, [])
            for u in urls:
                if u not in lst and len(lst) < max_por_sku:
                    lst.append(u)
    return mapa
