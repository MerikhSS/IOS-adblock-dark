#!/usr/bin/env python3
"""Generate app + extension icons (shield with a crescent moon). Requires Pillow."""
import json, os, sys
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

def draw_icon(size, background=True, mono=False):
    S = 1024
    im = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    if background:
        for y in range(S):  # vertical gradient
            t = y / S
            c = (int(20 + 10 * t), int(24 + 6 * t), int(48 + 40 * t), 255)
            d.line([(0, y), (S, y)], fill=c)
    fg = (0, 0, 0, 255) if mono else (255, 255, 255, 255)
    # shield
    cx, top, w, h = S // 2, int(S * 0.16), int(S * 0.58), int(S * 0.70)
    pts = [(cx - w // 2, top + 60), (cx, top), (cx + w // 2, top + 60),
           (cx + w // 2, top + int(h * 0.48)), (cx, top + h), (cx - w // 2, top + int(h * 0.48))]
    d.polygon(pts, fill=fg)
    d.ellipse([cx - w // 2, top + int(h * 0.20), cx + w // 2, top + int(h * 0.98)], fill=fg)
    d.polygon(pts, fill=fg)
    # crescent moon cut-out
    r = int(S * 0.16)
    mx, my = cx, top + int(h * 0.50)
    hole = (0, 0, 0, 0)
    moon = (20, 24, 70, 255) if background else hole
    d.ellipse([mx - r, my - r, mx + r, my + r], fill=moon)
    d.ellipse([mx - r + int(r * 0.55), my - r - int(r * 0.25), mx + r + int(r * 0.55), my + r - int(r * 0.25)], fill=fg)
    return im.resize((size, size), Image.LANCZOS)

def main():
    ext = os.path.join(ROOT, 'WebExtension/Resources/images')
    os.makedirs(ext, exist_ok=True)
    for s in (48, 96, 128, 256, 512):
        draw_icon(s).save(os.path.join(ext, f'icon-{s}.png'))
    for s in (16, 19, 32, 38, 48, 72):
        draw_icon(s, background=False, mono=True).save(os.path.join(ext, f'toolbar-{s}.png'))
    app = os.path.join(ROOT, 'App/Assets.xcassets/AppIcon.appiconset')
    os.makedirs(app, exist_ok=True)
    draw_icon(1024).convert('RGB').save(os.path.join(app, 'AppIcon-1024.png'))
    json.dump({"images": [{"filename": "AppIcon-1024.png", "idiom": "universal", "platform": "ios", "size": "1024x1024"}],
               "info": {"author": "xcode", "version": 1}}, open(os.path.join(app, 'Contents.json'), 'w'), indent=2)
    print('icons written')

if __name__ == '__main__':
    main()
