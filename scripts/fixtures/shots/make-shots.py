"""Four illustrative pictures for the demonstration record (dev-149).

Illustrations, not data: every number is the fixture's own invented
abstract (88 / 62 / 41 percent survival, three shore bands, six weeks of
logging, a ramp to reattachment failure). Drawn once here, checked in as
PNG under scripts/fixtures/shots/, and uploaded by `npm run demo:refresh`.
"""
import numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Polygon, Rectangle, Ellipse, FancyBboxPatch
from pathlib import Path

OUT = Path(__file__).parent
W, H = 16, 10  # inches at 100 dpi -> 1600x1000

PAPER = "#f6f4ef"
INK = "#1b1a17"
INK2 = "#5a5750"
INK3 = "#8a867e"
RULE = "#d9d5cc"
SAND = "#e6d9c1"
ROCK = "#a89e8e"
SEA = "#cfe3e1"
# one hue, light -> dark, for the three shore bands (high, mid, low)
BAND = ["#7fb5ae", "#3f8a82", "#14504a"]
WARM = "#b5542b"

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 15,
    "axes.edgecolor": RULE,
    "axes.labelcolor": INK2,
    "xtick.color": INK2,
    "ytick.color": INK2,
    "text.color": INK,
    "axes.facecolor": PAPER,
})


def frame(title, note):
    fig = plt.figure(figsize=(W, H), dpi=100, facecolor=PAPER)
    fig.text(0.05, 0.93, title, fontsize=24, weight="bold", color=INK, va="top")
    fig.text(0.05, 0.875, note, fontsize=15, color=INK2, va="top")
    fig.text(0.95, 0.04, "Illustration for a demonstration record", fontsize=12,
             color=INK3, ha="right")
    return fig


# 1 ── The shore, in cross-section ──────────────────────────────────────────
fig = frame("Collection site: three shore bands",
            "A rocky shore in cross-section. Loggers sat in each band for six weeks before collection.")
ax = fig.add_axes([0.05, 0.10, 0.90, 0.72])
ax.set_xlim(0, 100); ax.set_ylim(0, 60); ax.axis("off")
# sea
ax.add_patch(Rectangle((0, 0), 100, 22, color=SEA, lw=0))
for i in range(6):
    y = 21.5 - i * 3.6
    ax.plot(np.linspace(0, 100, 200), y + 0.6 * np.sin(np.linspace(0, 12, 200) + i), color="#b7d3d0", lw=1.4, zorder=1)
# rock profile
xs = np.linspace(0, 100, 400)
prof = 8 + 42 * (xs / 100) ** 1.35 + 1.4 * np.sin(xs / 3.0) + 0.8 * np.sin(xs / 1.3)
ax.add_patch(Polygon(list(zip(xs, prof)) + [(100, 0), (0, 0)], closed=True, color=ROCK, lw=0, zorder=3))
ax.add_patch(Polygon(list(zip(xs, prof)) + [(100, 0), (0, 0)], closed=True, facecolor="none", edgecolor="#7d7364", lw=2, zorder=3))
# tide lines
for y, label in [(21.5, "High tide"), (10, "Low tide")]:
    ax.plot([0, 100], [y, y], ls=(0, (6, 5)), color=INK2, lw=1.2, zorder=2)
    ax.text(1.5, y + 1.2, label, fontsize=13, color=INK2, zorder=6)
# bands
bands = [(28, 46, 2), (46, 66, 1), (66, 90, 0)]
names = ["Low shore", "Mid shore", "High shore"]
for (x0, x1, k), name in zip(bands, names):
    m = (xs >= x0) & (xs <= x1)
    ax.fill_between(xs[m], prof[m], prof[m] + 2.2, color=BAND[k], lw=0, zorder=4)
    xc = (x0 + x1) / 2
    yc = np.interp(xc, xs, prof)
    ax.text(xc, yc + 6.5, name, ha="center", fontsize=15, weight="bold", color=BAND[k], zorder=6)
    ax.text(xc, yc + 4.0, "logger", ha="center", fontsize=12, color=INK2, zorder=6)
    ax.add_patch(Rectangle((xc - 1.1, yc + 2.3), 2.2, 1.4, color=INK, lw=0, zorder=6))
    # a few snails
    rng = np.random.default_rng(k + 3)
    for sx in rng.uniform(x0 + 1, x1 - 1, 7):
        sy = np.interp(sx, xs, prof)
        ax.add_patch(Ellipse((sx, sy + 0.9), 1.7, 1.1, color="#3d342c", lw=0, zorder=5))
fig.savefig(OUT / "shot-1.png", facecolor=PAPER)
plt.close(fig)

# 2 ── Six weeks of logged temperature ─────────────────────────────────────
fig = frame("Field temperature, six weeks before collection",
            "Daily maxima at each band. The high shore crossed 25 °C on most afternoons; the low shore rarely did.")
ax = fig.add_axes([0.08, 0.12, 0.87, 0.66])
days = np.arange(42)
rng = np.random.default_rng(7)
base = 17 + 2.5 * np.sin(days / 6.5)
series = {
    "High shore": base + 9 + rng.normal(0, 1.6, 42),
    "Mid shore": base + 5 + rng.normal(0, 1.2, 42),
    "Low shore": base + 1.5 + rng.normal(0, 0.9, 42),
}
ax.axhspan(25, 36, color="#f1e3d6", lw=0)
ax.text(0.5, 35.2, "above 25 °C", ha="left", va="top", fontsize=12, color=WARM)
for (name, ys), k in zip(series.items(), [0, 1, 2]):
    ax.plot(days, ys, color=BAND[k], lw=2.2)
    ax.text(42.4, ys[-1], name, va="center", fontsize=13, color=BAND[k], weight="bold")
