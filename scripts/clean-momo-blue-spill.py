"""Bake a colour-only blue-spill cleanup into the two affected Momo sheets.

This intentionally targets the black Momo source sheets only.  It preserves
every alpha byte and sprite position, and writes recoverable originals to the
given report directory before replacing either asset.
"""
import argparse
import shutil
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
AFFECTED = ('momo-walk-right.png', 'momo-stretch.png')


def clean(path):
    original = np.asarray(Image.open(path).convert('RGBA'))
    output = np.array(original)
    rgb = output[:, :, :3].astype(np.float64)
    alpha = output[:, :, 3]
    red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    # Existing Momo sheets were made against a blue background. The cat has no
    # naturally saturated blue detail, so this catches only visible blue spill.
    spill = (alpha > 0) & (blue > red + 10) & (blue > green + 6)
    luminance = .2126 * red + .7152 * green + .0722 * blue
    rgb[spill] = luminance[spill, None]
    output[:, :, :3] = np.uint8(np.clip(np.rint(rgb), 0, 255))
    assert np.array_equal(original[:, :, 3], output[:, :, 3])
    return Image.fromarray(output), int(spill.sum())


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--report', type=Path)
    parser.add_argument('--source', type=Path)
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    if (args.source is None) != (args.destination is None):
        parser.error('--source and --destination must be used together')
    if args.source:
        args.destination.parent.mkdir(parents=True, exist_ok=True)
        cleaned, pixels = clean(args.source)
        cleaned.save(args.destination)
        print(f'{args.destination.name}: corrected {pixels} blue-spill pixels')
        return
    if not args.report:
        parser.error('--report is required when cleaning built-in assets')
    before = args.report / 'before'
    before.mkdir(parents=True, exist_ok=True)
    assets = ROOT / 'src' / 'assets'
    for name in AFFECTED:
        target = assets / name
        shutil.copy2(target, before / name)
        cleaned, pixels = clean(target)
        cleaned.save(target)
        print(f'{name}: corrected {pixels} blue-spill pixels')


if __name__ == '__main__':
    main()
