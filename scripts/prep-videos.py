#!/usr/bin/env python3
"""
Compress the chosen product video for each product, ready for Cloudinary.

Picks the 16:9 LANDSCAPE master per product — the 1:1 and 9:16 cuts in
Brand Videos/ are Instagram/Blinkit formats and would letterbox in the PDP
gallery.

CRF 26 at 1080p: measured 73MB -> 11MB on Guppy with no visible difference
(compared frame-by-frame). Sources are 19-92MB, which at a realistic play rate
would exhaust the Cloudinary free tier in weeks.

Written in Python, not bash: the source filenames contain spaces and
parentheses ("DBSFL (2).mp4") which a shell read-loop mangles.
"""
import subprocess, pathlib, sys

ROOT = pathlib.Path(__file__).parent
SRC  = ROOT.parent / 'Brand Videos'
OUT  = ROOT / 'video-web'
OUT.mkdir(exist_ok=True)

# One landscape master per product. C4 and C5 share the Cichlid Bites film.
MAP = {
    'betta-bites':      'Betta bites/betta 20g_.mp4',
    'cichlid-bites-c4': 'Cichlid/cichlid video.mp4',
    'cichlid-bites-c5': 'Cichlid/cichlid video.mp4',
    'dried-bsf-larvae': 'DBSFL/DBSFL (2).mp4',
    'goldfish-bites':   'Gold Fish Bites/Golfish bites.mp4',
    'guppy-bites':      'Guppy bites/Guppy bites A+.mp4',
    'koi-bites':        'Koi bites/Zewa koi bites new video final.mp4',
    'micro-pellets':    'Micropellets/micropellet (2).mp4',
    'pleco-bites':      'Pleco Bites/Pleco.mp4',
    'shrimp-grazers':   'Shrimp Grazers/Zewa Shrimp-_3.mp4',
}

mb = lambda p: p.stat().st_size / 1024 / 1024

for slug, rel in MAP.items():
    src, dst = SRC / rel, OUT / f'{slug}.mp4'
    if not src.exists():
        print(f'  MISSING  {rel}'); continue
    if dst.exists():
        print(f'  {slug:<20} already done ({mb(dst):.1f} MB)'); continue
    subprocess.run([
        '/opt/homebrew/bin/ffmpeg','-y','-i',str(src),
        '-c:v','libx264','-crf','26','-preset','slow','-vf','scale=1920:-2',
        '-c:a','aac','-b:a','96k','-movflags','+faststart', str(dst),
    ], capture_output=True)
    if dst.exists():
        print(f'  {slug:<20} {mb(src):6.1f} MB -> {mb(dst):5.1f} MB')
    else:
        print(f'  {slug:<20} FAILED')

total = sum(mb(p) for p in OUT.glob('*.mp4'))
print(f'\n  {len(list(OUT.glob("*.mp4")))} videos, {total:.1f} MB total')
