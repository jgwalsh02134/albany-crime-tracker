#!/usr/bin/env python3
"""Install uploaded department seals and restyle leftover agency art."""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ASSETS = Path("/home/ubuntu/.cursor/projects/workspace/assets")
OUT = Path("/workspace/public/seals")
SIZE = 512

NEW_SEALS = {
    "f330a188-f9fa-4fb2-a68b-9f3a2659f3ee.jpg": "altamont-pd",
    "5e952ada-0c29-4441-a7b8-00d8ad14c063.jpg": "cprb-albany",
    "90d82030-dc7f-42a4-a170-a9683038c397.jpg": "albany-pd",
    "dab44229-e07f-4b82-b140-befd8a5cc8a2.jpg": "albany-county-sheriff",
    "847c85a2-9149-4fe5-9dbd-ff8ebffc0482.jpg": "bethlehem-pd",
    "be2cf2a7-7fcd-4b6a-97f5-1628260a78ea.jpg": "cohoes-pd",
    "0eae2388-89bd-40e1-af7d-2ea3b6ac8fe4.jpg": "colonie-pd",
    "bbaca609-7fae-43d7-81f4-6b9799712bff.jpg": "coeymans-pd",
    "6c2a1f63-b52e-4a82-8a99-740999b29b3b.jpg": "green-island-pd",
    "c55f6b49-b928-4474-9160-b7b429ec4ee3.jpg": "guilderland-pd",
    "5cdeedce-e418-435d-b28f-3c89bbedbebb.jpg": "menands-pd",
    "a1701101-acf0-4677-930c-f9eea73f7aa5.jpg": "dec-eco-region4",
    "58e55494-57ea-43ad-a409-bf6c6386535e.jpg": "nys-park-police",
    "b70b6707-3c69-4241-a48b-307bde0cda4f.jpg": "nysp-troop-t",
    "43137bfe-fb77-4e8b-a0b7-9dcfd61d1de6.jpg": "nysp-troop-g",
    "18149ee7-e0ed-4374-9857-196f7c3f0a51.jpg": "siena-public-safety",
}

COUNTY_SRC = "14f51f21-1262-45e8-b1c0-5816fb20a981.jpg"
COUNTY_IDS = ("albany-county-probation", "albany-county-cvsvc", "albany-county-stop-dwi")
COLONIE_TOWN_SRC = "9b60ce10-e004-4d30-a850-c7e8e7c09482.png"

# Non-circular leftover agency art: trim and sit on a circular plate.
INSET_LEFTOVER = {
    "watervliet-pd": {"pad": 0.10, "plate": (255, 255, 255, 255)},
    "albany-county-e911": {"pad": 0.10, "plate": (255, 255, 255, 255)},
    "ualbany-upd": {"pad": 0.12, "plate": (255, 255, 255, 255)},
    "cdta-transit": {"pad": 0.16, "plate": (11, 31, 58, 255), "trim": "keep-white"},
    "uha-public-safety": {"pad": 0.10, "plate": (255, 255, 255, 255)},
    "albany-housing-authority": {"pad": 0.14, "plate": (255, 255, 255, 255)},
    "amtrak-police": {"pad": 0.10, "plate": (255, 255, 255, 255)},
    "usss-albany": {"pad": 0.08, "plate": (255, 255, 255, 255)},
    "watervliet-arsenal": {"pad": 0.08, "plate": (255, 255, 255, 255)},
    "nys-doccs": {"pad": 0.10, "plate": (255, 255, 255, 255)},
}


def bbox_content(im: Image.Image, mode: str = "drop-white") -> tuple[int, int, int, int] | None:
    """Bounding box of visible artwork."""
    px = im.load()
    w, h = im.size
    min_x, min_y, max_x, max_y = w, h, -1, -1
    for y in range(h):
        for x in range(w):
            r, g, b, a = px[x, y]
            if a < 12:
                continue
            if mode == "keep-white":
                # White / light strokes on a clear or pale field (CDTA).
                if r + g + b < 40 and a < 80:
                    continue
            else:
                if r > 248 and g > 248 and b > 248:
                    continue
                if r < 8 and g < 8 and b < 8 and a < 40:
                    continue
            if x < min_x:
                min_x = x
            if y < min_y:
                min_y = y
            if x > max_x:
                max_x = x
            if y > max_y:
                max_y = y
    if max_x < 0:
        return im.getbbox()
    return min_x, min_y, max_x + 1, max_y + 1


def trim(im: Image.Image, mode: str = "drop-white") -> Image.Image:
    box = bbox_content(im, mode)
    return im.crop(box) if box else im


def fit_square(im: Image.Image, size: int = SIZE, bg=(0, 0, 0, 0)) -> Image.Image:
    im = im.convert("RGBA")
    box = im.getbbox()
    if box:
        im = im.crop(box)
    w, h = im.size
    side = max(w, h)
    canvas = Image.new("RGBA", (side, side), bg)
    canvas.paste(im, ((side - w) // 2, (side - h) // 2), im)
    return canvas.resize((size, size), Image.Resampling.LANCZOS)


def circular_mask(size: int) -> Image.Image:
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size - 1, size - 1), fill=255)
    return mask.filter(ImageFilter.GaussianBlur(0.4))


