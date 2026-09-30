#!/usr/bin/env python3
"""Prepare one gallery work (image or video) and optionally insert its card into index.html.

Usage:
  prepare_media.py SRC --cat blender|python|figma --slug teddy-bear \
      --title "Плюшевый мишка" --tag "Рендер" --author student|teacher \
      [--alt "3D-рендер: ..."] [--insert] [--repo .]

What it does:
  images  -> kept as-is if already light (<= 500 KB, <= 1920 px), otherwise converted to .webp (max 1920 px)
  videos  -> H.264 mp4 without audio, moov atom at the start (+faststart), <= 1080p, aims for <= 10 MB;
             plus a poster frame  <slug>-poster.jpg
  portrait works (h > w) get the .fit class and --fit-bg sampled from the top-left pixel
  --insert puts the card at the end of #gp-<cat> .gtrack and removes that panel's placeholders
Prints a JSON report to stdout.
"""
import argparse, html, json, os, re, shutil, subprocess, sys

IMG_EXT = {'.png', '.jpg', '.jpeg', '.webp'}
VID_EXT = {'.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi', '.gif'}
IMG_MAX_BYTES = 500 * 1024
VID_MAX_BYTES = 10 * 1024 * 1024
MAX_W = 1920
AUTHORS = {'student': 'Работа ученика', 'teacher': 'Работа преподавателя'}


def find_ffmpeg():
    exe = shutil.which('ffmpeg')
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except ImportError:
        sys.exit('ffmpeg not found: run .claude/hooks/session-start.sh or `pip install imageio-ffmpeg`')


FF = find_ffmpeg()


def ff(*args):
    subprocess.run([FF, '-v', 'error', '-y', *args], check=True)


def probe(path):
    """Parse `ffmpeg -i` output: codec, width, height, duration, has_audio."""
    err = subprocess.run([FF, '-hide_banner', '-i', path], capture_output=True, text=True).stderr
    v = re.search(r'Stream #.*?Video: (\w+).*?, (\d{2,5})x(\d{2,5})', err)
    if not v:
        sys.exit(f'no video/image stream found in {path}')
    d = re.search(r'Duration: (\d+):(\d+):([\d.]+)', err)
    dur = int(d[1]) * 3600 + int(d[2]) * 60 + float(d[3]) if d else 0.0
    return {'codec': v[1], 'w': int(v[2]), 'h': int(v[3]), 'duration': dur, 'has_audio': 'Audio:' in err}


