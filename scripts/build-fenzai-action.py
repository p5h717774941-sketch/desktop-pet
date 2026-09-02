from pathlib import Path
import sys

from PIL import Image


if len(sys.argv) != 3:
    raise SystemExit("usage: build-fenzai-action.py <frames-dir> <output.png>")

input_dir = Path(sys.argv[1])
output_path = Path(sys.argv[2])
cell, cols, rows = 320, 6, 4


def remove_blue(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            # Remove the saturated studio blue while retaining green eyes,
            # pink paws and warm-colored props such as the food bowl. The
            # second branch also removes the dim blue halo that blue screens
            # leave around very dark fur.
            blue_dominance = blue - max(red, green)
            if (
                (blue > 72 and green > red and green - red > 9 and blue - red > 18)
                or (blue > 32 and blue_dominance > 12)
            ):
                pixels[x, y] = (0, 0, 0, 0)
            elif blue_dominance > 3:
                # Despill the remaining semi-blue pixels so dark fur does
                # not carry a cyan outline once composited on the desktop.
                pixels[x, y] = (red, green, min(255, max(red, green) + 3), alpha)
    return image


paths = sorted(input_dir.glob("frame-*.png"))
if len(paths) != 24:
    raise SystemExit(f"expected 24 frames, got {len(paths)}")

frames = [remove_blue(Image.open(path)) for path in paths]
boxes = [frame.getbbox() for frame in frames]
if any(box is None for box in boxes):
    raise SystemExit("a frame became empty after blue-screen cleanup")

left = min(box[0] for box in boxes)
top = min(box[1] for box in boxes)
right = max(box[2] for box in boxes)
bottom = max(box[3] for box in boxes)
pad_x = round((right - left) * 0.10)
pad_y = round((bottom - top) * 0.13)
left = max(0, left - pad_x)
top = max(0, top - pad_y)
right = min(frames[0].width, right + pad_x)
bottom = min(frames[0].height, bottom + pad_y)

crop_width = right - left
crop_height = bottom - top
scale = min((cell * 0.94) / crop_width, (cell * 0.82) / crop_height)
draw_width = round(crop_width * scale)
draw_height = round(crop_height * scale)
sheet = Image.new("RGBA", (cols * cell, rows * cell), (0, 0, 0, 0))

for index, frame in enumerate(frames):
    # Resize premultiplied RGBA so transparent pixels cannot create a dark
    # outline around white fur when the sprite is scaled in the WebView.
    sprite = (
        frame.crop((left, top, right, bottom))
        .convert("RGBa")
        .resize((draw_width, draw_height), Image.Resampling.LANCZOS)
        .convert("RGBA")
    )
    x = (index % cols) * cell + (cell - draw_width) // 2
    y = (index // cols) * cell + round(cell * 0.88 - draw_height)
    sheet.alpha_composite(sprite, (x, y))

output_path.parent.mkdir(parents=True, exist_ok=True)
sheet.save(output_path)
print(
    {
        "frames": len(frames),
        "crop": (left, top, right, bottom),
        "output": str(output_path),
    }
)
