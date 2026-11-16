"""
Packs the tree impostor atlas (apps/web/public/trees/atlas.png + atlas.json).

Inputs: renders of CC0 Poly Haven tree models (side views and a top view each, with alpha;
made with three.js in headless Chromium) in a directory given as argv[1], with meta_all.json
(heightM, widthM per render). Poly Haven has no large broadleaved trees, so beech-, oak-,
hornbeam- and birch-like crowns are composed here from the foliage of its small broadleaved
models: clumps stacked back to front in a crown outline over a drawn trunk.

Usage: python3 pack.py <renders dir> <out dir>
"""
import json, math, random, sys
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter

src, out = sys.argv[1], sys.argv[2]
meta = json.load(open(f"{src}/meta_all.json"))
SIDE_W, TOP = 176, 144

def load(name, view):
    return Image.open(f"{src}/{name}_{view}.png").convert("RGBA")

def tone(im, bright=1.0, sat=1.0, tint=(1, 1, 1)):
    r, g, b, a = im.split()
    rgb = Image.merge("RGB", (r, g, b))
    rgb = ImageEnhance.Brightness(rgb).enhance(bright)
    rgb = ImageEnhance.Color(rgb).enhance(sat)
    r, g, b = [c.point(lambda v, k=k: min(255, int(v * k))) for c, k in zip(rgb.split(), tint)]
    return Image.merge("RGBA", (r, g, b, a))

# Foliage clumps: the crowns (upper part) of the small broadleaved models.
def clumps():
    cs = []
    for name, top in (("island_tree_01_1", 0.75), ("jacaranda_tree_2", 0.7), ("island_tree_02", 0.7), ("tree_small_02", 0.55)):
        for v in ("side0", "side1", "side2", "side3"):
            im = load(name, v)
            im = im.crop((0, 0, im.width, int(im.height * top)))
            box = im.getbbox()
            if box: cs.append(im.crop(box))
    return cs
CLUMPS = clumps()

def crown_tree(seed, w_px, h_px, trunk_frac, shape, tint, n=46, clump_frac=0.42):
    """A broadleaved tree: side view (w_px × h_px)."""
    rnd = random.Random(seed)
    S = 3  # supersample
    W, H = w_px * S, h_px * S
    im = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    cx, th = W / 2, H * trunk_frac
    # Trunk and main limbs.
    tw = W * 0.035 * (1 + 0.3 * rnd.random())
    bark = (74 + rnd.randint(-8, 8), 62 + rnd.randint(-6, 6), 50)
    d.polygon([(cx - tw, H), (cx + tw, H), (cx + tw * 0.55, H - th * 1.5), (cx - tw * 0.55, H - th * 1.5)], fill=bark + (255,))
    for k in range(5):
        a = math.radians(rnd.uniform(-55, 55)); L = H * rnd.uniform(0.08, 0.17); y0 = H - th * rnd.uniform(0.9, 1.5)
        d.line([(cx, y0), (cx + math.sin(a) * L, y0 - math.cos(a) * L)], fill=tuple(int(c * 0.85) for c in bark) + (255,), width=max(2, int(tw * 0.5)))
    # Clumps back to front: back ones darker, low ones darker, the sun from upper left.
    ch = H - th
    cy = ch * 0.5
    pts = []
    for i in range(n):
        while True:
            x, y = rnd.uniform(-1, 1), rnd.uniform(-1, 1)
            if shape(x, y): break
        pts.append((x, y))
    for i, (x, y) in enumerate(pts):
        depth = i / (n - 1)
        c = rnd.choice(CLUMPS)
        s = W * clump_frac * rnd.uniform(0.75, 1.25) / c.width
        c = c.resize((max(4, int(c.width * s)), max(4, int(c.height * s))), Image.LANCZOS)
        if rnd.random() < 0.5: c = c.transpose(Image.FLIP_LEFT_RIGHT)
        c = c.rotate(rnd.uniform(-35, 35), resample=Image.BICUBIC, expand=True)
        light = (0.5 + 0.55 * depth) * (0.82 + 0.3 * (0.5 - y * 0.5)) * (1.0 - 0.12 * x)
        c = tone(c, bright=light * rnd.uniform(0.92, 1.08), sat=0.95, tint=tint)
        px = int(cx + x * (W / 2 - c.width * 0.32) - c.width / 2)
        py = int(cy + y * (ch / 2 - c.height * 0.3) - c.height / 2)
        im.alpha_composite(c, (max(0, min(W - c.width, px)), max(0, min(H - c.height, py))))
    im = im.resize((w_px, h_px), Image.LANCZOS)
    a = im.split()[3].point(lambda v: 255 if v > 110 else 0)
    im.putalpha(a)
    return im