def pixel_hex(path, x=5, y=5):
    raw = subprocess.run([FF, '-v', 'error', '-i', path, '-frames:v', '1', '-vf', f'crop=1:1:{x}:{y}',
                          '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
    return '#%02x%02x%02x' % tuple(raw[:3])


def is_faststart(path):
    with open(path, 'rb') as f:
        data = f.read(64 * 1024 * 1024)
    m, d = data.find(b'moov'), data.find(b'mdat')
    return m != -1 and (d == -1 or m < d)


def prepare_image(src, dst_dir, slug, info):
    ext = os.path.splitext(src)[1].lower()
    ext = '.jpg' if ext == '.jpeg' else ext
    if os.path.getsize(src) <= IMG_MAX_BYTES and info['w'] <= MAX_W:
        dst = os.path.join(dst_dir, slug + ext)
        shutil.copyfile(src, dst)
    else:
        dst = os.path.join(dst_dir, slug + '.webp')
        ff('-i', src, '-vf', f"scale='min({MAX_W},iw)':-2", '-c:v', 'libwebp', '-quality', '82', dst)
    return dst, None


def prepare_video(src, dst_dir, slug, info):
    dst = os.path.join(dst_dir, slug + '.mp4')
    ext = os.path.splitext(src)[1].lower()
    can_copy = (info['codec'] == 'h264' and ext in ('.mp4', '.m4v', '.mov')
                and os.path.getsize(src) <= VID_MAX_BYTES and info['h'] <= 1080)
    if can_copy:
        ff('-i', src, '-c', 'copy', '-an', '-movflags', '+faststart', dst)
    else:
        for crf, height in ((24, 1080), (28, 720)):
            ff('-i', src, '-an', '-c:v', 'libx264', '-preset', 'slow', '-crf', str(crf), '-pix_fmt', 'yuv420p',
               '-vf', f"scale=-2:'min({height},ih)'", '-movflags', '+faststart', dst)
            if os.path.getsize(dst) <= VID_MAX_BYTES:
                break
    poster = os.path.join(dst_dir, slug + '-poster.jpg')
    ff('-ss', str(min(1.0, info['duration'] / 3)), '-i', dst, '-frames:v', '1', '-q:v', '4', poster)
    return dst, poster


def card_html(rel, poster_rel, is_video, args, fit_bg):
    e = lambda s: html.escape(s, quote=True)
    alt = args.alt or f"{args.tag}: {args.title}"
    cls = 'gcard fit' if fit_bg else 'gcard'
    style = f' style="--fit-bg:{fit_bg}"' if fit_bg else ''
    if is_video:
        media = (f'<video src="{e(rel)}" poster="{e(poster_rel)}" autoplay muted loop playsinline '
                 f'preload="metadata" aria-label="{e(alt)}"></video>')
    else:
        media = f'<img src="{e(rel)}" alt="{e(alt)}" loading="lazy">'
    return (f'<div class="{cls}"{style} tabindex="0"><span class="gtag">{e(args.tag)}</span>{media}'
            f'<div class="gcap">{e(args.title)}<small>{AUTHORS[args.author]}</small></div></div>')


def insert_card(index_path, cat, card):
    s = open(index_path, encoding='utf-8').read()
    start = s.find(f'id="gp-{cat}"')
    if start == -1:
        sys.exit(f'panel #gp-{cat} not found in {index_path}')
    ends = [i for i in (s.find('<div class="gpanel"', start + 1), s.find('class="gallery-note"', start)) if i != -1]
    end = min(ends)
    panel = s[start:end]
    removed = len(re.findall(r'\n[ \t]*<div class="gcard placeholder">.*?</div>(?=\n)', panel))
    panel = re.sub(r'\n[ \t]*<div class="gcard placeholder">.*?</div>(?=\n)', '', panel)
    close = panel.rfind('\n      </div>\n    </div>')
    if close == -1:
        sys.exit('could not find the end of .gtrack in the panel; insert the card manually')
    panel = panel[:close] + '\n        ' + card + panel[close:]
    open(index_path, 'w', encoding='utf-8').write(s[:start] + panel + s[end:])
    return removed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('--cat', required=True, choices=['blender', 'python', 'figma'])
    ap.add_argument('--slug', required=True, help='latin file name without extension, e.g. teddy-bear')
    ap.add_argument('--title', required=True)
    ap.add_argument('--tag', required=True, help='Рендер / Анимация / Игра / UI / Баннер ...')
    ap.add_argument('--author', required=True, choices=list(AUTHORS))
    ap.add_argument('--alt')
    ap.add_argument('--repo', default='.')
    ap.add_argument('--insert', action='store_true')
    args = ap.parse_args()

    if not re.fullmatch(r'[a-z0-9]+(-[a-z0-9]+)*', args.slug):
        sys.exit('slug must be lowercase latin/digits/hyphens')
    ext = os.path.splitext(args.src)[1].lower()
    if ext not in IMG_EXT | VID_EXT:
        sys.exit(f'unsupported file type {ext}')
    is_video = ext in VID_EXT

    dst_dir = os.path.join(args.repo, 'assets', 'gallery', args.cat)
    os.makedirs(dst_dir, exist_ok=True)
    info = probe(args.src)
    dst, poster = (prepare_video if is_video else prepare_image)(args.src, dst_dir, args.slug, info)
    for p in (dst, poster):
        if p:
            os.chmod(p, 0o644)
    gk = os.path.join(dst_dir, '.gitkeep')
    if os.path.exists(gk):
        os.remove(gk)

    out = probe(dst)
    portrait = out['h'] > out['w'] * 1.05
    fit_bg = pixel_hex(poster or dst) if portrait else None
    rel = os.path.relpath(dst, args.repo).replace(os.sep, '/')
    poster_rel = os.path.relpath(poster, args.repo).replace(os.sep, '/') if poster else None
    card = card_html(rel, poster_rel, is_video, args, fit_bg)

    report = {
        'file': rel, 'poster': poster_rel, 'kind': 'video' if is_video else 'image',
        'size_kb': os.path.getsize(dst) // 1024, 'width': out['w'], 'height': out['h'],
        'duration_s': round(out['duration'], 2) if is_video else None,
        'faststart': is_faststart(dst) if is_video else None,
        'portrait_fit_bg': fit_bg, 'card_html': card,
    }
    if args.insert:
        report['placeholders_removed'] = insert_card(os.path.join(args.repo, 'index.html'), args.cat, card)
        report['inserted_into'] = f'#gp-{args.cat}'
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
