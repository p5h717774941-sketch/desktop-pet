from pathlib import Path
import sys

from PIL import Image


if len(sys.argv) not in (3, 4):
    raise SystemExit("usage: build-fenzai-action.py <frames-dir> <output.png> [cover.png]")

input_dir = Path(sys.argv[1])
output_path = Path(sys.argv[2])
cover_path = Path(sys.argv[3]) if len(sys.argv) == 4 else None
cell, cols, rows = 320, 6, 4


def remove_chroma_background(image: Image.Image) -> Image.Image:
    image = image.convert("RGBA")
    corner_points = (
        (0, 0),
        (image.width - 1, 0),
        (0, image.height - 1),
        (image.width - 1, image.height - 1),
    )
    corner_average = tuple(
        sum(image.getpixel(point)[channel] for point in corner_points) / len(corner_points)
        for channel in range(3)
    )
    screen_is_green = (
        corner_average[1] > corner_average[0] + 20
        and corner_average[1] >= corner_average[2]
    )
    pixels = image.load()
    for y in range(image.height):
        for x in range(image.width):
            red, green, blue, alpha = pixels[x, y]
            # Handle both the original studio-blue Fenzai clips and the newer
            # green-screen Momo clips.  These conditions deliberately require
            # a bright, strongly chromatic colour so dark fur remains intact.
            blue_dominance = blue - max(red, green)
            # Green reflections on black fur can still have a modest green
            # dominance.  The actual screen in the supplied clips is much
            # brighter, so keep a high brightness floor before keying it.
            green_screen = green > 105 and green - red > 18 and green - blue > -12
            blue_screen = blue > 72 and green > red and green - red > 9 and blue - red > 18
            if (screen_is_green and green_screen) or (not screen_is_green and blue_screen):
                pixels[x, y] = (0, 0, 0, 0)
            elif not screen_is_green and blue_dominance > 3:
                # Despill the remaining semi-blue pixels so dark fur does
                # not carry a cyan outline once composited on the desktop.
                pixels[x, y] = (red, green, min(255, max(red, green) + 3), alpha)
    return image


paths = sorted(input_dir.glob("frame-*.png"))
if len(paths) != 24:
    raise SystemExit(f"expected 24 frames, got {len(paths)}")

frames = [remove_chroma_background(Image.open(path)) for path in paths]
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
if cover_path:
    cover_path.parent.mkdir(parents=True, exist_ok=True)
    sheet.crop((0, 0, cell, cell)).save(cover_path)
print(
    {
        "frames": len(frames),
        "crop": (left, top, right, bottom),
        "output": str(output_path),
    }
)
