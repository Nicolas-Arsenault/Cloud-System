from pathlib import Path
import textwrap


PAGE_WIDTH = 612
PAGE_HEIGHT = 792
LEFT = 48
RIGHT = 564
TOP = 748
BOTTOM = 44


def pdf_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def wrap(text: str, width: int) -> list[str]:
    return textwrap.wrap(text, width=width, break_long_words=False, break_on_hyphens=False)


commands: list[str] = [
    "1 w",
    "0.67 0.30 0.16 RG",
    "48 720 m 564 720 l S",
]

y = TOP


def draw_line(text: str, x: int, y_pos: float, font: str, size: float, rgb: tuple[float, float, float]) -> None:
    r, g, b = rgb
    commands.extend(
        [
            "BT",
            f"{r:.3f} {g:.3f} {b:.3f} rg",
            f"/{font} {size} Tf",
            f"1 0 0 1 {x} {y_pos:.2f} Tm",
            f"({pdf_escape(text)}) Tj",
            "ET",
        ]
    )


def add_block(title: str, body: str) -> None:
    global y

    title_lines = wrap(title, 72)
    for line in title_lines:
      draw_line(line, LEFT, y, "F2", 11.5, (0.12, 0.10, 0.09))
      y -= 14

    for line in wrap(body, 104):
      draw_line(line, LEFT, y, "F1", 9.5, (0.12, 0.10, 0.09))
      y -= 12

    y -= 7


draw_line("CLOUD-SYSTEM", LEFT, y, "F2", 10, (0.67, 0.30, 0.16))
y -= 30
draw_line("Scale & Cost Strategy", LEFT, y, "F2", 23, (0.12, 0.10, 0.09))
y -= 22

subtitle = (
    "One-page writeup based on the current codebase: Express API, Redis cache and queues, "
    "PostgreSQL history/logs, and retailer-scoped workers with dedupe locks, rate limits, "
    "circuit breakers, and per-retailer concurrency."
)
for line in wrap(subtitle, 98):
    draw_line(line, LEFT, y, "F1", 10.5, (0.37, 0.35, 0.33))
    y -= 13

y -= 12

add_block(
    "1. What would be preloaded nightly?",
    "Nightly preload should cover only the highest-probability searches. The current history table "
    "already records successful traffic, so it should drive a warm set of top retailer + zip + query "
    "combinations from the last 7 to 30 days, plus a curated staple list such as milk, eggs, bananas, "
    "bread, detergent, and diapers in major ZIPs. That uses off-peak worker capacity to reduce daytime scrape cost.",
)

add_block(
    "2. What would be triggered on-demand?",
    "Long-tail searches, new terms, low-volume ZIP combinations, and anything not warmed overnight should stay "
    "on-demand. That already matches the current API flow: check Redis first, and if there is a miss, queue the "
    "job on the retailer stream and return 202. This keeps spend aligned with real demand instead of pre-scraping "
    "inventory nobody asks for.",
)

add_block(
    '3. How to prevent 100 users scraping "tide pods" simultaneously?',
    "The current in-flight dedupe lock is the main protection. Because the lock key is retailer + zip + normalized query, "
    "only the first cold request creates work; the next 99 requests reuse the same requestId instead of enqueueing duplicates. "
    "The API also adds per-retailer one-second rate limiting and a global scrape-hour guardrail, so bursts are throttled before "
    "they become runaway scrape cost.",
)

add_block(
    "4. How to cache results efficiently?",
    "Keep Redis as the hot response cache using the existing normalized key pattern "
    "cache:listings:<retailer>:<zip>:<normalized_query>. The next improvement is smarter refresh policy, not a different cache: "
    "refresh hot keys proactively, vary TTL by volatility, and use PostgreSQL history to decide what deserves to stay warm. "
    "A future improvement is semantic normalization with vectors and a small local LLM so near-equivalent queries converge on the same cache bucket more often.",
)

add_block(
    "5. How this scales to 5,000 users",
    "This architecture scales if most reads are cache hits and the worker layer handles only the cold minority. The API path is cheap: "
    "it mostly reads Redis, applies locks and counters, and enqueues jobs, so it can scale horizontally behind shared Redis and PostgreSQL. "
    "Workers can also scale horizontally because queues are retailer-scoped and concurrency is already controlled per retailer. ZIP code can also expand into "
    "a search radius, which improves locality and lets nearby users share warmed keys instead of fragmenting the cache by exact ZIP. The real bottleneck is "
    "scrape volume, so the scale plan is to maximize warm-cache hit rate, dedupe aggressively, keep long-tail queries on-demand, and add workers only as miss volume grows.",
)

footer = (
    "Current codebase anchors: 20-minute Redis listing TTL, 5-minute in-flight locks, retailer Redis streams, per-retailer "
    "rate limiting, scrape_hour guardrail, worker retry/circuit controls, and PostgreSQL history for preload selection and warm-set tuning."
)

if y - 24 < BOTTOM:
    raise SystemExit("Content exceeded one page; tighten the copy or layout.")

commands.extend(
    [
        "0.85 0.81 0.78 RG",
        f"{LEFT} {y - 2:.2f} m {RIGHT} {y - 2:.2f} l S",
    ]
)
y -= 18
for line in wrap(footer, 106):
    draw_line(line, LEFT, y, "F1", 8.5, (0.37, 0.35, 0.33))
    y -= 11

stream = "\n".join(commands).encode("latin-1")

objects = [
    b"<< /Type /Catalog /Pages 2 0 R >>",
    b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    (
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] "
        b"/Resources << /Font << /F1 5 0 R /F2 6 0 R >> >> /Contents 4 0 R >>"
    ),
    b"<< /Length " + str(len(stream)).encode("ascii") + b" >>\nstream\n" + stream + b"\nendstream",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>",
]

pdf = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
offsets = [0]

for index, obj in enumerate(objects, start=1):
    offsets.append(len(pdf))
    pdf.extend(f"{index} 0 obj\n".encode("ascii"))
    pdf.extend(obj)
    pdf.extend(b"\nendobj\n")

xref_offset = len(pdf)
pdf.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
pdf.extend(b"0000000000 65535 f \n")

for offset in offsets[1:]:
    pdf.extend(f"{offset:010d} 00000 n \n".encode("ascii"))

pdf.extend(
    (
        f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\n"
        f"startxref\n{xref_offset}\n%%EOF\n"
    ).encode("ascii")
)

output_path = Path("docs/scale-cost-strategy.pdf")
output_path.write_bytes(pdf)
print(output_path)
