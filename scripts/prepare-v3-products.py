"""Inspect and export local product PNGs using Pillow. Originals are read-only."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw


def inspect(path):
    with Image.open(path) as image:
        has_alpha = 'A' in image.getbands() or 'transparency' in image.info
        rgba = image.convert('RGBA')
        alpha = rgba.getchannel('A')
        bounds = alpha.point(lambda value: 255 if value >= 24 else 0).getbbox()
        transparent = alpha.histogram()[0] / (image.width * image.height)
        coverage = None if not bounds else [round((bounds[2] - bounds[0]) / image.width, 2),
                                            round((bounds[3] - bounds[1]) / image.height, 2)]
        return rgba, bounds, (image.format, image.size, has_alpha, round(transparent, 3), coverage)


def preview(image, bounds, size, subject_size):
    subject = image.crop(bounds) if bounds else image.copy()
    subject.thumbnail((subject_size, subject_size), Image.Resampling.LANCZOS)
    tile = Image.new('RGBA', (size, size))
    tile.alpha_composite(subject, ((size - subject.width) // 2, (size - subject.height) // 2))
    return tile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('--sheet', type=Path)
    parser.add_argument('--export', type=Path)
    parser.add_argument('--destination', type=Path)
    args = parser.parse_args()
    files = sorted(p for p in args.source.iterdir() if p.suffix.lower() == '.png')
    selected = json.loads(args.export.read_text(encoding='utf-8-sig')) if args.export else {}
    columns, width, height = 6, 112, 118
    sheet = Image.new('RGB', (width * columns, height * ((len(files) + columns - 1) // columns)), 'white')
    draw = ImageDraw.Draw(sheet)

    for index, path in enumerate(files, 1):
        image, bounds, info = inspect(path)
        print(index, path.name, path.stat().st_size, info)
        if args.sheet:
            x, y = ((index - 1) % columns) * width, ((index - 1) // columns) * height
            draw.rounded_rectangle((x + 7, y + 4, x + 104, y + 99), radius=13, fill='#ebebf0')
            tile = preview(image, bounds, 86, 76)
            sheet.paste(tile, (x + 13, y + 8), tile)
            draw.text((x + 14, y + 100), str(index), fill='#1c1c1e')
        if path.name in selected:
            if not info[2] or info[3] < 0.1 or bounds is None:
                raise ValueError(f'Unsuitable transparency: {path.name}')
            target = args.destination / (selected[path.name] + '.png')
            tile = preview(image, bounds, 192, 154)
            tile.save(target, optimize=True)
            if target.stat().st_size > 40000:
                tile.quantize(colors=192, method=Image.Quantize.FASTOCTREE).save(target, optimize=True)
            with Image.open(target) as exported:
                assert exported.convert('RGBA').getpixel((0, 0))[3] == 0
            print('  ->', target.name, target.stat().st_size)

    if args.sheet:
        sheet.save(args.sheet)


if __name__ == '__main__':
    main()
