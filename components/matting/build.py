"""Build an optional self-contained component; never bundled into Pinkmo.app."""
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import zipfile

MODEL_SHA = '5600024376f572a557870a5eb0afb1e5961636bef4e1e22132025467d0f03333'
ROOT = Path(__file__).resolve().parent


def sha(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--model', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if sha(args.model) != MODEL_SHA:
        raise ValueError('BiRefNet model checksum mismatch')
    target = {'Darwin': 'macos', 'Windows': 'windows'}[platform.system()]
    arch = {'arm64': 'arm64', 'aarch64': 'arm64', 'AMD64': 'x64', 'x86_64': 'x64'}[platform.machine()]
    asset = f'pinkmo-matting-v1-{target}-{arch}'
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='pinkmo-component-') as temporary:
        temp = Path(temporary)
        subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--onedir', '--noupx',
            '--name', 'pinkmo-matting', '--distpath', str(temp / 'dist'), '--workpath', str(temp / 'build'),
            '--specpath', str(temp), '--additional-hooks-dir', str(ROOT / 'hooks'),
            '--collect-all', 'pymatting', '--collect-all', 'onnxruntime',
            '--collect-all', 'numba', '--collect-all', 'llvmlite', str(ROOT / 'worker.py')], check=True)
        bundle = temp / 'dist' / 'pinkmo-matting'
        shutil.copy2(args.model, bundle / 'model.onnx')
        # Ship dependency notices, including full package license files.
        notices = bundle / 'licenses'
        notices.mkdir()
        shutil.copy2(ROOT / 'THIRD_PARTY.md', notices / 'THIRD_PARTY.md')
        shutil.copy2(ROOT / 'BiRefNet-LICENSE.txt', notices / 'BiRefNet-LICENSE.txt')
        for name in ('numpy', 'onnxruntime', 'pillow', 'scipy', 'pymatting', 'numba', 'llvmlite', 'pyinstaller'):
            dist = importlib.metadata.distribution(name)
            for entry in dist.files or []:
                if any(word in str(entry).lower() for word in ('license', 'copying', 'notice')):
                    source = Path(dist.locate_file(entry))
                    if source.is_file():
                        destination = notices / name / str(entry).replace('..', '_')
                        destination.parent.mkdir(parents=True, exist_ok=True)
                        shutil.copy2(source, destination)
        metadata = {'protocol': 1, 'platform': f'{target}-{arch}', 'modelSha256': MODEL_SHA}
        (bundle / 'component.json').write_text(json.dumps(metadata), encoding='utf-8')
        archive = args.output / f'{asset}.zip'
        with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as output:
            for path in sorted(bundle.rglob('*')):
                if path.is_file():
                    # Dereference PyInstaller symlinks so safe extraction need not support links.
                    output.write(path.resolve(), str(path.relative_to(bundle)))
        manifest = dict(metadata, size=archive.stat().st_size, sha256=sha(archive), filename=archive.name)
        (args.output / f'{asset}.json').write_text(json.dumps(manifest, indent=2), encoding='utf-8')
        print(json.dumps(manifest), flush=True)


if __name__ == '__main__':
    main()
