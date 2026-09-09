"""Pinkmo optional offline worker. No network, no access to pet settings.

Protocol v1: 24 RGB frame-NN.png files -> 1920x1280 RGBA sheet.png.
The algorithm matches reports/matting-2026-09-05/evaluate.py (fine matting).
"""
import argparse
import gc
import json
import os
from pathlib import Path
import sys
import traceback


def progress(job, stage, current=0, **extra):
    temporary = job / 'progress.tmp'
    temporary.write_text(json.dumps(dict(stage=stage, current=current, total=24, **extra)), encoding='utf-8')
    os.replace(temporary, job / 'progress.json')


def despill_background_colour(foreground, alpha, background, np):
    """Remove a saturated backdrop tint left inside an otherwise valid matte.

    Alpha stays untouched: this is deliberately a colour-only correction for
    fine fur edges and tiny enclosed gaps that a segmentation model can mark
    fully opaque.  It is derived from the actual corner background rather than
    assuming green or blue.
    """
    background_brightness = np.linalg.norm(background)
    if background_brightness < .08 or background.max() - background.min() < .08:
        return foreground
    background_direction = background / background_brightness
    brightness = np.linalg.norm(foreground, axis=2)
    direction = foreground / np.maximum(brightness[..., None], 1e-6)
    # This is intentionally stricter than the prop detector. It only catches
    # pixels that still look strongly like the sampled backdrop, not dark fur.
    spill = ((alpha > .04)
             & (brightness > .12)
             & ((foreground.max(axis=2) - foreground.min(axis=2)) > .07)
             & (direction @ background_direction > .965))
    if spill.any():
        luminance = (.2126 * foreground[:, :, 0]
                     + .7152 * foreground[:, :, 1]
                     + .0722 * foreground[:, :, 2])
        foreground[spill] = luminance[spill, None]
    return foreground


