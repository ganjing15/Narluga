#!/usr/bin/env python3
"""Generate Narluga thumbnail - Bioluminescent Cartography aesthetic. V2 refined."""

from PIL import Image, ImageDraw, ImageFont, ImageFilter
import math
import os
import random

FONTS_DIR = os.path.expanduser("~/.claude/plugins/cache/anthropic-agent-skills/document-skills/3d5951151859/skills/canvas-design/canvas-fonts")

W, H = 1280, 720

def load_font(name, size):
    try:
        return ImageFont.truetype(os.path.join(FONTS_DIR, name), size)
    except:
        return ImageFont.load_default()

def draw_glow_circle(draw, cx, cy, r, color, alpha_max=80):
    for i in range(r, 0, -1):
        t = i / r
        a = int(alpha_max * (1 - t) ** 2)
        draw.ellipse([cx - i, cy - i, cx + i, cy + i], fill=(*color, a))

def draw_smooth_narwhal(draw, cx, cy, scale=1.0, color=(14, 165, 233), alpha=80):
    """Draw a more refined narwhal with smoother curves."""
    pts = 60
    body_points = []

    # Top contour - more whale-like with dorsal hump
    for i in range(pts):
        t = i / (pts - 1)
        x = cx - 100*scale + t * 200*scale
        # Asymmetric hump peaking at 40%
        hump = math.sin(t * math.pi) ** 0.8
        melon = max(0, 1 - ((t - 0.85) / 0.15)**2) * 0.3 if t > 0.7 else 0  # Head bulge
        y = cy - (35*scale * hump + 12*scale * melon)
        body_points.append((x, y))

    # Bottom contour - flatter belly
    for i in range(pts):
        t = 1 - i / (pts - 1)
        x = cx - 100*scale + t * 200*scale
        belly = math.sin(t * math.pi) ** 1.3
        y = cy + 22*scale * belly + 8*scale
        body_points.append((x, y))

    draw.polygon(body_points, fill=(*color, alpha))

    # Flipper
    flip_cx = cx + 10*scale
    flip_cy = cy + 20*scale
    flipper = [
        (flip_cx, flip_cy),
        (flip_cx - 20*scale, flip_cy + 30*scale),
        (flip_cx + 10*scale, flip_cy + 5*scale),
    ]
    draw.polygon(flipper, fill=(*color, alpha - 10))

    # Horn/tusk - elegant spiral suggestion
    horn_x = cx + 100*scale
    horn_y = cy - 12*scale
    horn_end_x = cx + 185*scale
    horn_end_y = cy - 55*scale

    # Draw tusk with taper
    for w in range(4, 0, -1):
        t_alpha = alpha + 20 + (4 - w) * 15
        draw.line([(horn_x, horn_y), (horn_end_x, horn_end_y)],
                  fill=(*color, min(255, t_alpha)), width=max(1, int(w * scale * 0.6)))

    # Spiral marks on tusk
    for i in range(5):
        t = 0.2 + i * 0.15
        mx = horn_x + t * (horn_end_x - horn_x)
        my = horn_y + t * (horn_end_y - horn_y)
        perp_x = -(horn_end_y - horn_y)
        perp_y = horn_end_x - horn_x
        mag = math.sqrt(perp_x**2 + perp_y**2)
        if mag > 0:
            perp_x /= mag
            perp_y /= mag
        offset = 3 * scale * (1 - t)
        draw.line([(mx - perp_x*offset, my - perp_y*offset),
                   (mx + perp_x*offset, my + perp_y*offset)],
                  fill=(*color, alpha // 2), width=1)

    # Tail flukes - more graceful
    tail_x = cx - 100*scale
    tail_y = cy + 5*scale
    # Upper fluke
    draw.polygon([
        (tail_x, tail_y),
        (tail_x - 35*scale, tail_y - 28*scale),
        (tail_x - 20*scale, tail_y - 8*scale),
        (tail_x - 8*scale, tail_y - 2*scale),
    ], fill=(*color, alpha - 5))
    # Lower fluke
    draw.polygon([
        (tail_x, tail_y),
        (tail_x - 35*scale, tail_y + 22*scale),
        (tail_x - 20*scale, tail_y + 8*scale),
        (tail_x - 8*scale, tail_y + 2*scale),
    ], fill=(*color, alpha - 5))

    # Eye - bright white dot
    eye_x = cx + 75*scale
    eye_y = cy - 5*scale
    draw.ellipse([eye_x - 3*scale, eye_y - 3*scale, eye_x + 3*scale, eye_y + 3*scale],
                fill=(255, 255, 255, min(255, alpha + 80)))

    return horn_end_x, horn_end_y  # Return horn tip for wave placement

def main():
    random.seed(42)

    bg_color = (6, 10, 24)
    img = Image.new("RGBA", (W, H), (*bg_color, 255))

    # === BACKGROUND: Gradient with center glow ===
    bg_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg_layer, "RGBA")

    for y in range(H):
        t = y / H
        r = int(6 + 10 * t)
        g = int(10 + 6 * t)
        b = int(24 + 16 * math.sin(t * math.pi))
        bg_draw.line([(0, y), (W, y)], fill=(r, g, b, 255))

    img = Image.alpha_composite(img, bg_layer)

    # === LAYER 1: Deep ambient glows - BRIGHTER ===
    glow_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow_layer, "RGBA")

    # Central large glow - dominant
    draw_glow_circle(glow_draw, W//2 + 40, H//2 - 20, 400, (8, 50, 120), 30)
    draw_glow_circle(glow_draw, W//2 + 40, H//2 - 20, 250, (14, 80, 180), 25)
    # Accent glows
    draw_glow_circle(glow_draw, 160, 500, 250, (20, 60, 160), 18)
    draw_glow_circle(glow_draw, W - 200, 180, 220, (60, 40, 160), 14)
    draw_glow_circle(glow_draw, W//2 - 200, 100, 180, (14, 100, 200), 12)

    glow_layer = glow_layer.filter(ImageFilter.GaussianBlur(50))
    img = Image.alpha_composite(img, glow_layer)

    center_x, center_y = W // 2 + 40, H // 2 - 10

    # === LAYER 2: Concentric rings - MORE VISIBLE ===
    ring_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ring_draw = ImageDraw.Draw(ring_layer, "RGBA")

    ring_colors = [
        (14, 165, 233),
        (56, 189, 248),
        (99, 102, 241),
        (129, 140, 248),
    ]

    # Full concentric rings
    for i in range(16):
        r = 40 + i * 22
        alpha = max(12, 55 - i * 3)
        color = ring_colors[i % len(ring_colors)]
        ring_draw.ellipse(
            [center_x - r, center_y - r, center_x + r, center_y + r],
            outline=(*color, alpha), width=1
        )

    # Dynamic partial arcs
    for i in range(8):
        r = 60 + i * 38
        alpha = max(15, 65 - i * 7)
        color = ring_colors[i % len(ring_colors)]
        start = 10 + i * 25
        span = 90 + i * 12
        ring_draw.arc(
            [center_x - r, center_y - r, center_x + r, center_y + r],
            start=start, end=start + span,
            fill=(*color, alpha), width=2 if i < 4 else 1
        )
        ring_draw.arc(
            [center_x - r, center_y - r, center_x + r, center_y + r],
            start=start + 180, end=start + 180 + span - 20,
            fill=(*color, max(5, alpha - 10)), width=1
        )

    img = Image.alpha_composite(img, ring_layer)

    # === LAYER 3: Node network - BRIGHTER ===
    node_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    node_draw = ImageDraw.Draw(node_layer, "RGBA")

    nodes = [
        (120, 160, 4), (280, 120, 5), (140, 330, 3),
        (400, 200, 6), (530, 140, 5), (680, 110, 4),
        (830, 170, 4), (460, 400, 5), (600, 440, 4),
        (760, 370, 6), (930, 260, 5), (1060, 180, 4),
        (1120, 360, 5), (360, 540, 4), (540, 560, 3),
        (700, 550, 5), (880, 500, 4), (1040, 540, 4),
        (230, 460, 3), (1160, 130, 4),
        (center_x, center_y, 8),  # Central node
    ]

    # Draw connections
    for i in range(len(nodes)):
        for j in range(i + 1, len(nodes)):
            x1, y1, r1 = nodes[i]
            x2, y2, r2 = nodes[j]
            dist = math.sqrt((x2 - x1)**2 + (y2 - y1)**2)
            if dist < 220:
                line_alpha = int(55 * (1 - dist / 220))
                node_draw.line([(x1, y1), (x2, y2)], fill=(56, 189, 248, line_alpha), width=1)

    # Draw nodes with glow
    for x, y, r in nodes:
        draw_glow_circle(node_draw, x, y, r * 5, (56, 189, 248), 15)
        node_draw.ellipse([x - r, y - r, x + r, y + r], fill=(56, 189, 248, 60))
        node_draw.ellipse([x - r//2, y - r//2, x + r//2, y + r//2], fill=(129, 180, 255, 90))

    img = Image.alpha_composite(img, node_layer)

    # === LAYER 4: Narwhal - MORE PROMINENT ===
    narwhal_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    narwhal_draw = ImageDraw.Draw(narwhal_layer, "RGBA")

    # Ghost echo first
    draw_smooth_narwhal(narwhal_draw, center_x - 30, center_y + 15, scale=1.6,
                       color=(30, 64, 175), alpha=25)

    # Main narwhal
    horn_tip_x, horn_tip_y = draw_smooth_narwhal(
        narwhal_draw, center_x, center_y + 5, scale=1.7,
        color=(14, 165, 233), alpha=65
    )

    # Bioluminescent belly glow
    draw_glow_circle(narwhal_draw, center_x + 20, center_y + 25, 60, (56, 189, 248), 25)

    narwhal_layer = narwhal_layer.filter(ImageFilter.GaussianBlur(2))
    img = Image.alpha_composite(img, narwhal_layer)

    # === LAYER 5: Sound waves from horn - STRONGER ===
    wave_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    wave_draw = ImageDraw.Draw(wave_layer, "RGBA")

    # Waves from horn tip
    for i in range(7):
        r = 15 + i * 16
        a = max(12, 70 - i * 9)
        wave_draw.arc(
            [int(horn_tip_x - r), int(horn_tip_y - r),
             int(horn_tip_x + r), int(horn_tip_y + r)],
            start=280, end=60, fill=(56, 189, 248, a), width=2
        )

    # Bright spark at horn tip
    draw_glow_circle(wave_draw, int(horn_tip_x), int(horn_tip_y), 20, (129, 200, 255), 60)
    draw_glow_circle(wave_draw, int(horn_tip_x), int(horn_tip_y), 8, (255, 255, 255), 100)
    wave_draw.ellipse([int(horn_tip_x) - 3, int(horn_tip_y) - 3,
                       int(horn_tip_x) + 3, int(horn_tip_y) + 3],
                      fill=(255, 255, 255, 220))

    img = Image.alpha_composite(img, wave_layer)

    # === LAYER 6: Bioluminescent particles - MORE ===
    particle_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    particle_draw = ImageDraw.Draw(particle_layer, "RGBA")

    for _ in range(120):
        px = random.randint(30, W - 30)
        py = random.randint(30, H - 30)
        pr = random.choice([1, 1, 1, 2, 2, 2, 3, 3, 4])
        dx = (px - center_x) / (W/2)
        dy = (py - center_y) / (H/2)
        dist = math.sqrt(dx*dx + dy*dy)
        brightness = max(30, int(100 * (1 - dist * 0.4)))
        color_choice = random.choice([
            (14, 165, 233),
            (56, 189, 248),
            (129, 140, 248),
            (200, 220, 255),
            (255, 255, 255),
        ])
        draw_glow_circle(particle_draw, px, py, pr * 4, color_choice, brightness // 3)
        particle_draw.ellipse([px - pr, py - pr, px + pr, py + pr],
                             fill=(*color_choice, brightness))

    img = Image.alpha_composite(img, particle_layer)

    # === LAYER 7: Typography ===
    text_layer = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    text_draw = ImageDraw.Draw(text_layer, "RGBA")

    font_title = load_font("Jura-Medium.ttf", 76)
    font_sub = load_font("Jura-Light.ttf", 22)
    font_label = load_font("DMMono-Regular.ttf", 10)

    # Title
    title_x, title_y = 60, 48

    # Glow behind title
    draw_glow_circle(text_draw, title_x + 150, title_y + 35, 120, (14, 100, 200), 18)

    text_draw.text((title_x, title_y), "NARLUGA",
                   fill=(210, 230, 255, 240), font=font_title)

    # Tagline with more contrast
    text_draw.text((title_x + 5, title_y + 82),
                   "Transform content into living diagrams",
                   fill=(150, 185, 230, 170), font=font_sub)

    # Specimen labels - more subtle
    labels = [
        (170, 148, "src.01"),
        (400, 185, "node.07"),
        (930, 248, "out.04"),
        (700, 540, "voice.rx"),
        (1100, 348, "svg.gen"),
    ]
    for lx, ly, lt in labels:
        text_draw.text((lx + 10, ly - 14), lt, fill=(90, 130, 190, 55), font=font_label)

    # Bottom-right tagline
    coord_text = "interactive · animated · conversational"
    bbox = text_draw.textbbox((0, 0), coord_text, font=font_label)
    tw = bbox[2] - bbox[0]
    text_draw.text((W - tw - 45, H - 40), coord_text,
                   fill=(110, 150, 210, 90), font=font_label)

    img = Image.alpha_composite(img, text_layer)

    # === FINAL: Flatten and save ===
    final = Image.new("RGB", (W, H), bg_color)
    final.paste(img, (0, 0), img)

    output_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "thumbnail.png")
    final.save(output_path, "PNG", quality=95)
    print(f"Thumbnail saved to: {output_path}")
    print(f"Size: {W}x{H}")

if __name__ == "__main__":
    main()
