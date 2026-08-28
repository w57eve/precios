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

    # ── GUARDIA: nunca publicar un catálogo vacío o muy encogido ──
    # (si esto pasa, el cerebro de Kommo se queda sin productos y el bot
    # inventa; mejor abortar y conservar el _catalogo.json anterior)
    import sys
    MINIMO = 1000
    if len(cat) < MINIMO:
        sys.exit(f"ABORTADO: solo {len(cat)} productos (minimo {MINIMO}). "
                 "NO se toca _catalogo.json.")
    if out.exists():
        try:
            previo = len(json.loads(out.read_text(encoding="utf-8")))
        except Exception:
            previo = 0
        if previo and len(cat) < previo * 0.90:
            sys.exit(f"ABORTADO: {len(cat)} productos vs {previo} anteriores "
                     "(cayo mas del 10%). NO se toca _catalogo.json.")

    out.write_text(
        json.dumps(cat, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"_catalogo.json generado: {len(cat)} productos")


if __name__ == "__main__":
    main()
