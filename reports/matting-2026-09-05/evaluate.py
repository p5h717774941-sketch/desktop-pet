"""Offline quality experiment. Original files and Pinkmo assets are read-only inputs."""
import argparse
import io
import json
import os
import resource
import subprocess
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
os.environ.setdefault('NUMBA_CACHE_DIR', str(ROOT / 'numba-cache'))
os.environ.setdefault('NUMBA_NUM_THREADS', '4')
os.environ.setdefault('OMP_NUM_THREADS', '4')

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw
from scipy.ndimage import binary_erosion
from scipy.special import expit
from pymatting import estimate_alpha_cf, estimate_foreground_ml

MODEL = Path('/Users/a754/Downloads/model.onnx')
NODE = '/Users/a754/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node'


def rgba(rgb, alpha):
    return Image.fromarray(np.uint8(np.clip(np.dstack((rgb, alpha)), 0, 1) * 255))


def current_baseline(image):
    frame = Image.new('RGBA', (512, 512))
    size = (512, round(image.height * 512 / image.width))
    resized = image.resize(size, Image.Resampling.BILINEAR).convert('RGBA')
    y = (512 - size[1]) // 2
    frame.paste(resized, (0, y))
    raw = subprocess.check_output([NODE, str(ROOT / 'baseline.cjs')], input=frame.tobytes())
    result = Image.frombytes('RGBA', (512, 512), raw)
    return result.crop((0, y, 512, y + size[1])).resize(image.size, Image.Resampling.LANCZOS)


def session():
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    return ort.InferenceSession(str(MODEL), sess_options=options, providers=['CPUExecutionProvider'])


def predict(image, engine):
    # Exact preprocessing and sigmoid from the model publisher's model card.
    data = np.asarray(image.resize((1024, 1024), Image.Resampling.BILINEAR), dtype=np.float32) / 255
    data = (data - np.array([.485, .456, .406], dtype=np.float32)) / np.array([.229, .224, .225], dtype=np.float32)
    logits = engine.run(None, {'input_image': data.transpose(2, 0, 1)[None]})[0][0, 0]
    alpha = Image.fromarray(expit(logits).astype(np.float32))
    return np.clip(np.asarray(alpha.resize(image.size, Image.Resampling.BILINEAR)), 0, 1).astype(np.float64)


def refine(image, alpha):
    fg = binary_erosion(alpha > .96, iterations=3)
    bg = binary_erosion(alpha < .04, iterations=3, border_value=1)
    if not fg.any() or not bg.any():
        raise ValueError('Model did not identify both foreground and background')
    trimap = np.full(alpha.shape, .5)
    trimap[fg], trimap[bg] = 1, 0
    return estimate_alpha_cf(image, trimap)


