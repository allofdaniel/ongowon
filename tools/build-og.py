#!/usr/bin/env python3
"""온고원 페이지별 OG(공유 썸네일) 이미지 생성 + 공유 태그 정리.

하는 일
1. 페이지마다 1200×630 공유 썸네일을 만들어 images/og/<이름>.jpg 로 저장한다.
   (카카오톡·인스타 DM·페이스북·X·슬랙·검색 미리보기에 뜨는 이미지)
2. 각 페이지 <head> 의 og:image / twitter:image 를 새 썸네일로 바꾸고,
   빠진 태그(og:image:width/height/alt/type, twitter:card/title/description/image/alt)를 채운다.
3. JSON-LD 의 primaryImageOfPage 도 같은 이미지로 맞춘다.

새 페이지를 만들면 PAGES 에 한 줄 추가하고 `python3 tools/build-og.py` 를 실행한 뒤 커밋한다.
"""
import html
import json
import os
import re
from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = 'images/og'
SITE = 'https://ongowon.com'

W, H = 1200, 630
BG = (251, 247, 240)      # --bg   #FBF7F0
INK = (43, 37, 32)        # --ink  #2B2520
SOFT = (106, 94, 82)      # --soft #6A5E52
SEAL = (180, 65, 47)      # --seal #B4412F
LINE = (217, 204, 182)    # --line #D9CCB6
PHOTO_W = 520

FD = '/usr/share/fonts/opentype/noto/'
SERIF_B = FD + 'NotoSerifCJK-Bold.ttc'
SANS_M = FD + 'NotoSansCJK-Medium.ttc'
SANS_B = FD + 'NotoSansCJK-Bold.ttc'
IDX = {'ko': 1, 'en': 1, 'ja': 0}   # .ttc 글꼴 인덱스 (JP=0, KR=1)
BRAND = {'ko': '온고원', 'en': 'ONGOWON', 'ja': '温故園'}
SEAL_CH = {'ko': '溫', 'en': '溫', 'ja': '温'}

# 파일: (언어, 썸네일 이름, 제목 줄들, 부제, 그림)
PAGES = {
    'index.html': ('ko', 'home', ['소원을 덮어주는', '첫 번째 담요'], '민화 아기 담요 · 출산·백일·돌 선물', 'images/sheep.jpg'),
    'en/index.html': ('en', 'home-en', ['A blanket', 'that keeps a wish'], 'Korean minhwa baby blankets & gifts', 'images/crane.jpg'),
    'ja/index.html': ('ja', 'home-ja', ['願いをそっと包む', 'はじめてのブランケット'], '韓国民画のベビーブランケット・出産祝い', 'images/peony.jpg'),
    'minhwa/index.html': ('ko', 'minhwa', ['민화 소원 사전'], '잉어 · 학 · 모란 · 책가도 · 까치호랑이 · 박쥐 그림의 뜻', 'images/carp.jpg'),
    'en/minhwa/index.html': ('en', 'minhwa-en', ['Korean Minhwa', 'Symbols & Meanings'], 'Carp · Crane · Peony · Tiger · Bat', 'images/carp.jpg'),
    'ja/minhwa/index.html': ('ja', 'minhwa-ja', ['韓国民画の', '吉祥モチーフと意味'], '鯉・鶴・牡丹・冊架図・鵲虎・蝙蝠', 'images/carp.jpg'),
    'wish/index.html': ('ko', 'wish', ['민화는 원래', '소원을 비는 그림'], '진짜 민화 맞히기 · 내 소원템 찾기 · 조선의 띠와 돌잡이', 'images/peony.jpg'),
    'linktree/index.html': ('ko', 'linktree', ['그림으로 비는 소원'], '온고원 링크 모음', 'images/horse.jpg'),
}


def f(path, size, lang):
    return ImageFont.truetype(path, size, index=IDX[lang])


def wrap(d, text, fnt, max_w, lang):
    """한글·영어는 띄어쓰기 단위, 일본어는 글자 단위로 줄바꿈."""
    units = list(text) if lang == 'ja' else text.split(' ')
    sep = '' if lang == 'ja' else ' '
    lines, cur = [], ''
    for u in units:
        trial = (cur + sep + u) if cur else u
        if d.textlength(trial, font=fnt) <= max_w:
            cur = trial
        else:
            lines.append(cur)
            cur = u
    if cur:
        lines.append(cur)
    return lines