ax.set_xlim(0, 50); ax.set_ylim(12, 36)
ax.set_xticks([0, 7, 14, 21, 28, 35, 41]); ax.set_xticklabels(["week 1", "2", "3", "4", "5", "6", "collection"])
ax.set_ylabel("Daily maximum, °C")
for s in ["top", "right"]: ax.spines[s].set_visible(False)
ax.grid(axis="y", color=RULE, lw=0.8)
fig.savefig(OUT / "shot-2.png", facecolor=PAPER)
plt.close(fig)

# 3 ── The ramp rig ────────────────────────────────────────────────────────
fig = frame("The thermal ramp",
            "Animals on a tile in a water bath, warmed at 0.3 °C per minute; the temperature at which each let go was recorded.")
ax = fig.add_axes([0.05, 0.08, 0.90, 0.74])
ax.set_xlim(0, 100); ax.set_ylim(0, 60); ax.axis("off")
# bath
ax.add_patch(FancyBboxPatch((8, 8), 56, 34, boxstyle="round,pad=0,rounding_size=2", facecolor="#dfe9e8", edgecolor=INK2, lw=2))
ax.add_patch(Rectangle((9.2, 9.2), 53.6, 26, color="#c3dcda", lw=0))
ax.text(36, 44.5, "Water bath", ha="center", fontsize=14, color=INK2)
# tile + snails
ax.add_patch(Rectangle((16, 14), 40, 3, color="#bfb6a8", lw=0))
rng = np.random.default_rng(2)
for sx in np.linspace(19, 53, 8):
    ax.add_patch(Ellipse((sx, 18.2), 3.4, 2.3, color="#3d342c", lw=0))
    ax.add_patch(Ellipse((sx + 0.6, 18.6), 1.2, 0.8, color="#6b5f52", lw=0))
ax.text(36, 11.3, "tile, 8 animals per run", ha="center", fontsize=12, color=INK2)
# heater + probe
ax.add_patch(Rectangle((10.5, 10), 3, 22, color=WARM, lw=0))
ax.text(12, 34, "heater", ha="center", fontsize=12, color=WARM)
ax.plot([58, 58], [12, 40], color=INK, lw=2)
ax.add_patch(Rectangle((56.5, 40), 3, 4, color=INK, lw=0))
ax.text(58, 46, "probe", ha="center", fontsize=12, color=INK2)
# ramp chart on the right
ax2 = fig.add_axes([0.70, 0.18, 0.26, 0.52])
t = np.linspace(0, 60, 200)
temp = 18 + 0.3 * t
ax2.plot(t, temp, color=INK, lw=2.2)
fails = [(31, 27.3), (38, 29.4), (43, 30.9), (46, 31.8), (49, 32.7), (51, 33.3), (54, 34.2)]
for tx, ty in fails:
    ax2.plot(tx, ty, "o", ms=9, color=WARM, mec=PAPER, mew=2)
ax2.text(1.5, 36.6, "each dot: one animal\nlet go of the tile", ha="left", fontsize=12, color=WARM, va="top")
ax2.set_xlabel("minutes"); ax2.set_ylabel("°C")
ax2.set_ylim(17, 37); ax2.set_xlim(0, 60)
for s in ["top", "right"]: ax2.spines[s].set_visible(False)
ax2.grid(axis="y", color=RULE, lw=0.8)
fig.savefig(OUT / "shot-3.png", facecolor=PAPER)
plt.close(fig)

# 4 ── Survival at 32 °C ────────────────────────────────────────────────────
fig = frame("Survival at 32 °C, twenty-four hours on",
            "Eighty animals per band. Survival fell from the high shore to the low shore.")
ax = fig.add_axes([0.10, 0.14, 0.60, 0.64])
names = ["High shore", "Mid shore", "Low shore"]
vals = [88, 62, 41]
bars = ax.bar(names, vals, width=0.58, color=BAND, lw=0)
for b, v in zip(bars, vals):
    ax.text(b.get_x() + b.get_width() / 2, v + 2.2, f"{v} %", ha="center", fontsize=18, weight="bold", color=INK)
ax.set_ylim(0, 100); ax.set_ylabel("Alive after 24 h, %")
for s in ["top", "right"]: ax.spines[s].set_visible(False)
ax.grid(axis="y", color=RULE, lw=0.8); ax.set_axisbelow(True)
ax.tick_params(axis="x", length=0, labelsize=15)
fig.text(0.74, 0.70, "Logged exposure above 25 °C\npredicted the temperature of\nreattachment failure better\nthan shore height alone.",
         fontsize=15, color=INK2, va="top", linespacing=1.5)
fig.text(0.74, 0.40, "Within a band, animals varied\nwidely: height predicts a\npopulation well and one\nanimal poorly.",
         fontsize=15, color=INK2, va="top", linespacing=1.5)
fig.savefig(OUT / "shot-4.png", facecolor=PAPER)
plt.close(fig)
print("done")
