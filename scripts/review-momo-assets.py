"""Momo-only edge despill and review; never changes alpha or application settings."""
import argparse
from pathlib import Path
import importlib.util
import json
from PIL import Image, ImageDraw
import numpy as np
from scipy.ndimage import distance_transform_edt

spec = importlib.util.spec_from_file_location('batch', Path(__file__).with_name('rebuild-momo-assets.py'))
batch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(batch)

parser = argparse.ArgumentParser()
parser.add_argument('directory', type=Path)
args = parser.parse_args()
root = args.directory
(root / 'cleaned').mkdir(exist_ok=True)
stats = []


def original_layout(key):
    # Retain the built-in assets' original foot anchor and padding. The tool's
    # centered preview layout must not make existing pets jump when switching actions.
    folder = root / 'jobs' / key
    frames = [Image.open(folder / f'cutout-{i:02}.png').convert('RGBA') for i in range(24)]
    boxes = [frame.getchannel('A').getbbox() for frame in frames]
    assert all(boxes)
    left, top = min(b[0] for b in boxes), min(b[1] for b in boxes)
    right, bottom = max(b[2] for b in boxes), max(b[3] for b in boxes)
    pad_x, pad_y = round((right - left) * .10), round((bottom - top) * .13)
    crop = (max(0, left - pad_x), max(0, top - pad_y),
            min(frames[0].width, right + pad_x), min(frames[0].height, bottom + pad_y))
    width, height = crop[2] - crop[0], crop[3] - crop[1]
    scale = min(320 * .94 / width, 320 * .82 / height)
    size = (round(width * scale), round(height * scale))
    result = Image.new('RGBA', (1920, 1280))
    for index, frame in enumerate(frames):
        sprite = frame.crop(crop).convert('RGBa').resize(size, Image.Resampling.LANCZOS).convert('RGBA')
        result.alpha_composite(sprite, (index % 6 * 320 + (320 - size[0]) // 2,
                                       index // 6 * 320 + round(320 * .88 - size[1])))
    return result


for key, _ in batch.ACTIONS:
    source = root / 'candidates' / f'momo-{key}.png'
    if not source.exists():
        continue
    sheet = original_layout(key)
    original = np.asarray(sheet)
    output = np.array(original)
    for index in range(24):
        x, y = index % 6 * 320, index // 6 * 320
        cell = output[y:y + 320, x:x + 320]
        rgb = cell[:, :, :3].astype(np.float64)
        alpha = cell[:, :, 3]
        assert alpha.max() > 0
        # Only the narrow outer edge of this BLACK cat. Not a generic pet filter:
        # preserve eyes, tongue, warm fur, all interior pixels, and every alpha byte.
        edge = (alpha > 0) & (distance_transform_edt(alpha >= 250) <= 3)
        red, green, blue = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
        spill = ((blue > red + 4) & (blue > green + 2)) | ((green > red + 4) & (green > blue + 2)) | ((green > red + 4) & (blue > red + 4))
        selected = edge & spill
        # The stretch source has a few saturated blue pixels between the paws.
        # They are chroma-key remnants rather than fur highlights, and can occur
        # just inside the matte instead of on its three-pixel outer edge.
        if key == 'stretch':
            selected |= (blue > red + 15) & (blue > green + 8) & (alpha > 10)
        luminance = .2126 * red + .7152 * green + .0722 * blue
        rgb[selected] = luminance[selected, None]
        cell[:, :, :3] = np.uint8(np.clip(np.rint(rgb), 0, 255))
    assert np.array_equal(original[:, :, 3], output[:, :, 3])
    clean = Image.fromarray(output)
    destination = root / 'cleaned' / source.name
    clean.save(destination)
    batch.previews(clean, root / 'cleaned' / key)
    # A closer before/after on dark and white backgrounds, first & middle frame.
    review = Image.new('RGB', (1280, 680), '#f7f1e8')
    draw = ImageDraw.Draw(review)
    for row, index in enumerate((0, 12)):
        x, y = index % 6 * 320, index // 6 * 320
        for col, (image, bg, label) in enumerate(((sheet, '#191919', 'AI'), (clean, '#191919', 'AI + edge colors'), (sheet, '#ffffff', 'AI'), (clean, '#ffffff', 'AI + edge colors'))):
            tile = Image.new('RGBA', (320, 320), bg)
            tile.alpha_composite(image.crop((x, y, x + 320, y + 320)))
            review.paste(tile.convert('RGB'), (col * 320, row * 340 + 20))
            draw.text((col * 320 + 8, row * 340 + 3), label, fill='black')
    review.save(root / 'cleaned' / f'{key}-review.jpg', quality=96)
    stats.append(dict(action=key, alphaUnchanged=True, outputSha256=batch.sha(destination)))
(root / 'cleaned' / 'verification.json').write_text(json.dumps(stats, indent=2))
