"""Prepare lossless test frames only; never modify video or app assets."""
import hashlib
import json
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent
SOURCES = {
    "momo-groom": Path("/Users/a754/Desktop/Pinkmo/坐姿舔爪.mp4"),
    "momo-yawn": Path("/Users/a754/Desktop/Pinkmo/打哈欠.mp4"),
    "momo-sleep": Path("/Users/a754/Desktop/Pinkmo/趴下睡觉.mp4"),
    "fenzai-yawn": Path("/Users/a754/Desktop/Pinkmo/粉仔素材/打哈欠.mp4"),
}


def main():
    frames = ROOT / "source-frames"
    frames.mkdir(parents=True, exist_ok=True)
    manifest = []
    contact = Image.new("RGB", (960, len(SOURCES) * 208), "#f7f1e8")
    draw = ImageDraw.Draw(contact)
    for row, (name, source) in enumerate(SOURCES.items()):
        metadata = json.loads(subprocess.check_output([
            "ffprobe", "-v", "error", "-show_entries", "format=duration",
            "-of", "json", str(source),
        ]))
        duration = float(metadata["format"]["duration"])
        entry = {"name": name, "source": str(source), "duration": duration,
                 "sha256": hashlib.sha256(source.read_bytes()).hexdigest(), "frames": []}
        for column, fraction in enumerate((0.15, 0.50, 0.85)):
            seconds = duration * fraction
            output = frames / f"{name}-{column + 1}.png"
            subprocess.run([
                "ffmpeg", "-v", "error", "-y", "-ss", str(seconds), "-i", str(source),
                "-frames:v", "1", str(output),
            ], check=True)
            with Image.open(output) as image:
                entry["frames"].append({"path": str(output), "seconds": seconds, "size": image.size})
                preview = image.convert("RGB")
                preview.thumbnail((320, 180))
                contact.paste(preview, (column * 320, row * 208 + 24))
            draw.text((column * 320 + 8, row * 208 + 6), f"{name} / {seconds:.2f}s", fill="#25211e")
        manifest.append(entry)
        print(f"Prepared {name}: 3 full-resolution frames", flush=True)
    contact.save(ROOT / "source-contact.jpg", quality=94)
    (ROOT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2))
    print(f"Manifest: {ROOT / 'manifest.json'}", flush=True)


if __name__ == "__main__":
    main()