def apply_circle(im: Image.Image) -> Image.Image:
    im = im.convert("RGBA")
    mask = circular_mask(im.size[0])
    out = Image.new("RGBA", im.size, (0, 0, 0, 0))
    out.paste(im, (0, 0), mask)
    return out


def save_circular(im: Image.Image, dest: Path) -> None:
    dest.parent.mkdir(parents=True, exist_ok=True)
    apply_circle(fit_square(im)).save(dest, "PNG", optimize=True)


def plate_inset(src: Path, dest: Path, pad: float, plate: tuple[int, int, int, int], trim_mode: str = "drop-white") -> None:
    im = trim(Image.open(src).convert("RGBA"), trim_mode)
    canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.ellipse((1, 1, SIZE - 2, SIZE - 2), fill=plate)
    inner = int(SIZE * (1 - 2 * pad))
    fitted = fit_square(im, inner, (0, 0, 0, 0))
    origin = (SIZE - inner) // 2
    canvas.paste(fitted, (origin, origin), fitted)
    apply_circle(canvas).save(dest, "PNG", optimize=True)


def crop_da_badge(src: Path, dest: Path) -> None:
    im = Image.open(src).convert("RGBA")
    w, h = im.size
    # Drop the hanger, then circular-crop the badge face.
    im = im.crop((int(w * 0.04), int(h * 0.10), int(w * 0.96), int(h * 0.98)))
    save_circular(im, dest)


def main() -> None:
    written: list[str] = []
    for src_name, dest_id in NEW_SEALS.items():
        src = ASSETS / src_name
        dest = OUT / f"{dest_id}.png"
        save_circular(Image.open(src), dest)
        written.append(dest_id)

    county = Image.open(ASSETS / COUNTY_SRC)
    for dest_id in COUNTY_IDS:
        save_circular(county, OUT / f"{dest_id}.png")
        written.append(dest_id)
    save_circular(county, OUT / "albany-county.png")

    save_circular(Image.open(ASSETS / COLONIE_TOWN_SRC), OUT / "colonie-town.png")
    written.append("colonie-town")

    crop_da_badge(OUT / "albany-county-da.png", OUT / "albany-county-da.png")
    written.append("albany-county-da")

    for dest_id, opts in INSET_LEFTOVER.items():
        src = OUT / f"{dest_id}.png"
        if not src.exists():
            continue
        plate_inset(src, src, opts["pad"], opts["plate"], opts.get("trim", "drop-white"))
        written.append(dest_id)

    status_path = OUT / "STATUS.json"
    status = json.loads(status_path.read_text())
    by_id = {row["id"]: row for row in status}
    notes = {
        "altamont-pd": "Official circular Altamont PD seal (user-provided)",
        "cprb-albany": "Official CPRB circular seal (user-provided)",
        "albany-pd": "Official circular Albany PD seal (user-provided)",
        "albany-county-sheriff": "Official Albany County Sheriff star badge (user-provided)",
        "bethlehem-pd": "Official circular Bethlehem PD seal (user-provided)",
        "cohoes-pd": "Official circular Cohoes PD seal (user-provided)",
        "colonie-pd": "Official circular Colonie PD seal (user-provided)",
        "coeymans-pd": "Official circular Coeymans PD seal (user-provided)",
        "green-island-pd": "Official circular Green Island PD seal (user-provided)",
        "guilderland-pd": "Official circular Guilderland PD seal (user-provided)",
        "menands-pd": "Official circular Menands PD seal (user-provided)",
        "dec-eco-region4": "NYS Forest Ranger / DEC circular seal (user-provided)",
        "nys-park-police": "Official circular NYS Park Police seal (user-provided)",
        "nysp-troop-t": "NYSP Troop T circular seal (user-provided)",
        "nysp-troop-g": "NYSP Troop G circular seal (user-provided)",
        "siena-public-safety": "Siena University circular seal (user-provided)",
        "albany-county-probation": "Official County of Albany 1683 seal (leftover county agency)",
        "albany-county-cvsvc": "Official County of Albany 1683 seal (leftover county agency)",
        "albany-county-da": "DA badge circular-cropped to drop hanger",
    }
    for dest_id, note in notes.items():
        dest = OUT / f"{dest_id}.png"
        row = by_id.get(dest_id, {"id": dest_id})
        row.update(
            {
                "status": "ok",
                "width": SIZE,
                "height": SIZE,
                "bytes": dest.stat().st_size,
                "source": "user-provided official seal",
                "notes": note,
            }
        )
        by_id[dest_id] = row
    status_path.write_text(json.dumps(list(by_id.values()), indent=2) + "\n")
    print("wrote", ", ".join(sorted(set(written))))


if __name__ == "__main__":
    main()
