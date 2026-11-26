import sys
import os
import io
import json
import base64
from pypdf import PdfReader, PdfWriter
from reportlab.pdfgen import canvas as rl_canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from PIL import Image

sys.stdout.reconfigure(encoding="utf-8")

KOREAN_FONT_REGISTERED = False


def ensure_korean_font():
    global KOREAN_FONT_REGISTERED
    if KOREAN_FONT_REGISTERED:
        return "Malgun"
    candidates = [
        r"C:\Windows\Fonts\malgun.ttf",
        r"C:\Windows\Fonts\gulim.ttc",
        r"C:\Windows\Fonts\batang.ttc",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                pdfmetrics.registerFont(TTFont("Malgun", path))
                KOREAN_FONT_REGISTERED = True
                return "Malgun"
            except Exception:
                pass
    return "Helvetica"


def hex_to_rgb01(hex_str):
    s = (hex_str or "#000000").lstrip("#")
    if len(s) == 3:
        s = "".join(c * 2 for c in s)
    try:
        return tuple(int(s[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    except Exception:
        return (0.0, 0.0, 0.0)


def get_pdf_info(pdf_path):
    reader = PdfReader(pdf_path)
    pages = []
    for idx, page in enumerate(reader.pages):
        box = page.mediabox
        w = round(float(box.width), 1)
        h = round(float(box.height), 1)
        rot = int(page.get("/Rotate", 0) or 0) % 360
        snippet = ""
        try:
            txt = (page.extract_text() or "").strip()
            snippet = " ".join(txt.split())[:70]
        except Exception:
            pass
        pages.append({
            "index": idx,
            "pageNum": idx + 1,
            "width": w,
            "height": h,
            "rotation": rot,
            "snippet": snippet,
        })
    return {
        "path": pdf_path,
        "pageCount": len(pages),
        "pages": pages,
    }


def make_overlay_page(page_w, page_h, annotations):
    buf = io.BytesIO()
    c = rl_canvas.Canvas(buf, pagesize=(page_w, page_h))
    font_name = ensure_korean_font()

    for ann in annotations:
        kind = ann.get("kind")
        # Coordinates are given in % (0..100) from top-left for intuitive UI placement
        x_pct = float(ann.get("xPct", 10))
        y_pct = float(ann.get("yPct", 10))
        x = (x_pct / 100.0) * page_w
        y_from_top = (y_pct / 100.0) * page_h

        if kind == "rect":
            w = (float(ann.get("wPct", 20)) / 100.0) * page_w
            h = (float(ann.get("hPct", 5)) / 100.0) * page_h
            r, g, b = hex_to_rgb01(ann.get("color", "#ffffff"))
            c.saveState()
            c.setFillColorRGB(r, g, b)
            c.setStrokeColorRGB(r, g, b)
            c.rect(x, page_h - y_from_top - h, w, h, stroke=0, fill=1)
            c.restore()
        elif kind == "text":
            text = str(ann.get("text", ""))
            font_size = float(ann.get("fontSize", 14))
            r, g, b = hex_to_rgb01(ann.get("color", "#111111"))
            c.saveState()
            c.setFont(font_name, font_size)
            c.setFillColorRGB(r, g, b)
            c.drawString(x, page_h - y_from_top - font_size, text)
            c.restore()
        elif kind == "image":
            data_url = ann.get("dataUrl", "")
            if "," in data_url:
                b64 = data_url.split(",", 1)[1]
            else:
                b64 = data_url
            img_bytes = base64.b64decode(b64)
            pil_img = Image.open(io.BytesIO(img_bytes))
            iw, ih = pil_img.size
            w = (float(ann.get("wPct", 18)) / 100.0) * page_w
            h = w * (ih / max(1, iw))
            c.saveState()
            c.drawImage(ImageReader(pil_img), x, page_h - y_from_top - h, width=w, height=h, mask="auto")
            c.restore()

    c.save()
    buf.seek(0)
    return PdfReader(buf).pages[0]


def save_edited_pdf(payload):
    src_path = payload["originalPath"]
    out_path = payload["outputPath"]
    # plan: list of { source: 'main' | 'extra', extraIndex?: int, pageIndex: int, rotateDelta?: int, annotations?: [...] }
    plan = payload.get("pages", [])
    extra_pdfs = payload.get("extraPdfs", [])  # list of { dataUrl or path }

    main_reader = PdfReader(src_path)
    extra_readers = []
    for item in extra_pdfs:
        if item.get("path") and os.path.exists(item["path"]):
            extra_readers.append(PdfReader(item["path"]))
        elif item.get("dataUrl"):
            b64 = item["dataUrl"].split(",", 1)[1] if "," in item["dataUrl"] else item["dataUrl"]
            extra_readers.append(PdfReader(io.BytesIO(base64.b64decode(b64))))
        else:
            extra_readers.append(None)

    writer = PdfWriter()
    for step in plan:
        src_kind = step.get("source", "main")
        p_idx = int(step.get("pageIndex", 0))
        if src_kind == "main":
            if p_idx < 0 or p_idx >= len(main_reader.pages):
                continue
            page = main_reader.pages[p_idx]
        else:
            ex_idx = int(step.get("extraIndex", 0))
            if ex_idx < 0 or ex_idx >= len(extra_readers) or extra_readers[ex_idx] is None:
                continue
            r = extra_readers[ex_idx]
            if p_idx < 0 or p_idx >= len(r.pages):
                continue
            page = r.pages[p_idx]

        rot_delta = int(step.get("rotateDelta", 0)) % 360
        if rot_delta:
            page.rotate(rot_delta)

        anns = step.get("annotations") or []
        if anns:
            box = page.mediabox
            ov = make_overlay_page(float(box.width), float(box.height), anns)
            page.merge_page(ov)

        writer.add_page(page)

    with open(out_path, "wb") as f:
        writer.write(f)

    return {
        "savedPath": out_path,
        "pageCount": len(writer.pages),
        "bytes": os.path.getsize(out_path),
    }


def render_pdf_page(pdf_path, page_index, scale=2.0):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(pdf_path)
    try:
        idx = max(0, min(len(doc) - 1, int(page_index)))
        page = doc[idx]
        pil_img = page.render(scale=float(scale)).to_pil()
        buf = io.BytesIO()
        pil_img.save(buf, format="PNG")
        return buf.getvalue()
    finally:
        doc.close()


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Missing command"}, ensure_ascii=False))
        sys.exit(1)

    cmd = sys.argv[1]
    try:
        if cmd == "info":
            res = get_pdf_info(sys.argv[2])
            print(json.dumps(res, ensure_ascii=False))
        elif cmd == "render":
            pdf_path = sys.argv[2]
            page_idx = int(sys.argv[3]) if len(sys.argv) > 3 else 0
            scale = float(sys.argv[4]) if len(sys.argv) > 4 else 2.0
            png_bytes = render_pdf_page(pdf_path, page_idx, scale)
            sys.stdout.buffer.write(png_bytes)
        elif cmd == "save":
            payload = json.loads(sys.stdin.read())
            res = save_edited_pdf(payload)
            print(json.dumps(res, ensure_ascii=False))
        else:
            print(json.dumps({"error": f"Unknown command: {cmd}"}, ensure_ascii=False))
            sys.exit(1)
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
