"""Generate a 72x16 nyan cat GIF for the BUSY Bar front display."""
from PIL import Image
import sys

W, H = 72, 16
FRAMES = 6
OUT = sys.argv[1]

PAL = {
    'K': (10, 10, 10),      # outline (near-black so it reads on LEDs)
    'T': (244, 200, 156),   # pop-tart
    'P': (240, 158, 182),   # frosting
    'D': (238, 76, 156),    # sprinkles
    'G': (150, 150, 150),   # cat grey
    'W': (255, 255, 255),   # eyes
    'R': (248, 135, 169),   # cheeks
}
RAINBOW = [
    (255, 0, 0), (255, 153, 0), (255, 255, 0),
    (51, 255, 0), (0, 153, 255), (102, 51, 255),
]

BODY = [  # 15x11 pop-tart with frosting + sprinkles
    '.KKKKKKKKKKKKK.',
    'KTTTTTTTTTTTTTK',
    'KTPPPPPPPPPPPTK',
    'KTPDPPPPDPPPPTK',
    'KTPPPPPPPPPPPTK',
    'KTPPPPDPPPPDPTK',
    'KTPDPPPPPPPPPTK',
    'KTPPPPPPPDPPPTK',
    'KTPPPPPPPPPPPTK',
    'KTTTTTTTTTTTTTK',
    '.KKKKKKKKKKKKK.',
]
HEAD = [  # 10x8, drawn over the body's right edge
    '.KK....KK.',
    'KGGK..KGGK',
    'KGGGKKGGGK',
    'KGGGGGGGGK',
    'KGWGGGGWGK',
    'KRGGKKGGRK',
    '.KGGGGGGK.',
    '..KKKKKK..',
]

def blit(px, grid, ox, oy):
    for y, row in enumerate(grid):
        for x, c in enumerate(row):
            if c != '.' and 0 <= ox + x < W and 0 <= oy + y < H:
                px[ox + x, oy + y] = PAL[c]

def put(px, x, y, color):
    if 0 <= x < W and 0 <= y < H:
        px[x, y] = color

frames = []
for f in range(FRAMES):
    img = Image.new('RGB', (W, H), (0, 0, 0))
    px = img.load()
    bob = 1 if f % 2 else 0            # whole cat bobs 1px on odd frames
    body_x, body_y = 46, 2

    # stars scrolling left behind everything (3x3 plus signs)
    for sx, sy in ((6, 2), (26, 12), (40, 1), (60, 13), (16, 7)):
        cx = (sx - f * 2) % W
        put(px, cx, sy, PAL['W'])
        if f % 3 == 0:                 # twinkle: grow into a plus every 3rd frame
            for dx, dy in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                put(px, cx + dx, sy + dy, PAL['W'])

    # rainbow trail: 6 stripes x 2px, waving in 6px segments, tucked under the body
    phase = 0 if f % 4 < 2 else 1
    for x in range(0, body_x + 2):
        dy = 1 if (x // 6 + phase) % 2 else 0
        for s, color in enumerate(RAINBOW):
            for t in range(2):
                put(px, x, 2 + s * 2 + t + dy, color)

    # cat: tail, legs, body, head (head overlaps the body's right edge)
    for i, (dx, dy) in enumerate(((0, 5), (1, 4), (2, 5), (3, 4))):  # zigzag tail
        put(px, body_x - 4 + dx, body_y + dy + bob, PAL['G'])
        put(px, body_x - 4 + dx, body_y + dy + 1 + bob, PAL['K'])
    blit(px, BODY, body_x, body_y + bob)
    for leg_x in (body_x + 1, body_x + 5, body_x + 12, body_x + 16):  # leg stubs
        put(px, leg_x, body_y + 11 + bob, PAL['G'])
        put(px, leg_x + 1, body_y + 11 + bob, PAL['G'])
        put(px, leg_x, body_y + 12 + bob, PAL['K'])
        put(px, leg_x + 1, body_y + 12 + bob, PAL['K'])
    blit(px, HEAD, body_x + 10, body_y + 3 + bob)

    frames.append(img.quantize(colors=64, dither=Image.Dither.NONE))

frames[0].save(OUT, save_all=True, append_images=frames[1:], duration=90, loop=0)
print(f'wrote {OUT} ({FRAMES} frames)')