def composite_tile(cutout, box, background, size=240):
    if background == 'checker':
        back = Image.new('RGBA', (size, size), '#eee8dd')
        d = ImageDraw.Draw(back)
        for y in range(0, size, 12):
            for x in range(0, size, 12):
                if (x // 12 + y // 12) % 2 == 0:
                    d.rectangle((x, y, x + 11, y + 11), fill='#c5bdaf')
    else:
        back = Image.new('RGBA', (size, size), background)
    pet = cutout.crop(box)
    pet = pet.convert('RGBa')
    pet.thumbnail((size - 22, size - 22), Image.Resampling.LANCZOS)
    pet = pet.convert('RGBA')
    back.alpha_composite(pet, ((size - pet.width) // 2, (size - pet.height) // 2))
    return back.convert('RGB')


def comparison(name, outputs, alpha, image_size):
    ys, xs = np.where(alpha > .03)
    if not len(xs):
        raise ValueError('Empty predicted pet')
    pad = 28
    box = (max(0, int(xs.min()) - pad), max(0, int(ys.min()) - pad),
           min(image_size[0], int(xs.max()) + pad), min(image_size[1], int(ys.max()) + pad))
    canvas = Image.new('RGB', (len(outputs) * 240, 3 * 264), '#f7f1e8')
    draw = ImageDraw.Draw(canvas)
    for col, (label, pet) in enumerate(outputs.items()):
        for row, background in enumerate(('#191919', '#ffffff', 'checker')):
            draw.text((col * 240 + 8, row * 264 + 5), label, fill='#25211e')
            canvas.paste(composite_tile(pet, box, background), (col * 240, row * 264 + 24))
    canvas.save(ROOT / 'results' / f'{name}-comparison.jpg', quality=96)


def samples():
    (ROOT / 'results').mkdir(exist_ok=True)
    engine = session()
    results = []
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    for entry, f in [(entry, f) for entry in manifest for f in entry['frames']]:
        name = Path(f['path']).stem
        if (ROOT / 'results' / f'{name}-comparison.jpg').exists():
            continue
        image = Image.open(f['path']).convert('RGB')
        start = time.perf_counter()
        alpha = predict(image, engine)
        inference = time.perf_counter() - start
        np.save(ROOT / 'results' / f'{name}-alpha.npy', alpha)
        rgb = np.asarray(image, dtype=np.float64) / 255
        outputs = {'Current tool': current_baseline(image), 'AI mask only': rgba(rgb, alpha)}
        start = time.perf_counter()
        foreground = estimate_foreground_ml(rgb, alpha)
        outputs['AI + edge colors'] = rgba(foreground, alpha)
        edge_seconds = time.perf_counter() - start
        start = time.perf_counter()
        refined = refine(rgb, alpha)
        foreground_refined = estimate_foreground_ml(rgb, refined)
        outputs['AI + fine matting'] = rgba(foreground_refined, refined)
        refine_seconds = time.perf_counter() - start
        for label, result in outputs.items():
            result.save(ROOT / 'results' / f'{name}-{label.replace(" ", "_")}.png')
        comparison(name, outputs, alpha, image.size)
        result = {'frame': name, 'inference_seconds': inference, 'edge_seconds': edge_seconds,
                  'refine_seconds': refine_seconds, 'peak_rss_mb': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**2}
        results.append(result)
        print(json.dumps(result), flush=True)
        (ROOT / 'results' / 'extra-timings.json').write_text(json.dumps(results, indent=2))


def sequence():
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    entry = next(e for e in manifest if e['name'] == 'momo-groom')
    dest = ROOT / 'sequence'
    dest.mkdir(exist_ok=True)
    engine = session()
    durations = []
    for index in range(24):
        start = time.perf_counter()
        seconds = entry['duration'] * ((index + .35) / 24)
        raw = subprocess.check_output(['ffmpeg', '-v', 'error', '-ss', str(seconds), '-i', entry['source'],
                                       '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'png', '-'])
        image = Image.open(io.BytesIO(raw)).convert('RGB')
        rgb = np.asarray(image, dtype=np.float64) / 255
        alpha = predict(image, engine)
        alpha = refine(rgb, alpha)
        cutout = rgba(estimate_foreground_ml(rgb, alpha), alpha)
        cutout.save(dest / f'ai-{index:02}.png')
        current_baseline(image).save(dest / f'old-{index:02}.png')
        seconds_taken = time.perf_counter() - start
        durations.append(seconds_taken)
        print(f'Animation {index + 1}/24: {seconds_taken:.2f}s', flush=True)
    boxes = [Image.open(dest / f'ai-{i:02}.png').getbbox() for i in range(24)]
    box = (max(0, min(b[0] for b in boxes) - 24), max(0, min(b[1] for b in boxes) - 24),
           min(image.width, max(b[2] for b in boxes) + 24), min(image.height, max(b[3] for b in boxes) + 24))
    for index in range(24):
        old = Image.open(dest / f'old-{index:02}.png')
        new = Image.open(dest / f'ai-{index:02}.png')
        comparison_frame = Image.new('RGB', (640, 688), '#f7f1e8')
        draw = ImageDraw.Draw(comparison_frame)
        for row, bg in enumerate(('#191919', '#ffffff')):
            for col, (label, cutout) in enumerate((('Current tool', old), ('Local AI + fine matting', new))):
                draw.text((col * 320 + 8, row * 344 + 5), label, fill='#25211e')
                comparison_frame.paste(composite_tile(cutout, box, bg, size=320), (col * 320, row * 344 + 24))
        comparison_frame.save(dest / f'compare-{index:02}.png')
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-framerate', str(24 / entry['duration']),
                    '-i', str(dest / 'compare-%02d.png'), '-c:v', 'libx264', '-crf', '18',
                    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', str(ROOT / 'groom-comparison.mp4')], check=True)
    preview_frames = [Image.open(dest / f'compare-{i:02}.png') for i in range(24)]
    preview_frames[0].save(ROOT / 'groom-comparison.gif', save_all=True, append_images=preview_frames[1:],
                           duration=round(entry['duration'] * 1000 / 24), loop=0)
    (dest / 'timings.json').write_text(json.dumps({'seconds_per_frame': durations, 'total_seconds': sum(durations),
        'peak_rss_mb': resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1024**2, 'crop': box}, indent=2))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--sequence', action='store_true')
    args = parser.parse_args()
    if args.sequence:
        sequence()
    else:
        samples()