def process(job, model, preserve_props=False):
    # Must be set BEFORE importing Numba. The cache lives only in component data.
    os.environ['NUMBA_CACHE_DIR'] = str(job.parent.parent / 'numba-cache')
    os.environ['NUMBA_NUM_THREADS'] = '4'
    os.environ['OMP_NUM_THREADS'] = '4'
    import numpy as np
    import onnxruntime as ort
    ort.disable_telemetry_events()
    from PIL import Image
    from scipy.ndimage import binary_dilation, binary_erosion, gaussian_filter, label
    from scipy.special import expit
    from pymatting import estimate_alpha_cf, estimate_foreground_ml

    Image.MAX_IMAGE_PIXELS = 1280 * 1280
    progress(job, 'loading')
    options = ort.SessionOptions()
    options.intra_op_num_threads = 4
    options.inter_op_num_threads = 1
    # Avoid retaining a multi-GB CPU arena between frames; quality is unchanged.
    options.enable_cpu_mem_arena = False
    options.enable_mem_pattern = False
    engine = ort.InferenceSession(str(model), sess_options=options, providers=['CPUExecutionProvider'])
    bounds, dimensions = [], None
    for index in range(24):
        progress(job, 'matting', index)
        with Image.open(job / f'frame-{index:02}.png') as source:
            if source.width > 1280 or source.height > 1280:
                raise ValueError('画面过大，请重新导入视频')
            image = source.convert('RGB')
        if dimensions is not None and image.size != dimensions:
            raise ValueError('视频帧尺寸不一致')
        dimensions = image.size
        tensor = np.asarray(image.resize((1024, 1024), Image.Resampling.BILINEAR), dtype=np.float32) / 255
        tensor = (tensor - np.array([.485, .456, .406], dtype=np.float32)) / np.array([.229, .224, .225], dtype=np.float32)
        logits = engine.run(None, {'input_image': tensor.transpose(2, 0, 1)[None]})[0][0, 0]
        mask = Image.fromarray(expit(logits).astype(np.float32))
        alpha = np.clip(np.asarray(mask.resize(image.size, Image.Resampling.BILINEAR)), 0, 1).astype(np.float64)
        rgb = np.asarray(image, dtype=np.float64) / 255
        fg = binary_erosion(alpha > .96, iterations=3)
        bg = binary_erosion(alpha < .04, iterations=3, border_value=1)
        if not fg.any() or not bg.any():
            raise ValueError(f'第 {index + 1} 帧没有识别到完整主体和背景，请换一段画面更清楚的视频')
        trimap = np.full(alpha.shape, .5)
        trimap[fg], trimap[bg] = 1, 0
        alpha = estimate_alpha_cf(rgb, trimap)
        height, width = alpha.shape
        edge = max(12, round(min(height, width) * .06))
        corners = np.concatenate((rgb[:edge, :edge].reshape(-1, 3), rgb[:edge, -edge:].reshape(-1, 3),
                                  rgb[-edge:, :edge].reshape(-1, 3), rgb[-edge:, -edge:].reshape(-1, 3)))
        background = np.median(corners, axis=0)
        if preserve_props:
            # The model deliberately identifies the main animal. A bowl or toy
            # can therefore vanish between frames unless the user opts in to
            # retaining nearby props against the recommended single-colour set.
            background_direction = background / max(np.linalg.norm(background), 1e-6)
            brightness = np.linalg.norm(rgb, axis=2)
            direction = rgb / np.maximum(brightness[..., None], 1e-6)
            # Lighting can change background brightness but not its hue.
            background_like = (direction @ background_direction > .980) & (brightness > .10)
            candidates, count = label(~background_like)
            # Props such as a food bowl or a keyboard can sit beside a paw
            # rather than touching the animal matte.  Keep a deliberately
            # wider local neighbourhood, while still requiring the separate
            # component to differ from the sampled flat background.
            near_animal = binary_dilation(alpha > .25, iterations=max(48, round(min(height, width) * .18)))
            keep = np.zeros_like(alpha, dtype=bool)
            for component in range(1, count + 1):
                member = candidates == component
                if member.sum() >= 80 and (member & near_animal).any():
                    keep |= member
            # Feather only the opted-in prop mask; AI alpha remains responsible
            # for the cat's fur and whiskers.
            alpha = np.maximum(alpha, gaussian_filter(keep.astype(np.float64), sigma=.7))
        foreground = estimate_foreground_ml(rgb, alpha)
        foreground = despill_background_colour(foreground, alpha, background, np)
        result = Image.fromarray(np.uint8(np.clip(np.dstack((foreground, alpha)), 0, 1) * 255))
        box = result.getchannel('A').getbbox()
        if box is None:
            raise ValueError(f'第 {index + 1} 帧未识别到宠物')
        bounds.append(box)
        result.save(job / f'cutout-{index:02}.png')
        del tensor, logits, mask, alpha, rgb, fg, bg, trimap, foreground, result, image
        gc.collect()
    del engine
    gc.collect()
    progress(job, 'composing', 24)
    # One union crop for the whole action: no per-frame resizing/jitter.
    box = (max(0, min(b[0] for b in bounds) - 24), max(0, min(b[1] for b in bounds) - 24),
           min(dimensions[0], max(b[2] for b in bounds) + 24), min(dimensions[1], max(b[3] for b in bounds) + 24))
    sheet = Image.new('RGBA', (1920, 1280))
    for index in range(24):
        with Image.open(job / f'cutout-{index:02}.png') as source:
            pet = source.crop(box).convert('RGBa')
            pet.thumbnail((298, 298), Image.Resampling.LANCZOS)
            pet = pet.convert('RGBA')
        sheet.alpha_composite(pet, ((index % 6) * 320 + (320 - pet.width) // 2,
                                   (index // 6) * 320 + (320 - pet.height) // 2))
    sheet.save(job / 'sheet.png')
    progress(job, 'done', 24)


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--job', type=Path, required=True)
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--preserve-props', action='store_true')
    args = parser.parse_args()
    try:
        process(args.job, args.model, args.preserve_props)
    except Exception as error:
        traceback.print_exc()
        progress(args.job, 'error', error=str(error))
        sys.exit(1)
