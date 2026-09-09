"""Rebuild Momo candidates using the verified optional AI worker, without installing them.
Usage: python scripts/rebuild-momo-assets.py --output /absolute/new/report/directory
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import time
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SOURCES = Path('/Users/a754/Desktop/Pinkmo')
COMPONENT = Path('/Users/a754/Library/Application Support/cc.pinkmo.pet/components/matting-v1')
ACTIONS = [('sleep', '趴下睡觉'), ('idle-sit', '坐姿待机'), ('lookaround', '好奇张望'),
           ('stretch', '伸懒腰'), ('yawn', '打哈欠'), ('walk-right', '向右走'), ('groom', '坐姿舔爪')]


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def previews(sheet, destination):
    frames = []
    contact = Image.new('RGB', (6 * 160, 4 * 180), '#191919')
    for index in range(24):
        x, y = index % 6 * 320, index // 6 * 320
        pet = sheet.crop((x, y, x + 320, y + 320))
        frame = Image.new('RGBA', (640, 320), '#191919')
        frame.paste(Image.new('RGBA', (320, 320), 'white'), (320, 0))
        frame.alpha_composite(pet, (0, 0))
        frame.alpha_composite(pet, (320, 0))
        frames.append(frame.convert('RGB'))
        tile = frame.crop((0, 0, 320, 320)).resize((160, 160), Image.Resampling.LANCZOS)
        contact.paste(tile, (index % 6 * 160, index // 6 * 180))
        ImageDraw.Draw(contact).text((index % 6 * 160 + 6, index // 6 * 180 + 162), str(index + 1), fill='white')
    frames[0].save(destination.with_suffix('.gif'), save_all=True, append_images=frames[1:], duration=167, loop=0)
    contact.save(destination.with_suffix('.jpg'), quality=95)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output
    out.mkdir(parents=True, exist_ok=True)
    (out / 'originals').mkdir(exist_ok=True)
    (out / 'candidates').mkdir(exist_ok=True)
    (out / 'jobs').mkdir(exist_ok=True)
    for key, title in ACTIONS:
        source = SOURCES / f'{title}.mp4'
        source_sha = sha(source)
        asset = f'momo-{key}.png'
        backup = out / 'originals' / asset
        if not backup.exists():
            shutil.copy2(ROOT / 'src/assets' / asset, backup)
        job = out / 'jobs' / key
        job.mkdir(exist_ok=True)
        candidate = out / 'candidates' / asset
        metadata = out / f'{key}.json'
        if metadata.exists() and candidate.exists() and json.loads(metadata.read_text())['sourceSha256'] == source_sha:
            print(f'{key}: already complete', flush=True)
            continue
        duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1', str(source)]))
        for index in range(24):
            subprocess.run(['ffmpeg', '-v', 'error', '-y', '-ss', str(duration * ((index + .35) / 24)), '-i', str(source),
                '-frames:v', '1', str(job / f'frame-{index:02}.png')], check=True)
        started = time.monotonic()
        print(f'{key}: processing 24 frames', flush=True)
        with (job / 'worker.log').open('w') as log:
            child = subprocess.Popen([str(COMPONENT / 'pinkmo-matting'), '--job', str(job), '--model', str(COMPONENT / 'model.onnx')], stdout=log, stderr=log)
            last = None
            while child.poll() is None:
                if (job / 'progress.json').exists():
                    state = json.loads((job / 'progress.json').read_text())
                    if state != last:
                        print(f'{key}: {state}', flush=True)
                        last = state
                if time.monotonic() - started > 1800:
                    child.kill(); child.wait(); raise TimeoutError(key)
                time.sleep(1)
            if child.returncode:
                raise RuntimeError(f'{key}: ' + (job / 'worker.log').read_text())
        sheet = Image.open(job / 'sheet.png').convert('RGBA')
        assert sheet.size == (1920, 1280)
        sheet.save(candidate)
        previews(sheet, out / key)
        metadata.write_text(json.dumps(dict(source=str(source), sourceSha256=source_sha, outputSha256=sha(candidate),
            seconds=time.monotonic() - started, frames=24), ensure_ascii=False, indent=2), encoding='utf-8')
        print(f'{key}: COMPLETE', flush=True)


if __name__ == '__main__':
    main()
