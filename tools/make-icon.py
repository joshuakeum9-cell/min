"""
Generates the MIN app icon.

The mark is the product's own idea: two audio tracks captured separately and
never mixed. A white bar for you, a coral bar for them, on the system's
near-black canvas. The coral is the design system's single permitted accent, so
the icon spends it in the one place a brand mark should.

Drawn at 1024 and downsampled, because Windows renders this at 16px in the
taskbar and a mark that only works large is not an icon.

Run: python tools/make-icon.py
"""

from PIL import Image, ImageDraw
import os

S = 1024
CANVAS = (11, 11, 11, 255)      # #0b0b0b
WHITE = (255, 255, 255, 255)
CORAL = (243, 100, 88, 255)     # #f36458

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded-square canvas. Windows masks icons itself, so keep the radius modest.
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=CANVAS)

# Two tracks. Unequal lengths so the mark reads as a conversation rather than
# an equals sign at small sizes.
bar_h = int(S * 0.115)
radius = bar_h // 2
left = int(S * 0.20)
gap = int(S * 0.105)
mid = S // 2

top_y = mid - gap // 2 - bar_h
bot_y = mid + gap // 2

d.rounded_rectangle([left, top_y, left + int(S * 0.60), top_y + bar_h],
                    radius=radius, fill=WHITE)
d.rounded_rectangle([left, bot_y, left + int(S * 0.42), bot_y + bar_h],
                    radius=radius, fill=CORAL)

os.makedirs("build", exist_ok=True)

img.resize((512, 512), Image.LANCZOS).save("build/icon.png")

# A real .ico carries every size Windows asks for; letting it rescale one large
# bitmap gives a muddy 16px taskbar icon.
sizes = [16, 24, 32, 48, 64, 128, 256]
img.save("build/icon.ico", sizes=[(s, s) for s in sizes])

print("build/icon.png  512x512")
print("build/icon.ico ", ", ".join(f"{s}x{s}" for s in sizes))
