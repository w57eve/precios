# -*- coding: utf-8 -*-
"""
Genera datos/_catalogo.json: el catálogo consolidado (SKU -> [nombre, precio,
foto]) a partir de los datos/NNN.json de la app de precios.

Lo consume el CEREBRO (agente de ventas de Kommo), que lee este único archivo
público en https://precios.shoppingasia.com.py/datos/_catalogo.json

Se ejecuta solo dentro de publicar.bat, después de sincronizar los precios.
"""

import json
import re
from pathlib import Path

SITIO = Path(__file__).resolve().parents[1]   # .../sitio
DATOS = SITIO / "datos"


def main():
    cat = {}
    for f in sorted(DATOS.glob("*.json")):
        if not re.fullmatch(r"\d{3}\.json", f.name):
            continue  # saltea _catalogo.json u otros
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        for sku, v in d.items():
            if isinstance(v, list) and len(v) >= 2:
                cat[sku] = [
                    v[0] or "",
                    v[1] if len(v) > 1 else None,
                    v[3] if len(v) > 3 else "",
                ]
    out = DATOS / "_catalogo.json"
    out.write_text(
        json.dumps(cat, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"_catalogo.json generado: {len(cat)} productos")


if __name__ == "__main__":
    main()
