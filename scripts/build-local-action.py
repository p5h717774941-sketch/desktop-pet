"""Build one reviewed 24-frame Pinkmo action from a local video.

This is a maintainer helper for the same optional local AI component used by
Pinkmo.  It never changes application settings or assets by itself.
"""
import argparse
import json
from pathlib import Path
import subprocess
import time


COMPONENT = Path('/Users/a754/Library/Application Support/cc.pinkmo.pet/components/matting-v1')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--video', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--keep-props', action='store_true')
    args = parser.parse_args()
    output = args.output
    output.mkdir(parents=True, exist_ok=True)
    duration = float(subprocess.check_output([
        'ffprobe', '-v', 'error', '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1', str(args.video),
    ]))
    for index in range(24):
        timestamp = duration * ((index + 1) / 25)
        subprocess.run([
            'ffmpeg', '-v', 'error', '-y', '-ss', str(timestamp), '-i', str(args.video),
            '-frames:v', '1', str(output / f'frame-{index:02}.png'),
        ], check=True)
    command = [str(COMPONENT / 'pinkmo-matting'), '--job', str(output),
               '--model', str(COMPONENT / 'model.onnx')]
    if args.keep_props:
        command.append('--preserve-props')
    started = time.monotonic()
    with (output / 'worker.log').open('w') as log:
        process = subprocess.Popen(command, stdout=log, stderr=log)
        last = None
        while process.poll() is None:
            progress = output / 'progress.json'
            if progress.exists():
                state = json.loads(progress.read_text())
                if state != last:
                    print(json.dumps(state, ensure_ascii=False), flush=True)
                    last = state
            if time.monotonic() - started > 1800:
                process.kill()
                raise TimeoutError('AI 动作处理超过 30 分钟')
            time.sleep(1)
    if process.returncode:
        raise RuntimeError((output / 'worker.log').read_text())
    print(json.dumps({'stage': 'done', 'seconds': round(time.monotonic() - started, 1)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
