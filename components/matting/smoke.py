"""Maintainer-only end-to-end check of a frozen component with a real video.
FFmpeg is used by this test only, not by the distributed app/worker.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import time
import zipfile

parser = argparse.ArgumentParser()
parser.add_argument('--archive', type=Path, required=True)
parser.add_argument('--video', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=False)
bundle = args.output / 'component'
with zipfile.ZipFile(args.archive) as archive:
    archive.extractall(bundle)
    for entry in archive.infolist():
        if entry.external_attr >> 16 & 0o111:
            (bundle / entry.filename).chmod(0o755)
meta = json.loads((bundle / 'component.json').read_text())
with (bundle / 'model.onnx').open('rb') as stream:
    assert hashlib.file_digest(stream, 'sha256').hexdigest() == meta['modelSha256']
job = bundle / 'jobs' / 'smoke'
job.mkdir(parents=True)
duration = float(subprocess.check_output(['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', str(args.video)]))
for index in range(24):
    subprocess.run(['ffmpeg', '-v', 'error', '-ss', str(duration * ((index + .35) / 24)), '-i', str(args.video),
        '-frames:v', '1', str(job / f'frame-{index:02}.png')], check=True)
exe = bundle / ('pinkmo-matting.exe' if os.name == 'nt' else 'pinkmo-matting')
started = time.monotonic()
with (args.output / 'worker.log').open('w') as log:
    process = subprocess.Popen([str(exe), '--job', str(job), '--model', str(bundle / 'model.onnx')], stderr=log, stdout=log)
    last = None
    while process.poll() is None:
        if (job / 'progress.json').exists():
            status = json.loads((job / 'progress.json').read_text())
            if status != last:
                print(status, flush=True)
                last = status
        if time.monotonic() - started > 1800:
            process.kill(); process.wait(); raise TimeoutError('worker exceeded 30 minutes')
        time.sleep(1)
    if process.returncode:
        raise RuntimeError((args.output / 'worker.log').read_text())
from PIL import Image
with Image.open(job / 'sheet.png') as sheet:
    assert sheet.size == (1920, 1280) and sheet.mode == 'RGBA'
    assert sheet.getchannel('A').getextrema() == (0, 255)
    preview = Image.new('RGB', (640, 640), '#f7f1e8')
    for index in range(4):
        pet = sheet.crop((0, 0, 320, 320))
        back = Image.new('RGBA', (320, 320), ['#191919', '#ffffff', '#8b8b8b', '#f7f1e8'][index])
        back.alpha_composite(pet)
        preview.paste(back.convert('RGB'), ((index % 2) * 320, (index // 2) * 320))
    preview.save(args.output / 'preview.png')
seconds = time.monotonic() - started
(args.output / 'result.json').write_text(json.dumps(dict(seconds=seconds, status='passed', platform=meta['platform']), indent=2))
print(f'Frozen worker passed in {seconds:.1f}s', flush=True)