def make(lang, name, title_lines, sub, img):
    card = Image.new('RGB', (W, H), BG)
    art = ImageOps.fit(Image.open(os.path.join(ROOT, img)).convert('RGB'), (PHOTO_W, H), Image.LANCZOS)
    card.paste(art, (W - PHOTO_W, 0))
    d = ImageDraw.Draw(card)
    d.line((W - PHOTO_W - 1, 0, W - PHOTO_W - 1, H), fill=LINE, width=2)
    x, tw = 72, W - PHOTO_W - 72 - 52

    # 낙관(도장) + 브랜드
    d.rectangle((x, 62, x + 44, 106), fill=SEAL)
    sc = f(SERIF_B, 28, 'ja' if lang == 'ja' else 'ko')
    cw = d.textlength(SEAL_CH[lang], font=sc)
    d.text((x + 22 - cw / 2, 64), SEAL_CH[lang], font=sc, fill=BG)
    d.text((x + 60, 64), BRAND[lang], font=f(SERIF_B, 28, lang), fill=INK)
    if lang != 'en':
        bx = x + 60 + d.textlength(BRAND[lang], font=f(SERIF_B, 28, lang)) + 12
        d.text((bx, 72), 'ONGOWON', font=f(SANS_M, 18, lang), fill=SOFT)

    # 제목은 주어진 줄 그대로 두고, 가장 긴 줄이 폭에 들어갈 때까지 글자 크기를 줄인다
    size = 66
    while size > 34:
        tf = f(SERIF_B, size, lang)
        if max(d.textlength(t, font=tf) for t in title_lines) <= tw:
            break
        size -= 2
    lines = title_lines
    y = 215 if len(lines) <= 2 else 185
    for ln in lines:
        d.text((x, y), ln, font=tf, fill=INK)
        y += int(size * 1.32)

    sf = f(SANS_M, 25, lang)
    for ln in wrap(d, sub, sf, tw, lang)[:2]:
        d.text((x, y + 16), ln, font=sf, fill=SOFT)
        y += 36

    d.line((x, H - 96, x + 40, H - 96), fill=SEAL, width=3)
    d.text((x, H - 80), 'ongowon.com', font=f(SANS_B, 24, lang), fill=INK)

    os.makedirs(os.path.join(ROOT, OUT_DIR), exist_ok=True)
    out = f'{OUT_DIR}/{name}.jpg'
    card.save(os.path.join(ROOT, out), 'JPEG', quality=86, optimize=True, progressive=True)
    return out


def meta_tag(attr, key, value):
    return f'<meta {attr}="{key}" content="{value}">'


def set_tag(head, attr, key, value, after_key=None):
    """같은 태그가 있으면 값을 바꾸고, 없으면 기준 태그 뒤(없으면 </head> 앞)에 넣는다."""
    pat = re.compile(r'<meta\s+' + attr + r'="' + re.escape(key) + r'"\s+content="[^"]*"\s*/?>')
    tag = meta_tag(attr, key, value)
    if pat.search(head):
        return pat.sub(lambda m: tag, head, count=1)
    if after_key:
        ap = re.compile(r'<meta\s+(?:property|name)="' + re.escape(after_key) + r'"\s+content="[^"]*"\s*/?>')
        m = ap.search(head)
        if m:
            return head[:m.end()] + '\n' + tag + head[m.end():]
    return head.rstrip('\n') + '\n' + tag + '\n'


def get(head, attr, key):
    m = re.search(r'<meta\s+' + attr + r'="' + re.escape(key) + r'"\s+content="([^"]*)"', head)
    return m.group(1) if m else None


def patch(file, img_path):
    p = os.path.join(ROOT, file)
    src = open(p, encoding='utf-8').read()
    # </head> 가 없는 페이지(소원 놀이터)는 첫 <link rel="icon"> 앞까지를 head 메타 영역으로 본다
    i = src.find('</head>')
    if i < 0:
        i = src.find('<link rel="icon"')
    head, rest = src[:i], src[i:]
    url = f'{SITE}/{img_path}'
    title = get(head, 'property', 'og:title') or html.escape(re.search(r'<title>([^<]*)', head).group(1))
    desc = get(head, 'property', 'og:description') or get(head, 'name', 'description') or ''
    # 공유용 og 태그
    head = set_tag(head, 'property', 'og:image', url)
    head = set_tag(head, 'property', 'og:image:secure_url', url, 'og:image')
    head = set_tag(head, 'property', 'og:image:type', 'image/jpeg', 'og:image:secure_url')
    head = set_tag(head, 'property', 'og:image:width', '1200', 'og:image:type')
    head = set_tag(head, 'property', 'og:image:height', '630', 'og:image:width')
    head = set_tag(head, 'property', 'og:image:alt', title, 'og:image:height')
    # 기존에 한 줄로 붙어 있던 width/height 중복 제거
    for k in ('og:image:width', 'og:image:height'):
        tags = re.findall(r'<meta\s+property="' + k + r'"\s+content="[^"]*"\s*/?>', head)
        for extra in tags[1:]:
            head = head.replace(extra, '', 1)
    # X(트위터)
    head = set_tag(head, 'name', 'twitter:card', 'summary_large_image', 'og:image:alt')
    head = set_tag(head, 'name', 'twitter:title', title, 'twitter:card')
    head = set_tag(head, 'name', 'twitter:description', desc, 'twitter:title')
    head = set_tag(head, 'name', 'twitter:image', url, 'twitter:description')
    head = set_tag(head, 'name', 'twitter:image:alt', title, 'twitter:image')
    out = head + rest
    # JSON-LD: 이 페이지의 WebPage 에 대표 이미지(primaryImageOfPage) 지정
    def fix_ld(m):
        try:
            data = json.loads(m.group(2))
        except ValueError:
            return m.group(0)
        nodes = data.get('@graph', [data])
        for n in nodes:
            if n.get('@type') in ('WebPage', 'CollectionPage', 'AboutPage', 'FAQPage') and n.get('@id', '').endswith('#webpage'):
                n['primaryImageOfPage'] = {'@type': 'ImageObject', 'url': url, 'width': 1200, 'height': 630}
        return m.group(1) + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + m.group(3)
    out = re.sub(r'(<script type="application/ld\+json">)(.*?)(</script>)', fix_ld, out, flags=re.S)
    open(p, 'w', encoding='utf-8').write(out)


def main():
    for file, (lang, name, title, sub, img) in PAGES.items():
        out = make(lang, name, title, sub, img)
        patch(file, out)
        print(f'{file:24s} → {out}')


if __name__ == '__main__':
    main()