def crown_top(seed, px, tint, n=40):
    rnd = random.Random(seed)
    S = 3
    im = Image.new("RGBA", (px * S, px * S), (0, 0, 0, 0))
    tops = [load(nm, "top") for nm in ("island_tree_01_1", "jacaranda_tree_2", "island_tree_02")]
    tops = [t.crop(t.getbbox()) for t in tops]
    for i in range(n):
        r, a = math.sqrt(rnd.random()) * 0.78, rnd.uniform(0, 6.283)
        c = rnd.choice(tops)
        s = px * S * 0.4 * rnd.uniform(0.7, 1.2) / c.width
        c = c.resize((int(c.width * s), int(c.height * s)), Image.LANCZOS).rotate(rnd.uniform(0, 360), resample=Image.BICUBIC, expand=True)
        c = tone(c, bright=(0.6 + 0.5 * i / n) * (1.05 - 0.3 * r), tint=tint)
        x, y = int(px * S / 2 * (1 + r * math.cos(a)) - c.width / 2), int(px * S / 2 * (1 + r * math.sin(a)) - c.height / 2)
        im.alpha_composite(c, (max(0, min(px * S - c.width, x)), max(0, min(px * S - c.height, y))))
    im = im.resize((px, px), Image.LANCZOS)
    im.putalpha(im.split()[3].point(lambda v: 255 if v > 110 else 0))
    return im

ellipse = lambda x, y: x * x + y * y < 1
# Egg: wide below the middle, narrowing to the top (beech, hornbeam).
egg = lambda x, y: (x / (0.62 + 0.38 * (y + 1) / 2)) ** 2 + y * y < 1
# Narrow, drooping (birch).
narrow = lambda x, y: (x / (0.45 + 0.4 * (y + 1) / 2)) ** 2 + y * y < 1

trees = []  # name, kind, heightM, widthM, sides[Image], top Image

def composed(name, heightM, widthM, trunk, shape, tint, n, clump, seeds=3):
    hpx = min(520, int(SIDE_W * heightM / widthM))
    sides = [crown_tree(hash((name, s)) & 0xffff, SIDE_W, hpx, trunk, shape, tint, n, clump) for s in range(seeds)]
    trees.append((name, 0, heightM, widthM, sides, crown_top(hash(name) & 0xffff, TOP, tint)))

composed("beech", 27, 15, 0.26, egg, (0.82, 1.0, 0.72), 56, 0.36)
composed("oak", 21, 19, 0.2, ellipse, (0.95, 1.0, 0.7), 60, 0.34)
composed("hornbeam", 14, 9, 0.18, egg, (0.88, 1.04, 0.74), 40, 0.44)
composed("birch", 17, 8, 0.3, narrow, (1.08, 1.12, 0.82), 34, 0.4)
composed("lime", 23, 14, 0.22, ellipse, (0.9, 1.06, 0.66), 52, 0.36)

def rendered(name, kind, views, bright=1.0, tint=(1, 1, 1), sat=1.0):
    m = meta[name]
    hpx = min(540, int(SIDE_W * m["heightM"] / m["widthM"]))
    sides = []
    for v in views:
        im = tone(load(name, v), bright, sat, tint).resize((SIDE_W, hpx), Image.LANCZOS)
        im.putalpha(im.split()[3].point(lambda a: 255 if a > 110 else 0))
        sides.append(im)
    top = tone(load(name, "top"), bright, sat, tint).resize((TOP, TOP), Image.LANCZOS)
    top.putalpha(top.split()[3].point(lambda a: 255 if a > 110 else 0))
    trees.append((name, kind, m["heightM"], m["widthM"], sides, top))

for n in ("tree_small_02", "island_tree_02"): rendered(n, 0, ("side0", "side2"))
rendered("island_tree_01_1", 0, ("side0", "side1", "side2"))  # a shrub
for i in range(3): rendered(f"fir_tree_01_{i}", 1, ("side0", "side1"))
for i in range(3): rendered(f"fir_sapling_medium_{i}", 1, ("side0", "side1"), bright=1.25)
# The pine renders are very dark (thin needles against their own shade).
for i in range(3): rendered(f"pine_tree_01_{i}", 1, ("side0", "side1"), bright=1.9, tint=(0.95, 1.0, 0.85))

# Shelf packing, tallest first.
AW = 4096
items = []
for t in trees:
    for k, s in enumerate(t[4]): items.append((s.height, t[0], f"s{k}", s))
    items.append((TOP, t[0], "top", t[5]))
items.sort(key=lambda i: -i[0])
x = y = shelf = 0
place = {}
for h, name, key, im in items:
    if x + im.width + 2 > AW:
        x, y, shelf = 0, y + shelf + 2, 0
    place[(name, key)] = (x, y, im)
    x += im.width + 2
    shelf = max(shelf, h)
AH = 1 << math.ceil(math.log2(y + shelf))
atlas = Image.new("RGBA", (AW, AH), (0, 0, 0, 0))
for (name, key), (px, py, im) in place.items(): atlas.paste(im, (px, py))
# Colour bleeds into the transparent surroundings (no dark fringes when filtered).
rgb = atlas.convert("RGB")
blur = Image.composite(rgb, Image.new("RGB", atlas.size, (58, 78, 40)), atlas.split()[3])
atlas = Image.merge("RGBA", (*blur.split(), atlas.split()[3]))
atlas.save(f"{out}/atlas.png", optimize=True)
spec = {"width": AW, "height": AH, "trees": []}
for name, kind, hm, wm, sides, top in trees:
    r = lambda k, im: [place[(name, k)][0], place[(name, k)][1], im.width, im.height]
    spec["trees"].append({"name": name, "kind": kind, "heightM": round(hm, 2), "widthM": round(wm, 2), "sides": [r(f"s{k}", s) for k, s in enumerate(sides)], "top": r("top", top)})
json.dump(spec, open(f"{out}/atlas.json", "w"), indent=1)
print(AW, AH, len(trees), "trees")
