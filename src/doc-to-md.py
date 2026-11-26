import sys
import os
import json
import zipfile
import xml.etree.ElementTree as ET

sys.stdout.reconfigure(encoding="utf-8")

HWP_SCRIPTS = os.environ.get("QDIR_HWP_SCRIPTS") or os.path.join(
    os.path.expanduser("~"),
    ".gemini", "config", "plugins", "wku-report-toolkit", "skills", "hwp-toolkit", "scripts"
)
if os.path.isdir(HWP_SCRIPTS) and HWP_SCRIPTS not in sys.path:
    sys.path.insert(0, HWP_SCRIPTS)


def md_escape(cell):
    return str("" if cell is None else cell).replace("\r\n", " ").replace("\n", " ").replace("|", "\\|").strip()


def grid_to_md_table(grid):
    if not grid:
        return ""
    max_cols = max((len(r) for r in grid), default=0)
    if max_cols == 0:
        return ""
    norm = [list(r) + [""] * (max_cols - len(r)) for r in grid]
    header = "| " + " | ".join(md_escape(c) for c in norm[0]) + " |"
    sep = "| " + " | ".join("---" for _ in range(max_cols)) + " |"
    body = ["| " + " | ".join(md_escape(c) for c in row) + " |" for row in norm[1:]]
    return "\n".join([header, sep] + body)


def convert_hwp(path):
    import hwp_lib
    title = os.path.splitext(os.path.basename(path))[0]
    parts = [f"# {title}\n"]
    text = hwp_lib.extract_text(path).strip()
    if text:
        parts.append(text)
    try:
        tables = hwp_lib.extract_tables(path)
        if tables:
            parts.append("\n---\n\n## 표 모음\n")
            for idx, tbl in enumerate(tables, 1):
                grid = hwp_lib.table_grid(tbl)
                md_tbl = grid_to_md_table(grid)
                if md_tbl:
                    parts.append(f"\n### 표 {idx}\n\n{md_tbl}\n")
    except Exception:
        pass
    return "\n\n".join(parts).strip() + "\n"


def convert_docx(path):
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    title = os.path.splitext(os.path.basename(path))[0]
    out = [f"# {title}\n"]
    with zipfile.ZipFile(path, "r") as zf:
        if "word/document.xml" not in zf.namelist():
            return f"# {title}\n\n(본문 없음)\n"
        root = ET.fromstring(zf.read("word/document.xml"))
        body = root.find("w:body", ns)
        if body is None:
            return f"# {title}\n"
        for child in body:
            tag = child.tag.split("}")[-1]
            if tag == "p":
                texts = [t.text for t in child.findall(".//w:t", ns) if t.text]
                line = "".join(texts).strip()
                if line:
                    out.append(line)
            elif tag == "tbl":
                grid = []
                for tr in child.findall("w:tr", ns):
                    row = []
                    for tc in tr.findall("w:tc", ns):
                        cell_txt = " ".join(
                            "".join(t.text for t in p.findall(".//w:t", ns) if t.text).strip()
                            for p in tc.findall(".//w:p", ns)
                        ).strip()
                        row.append(cell_txt)
                    if row:
                        grid.append(row)
                md_tbl = grid_to_md_table(grid)
                if md_tbl:
                    out.append(md_tbl)
    return "\n\n".join(out).strip() + "\n"


def convert_pdf(path):
    import pdfplumber
    title = os.path.splitext(os.path.basename(path))[0]
    out = [f"# {title}\n"]
    with pdfplumber.open(path) as pdf:
        for idx, page in enumerate(pdf.pages, 1):
            out.append(f"## Page {idx}")
            txt = (page.extract_text() or "").strip()
            if txt:
                out.append(txt)
            try:
                tables = page.extract_tables() or []
                for t_idx, tbl in enumerate(tables, 1):
                    clean_grid = [[c or "" for c in row] for row in tbl if any(row)]
                    md_tbl = grid_to_md_table(clean_grid)
                    if md_tbl:
                        out.append(f"### Page {idx} - 표 {t_idx}\n\n{md_tbl}")
            except Exception:
                pass
    return "\n\n".join(out).strip() + "\n"


def convert_xlsx(path):
    import openpyxl
    title = os.path.splitext(os.path.basename(path))[0]
    out = [f"# {title}\n"]
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        for name in wb.sheetnames:
            ws = wb[name]
            rows = []
            for row in ws.iter_rows(values_only=True):
                vals = ["" if v is None else str(v) for v in row]
                while vals and vals[-1] == "":
                    vals.pop()
                if vals:
                    rows.append(vals)
            out.append(f"## {name}")
            if rows:
                out.append(grid_to_md_table(rows))
            else:
                out.append("*(빈 시트)*")
    finally:
        wb.close()
    return "\n\n".join(out).strip() + "\n"


def convert_pptx(path):
    ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
    title = os.path.splitext(os.path.basename(path))[0]
    out = [f"# {title}\n"]
    with zipfile.ZipFile(path, "r") as zf:
        slide_names = sorted(
            [n for n in zf.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")],
            key=lambda s: int("".join(ch for ch in os.path.basename(s) if ch.isdigit()) or "0"),
        )
        for idx, sname in enumerate(slide_names, 1):
            root = ET.fromstring(zf.read(sname))
            texts = [t.text.strip() for t in root.findall(".//a:t", ns) if t.text and t.text.strip()]
            out.append(f"## 슬라이드 {idx}")
            if texts:
                out.append("\n".join(f"- {line}" for line in texts))
    return "\n\n".join(out).strip() + "\n"


def convert_odf(path, ext):
    title = os.path.splitext(os.path.basename(path))[0]
    out = [f"# {title}\n"]
    with zipfile.ZipFile(path, "r") as zf:
        if "content.xml" not in zf.namelist():
            return f"# {title}\n\n(본문 없음)\n"
        root = ET.fromstring(zf.read("content.xml"))
    if ext == ".odp":
        pages = [el for el in root.iter() if el.tag.endswith("}page")]
        for idx, page in enumerate(pages, 1):
            lines = []
            for p in page.iter():
                if p.tag.endswith("}p") or p.tag.endswith("}h"):
                    txt = "".join(p.itertext()).strip()
                    if txt:
                        lines.append(txt)
            out.append(f"## 슬라이드 {idx}")
            if lines:
                out.append("\n".join(f"- {l}" for l in lines))
    elif ext == ".ods":
        for idx, tbl in enumerate([el for el in root.iter() if el.tag.endswith("}table")], 1):
            name = tbl.attrib.get("{urn:oasis:names:tc:opendocument:xmlns:table:1.0}name") or f"Sheet{idx}"
            rows = []
            for tr in [el for el in tbl if el.tag.endswith("}table-row")]:
                vals = [" ".join("".join(tc.itertext()).split()) for tc in tr if tc.tag.endswith("}table-cell")]
                while vals and vals[-1] == "":
                    vals.pop()
                if vals:
                    rows.append(vals)
            out.append(f"## {name}")
            if rows:
                out.append(grid_to_md_table(rows))
    else:
        for el in root.iter():
            if el.tag.endswith("}p") or el.tag.endswith("}h"):
                txt = "".join(el.itertext()).strip()
                if txt:
                    out.append(txt)
    return "\n\n".join(out).strip() + "\n"


def main():
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: doc-to-md.py <inputPath> <outputPath>"}, ensure_ascii=False))
        sys.exit(1)
    src = sys.argv[1]
    dst = sys.argv[2]
    ext = os.path.splitext(src)[1].lower()
    try:
        if ext in (".hwp", ".hwpx"):
            md = convert_hwp(src)
        elif ext == ".docx":
            md = convert_docx(src)
        elif ext == ".pdf":
            md = convert_pdf(src)
        elif ext in (".xlsx", ".xlsm"):
            md = convert_xlsx(src)
        elif ext == ".pptx":
            md = convert_pptx(src)
        elif ext in (".odp", ".odt", ".ods"):
            md = convert_odf(src, ext)
        elif ext in (".txt", ".csv", ".json", ".html", ".htm", ".xml"):
            with open(src, "r", encoding="utf-8", errors="replace") as f:
                md = f"# {os.path.splitext(os.path.basename(src))[0]}\n\n{f.read()}\n"
        else:
            raise ValueError(f"마크다운 변환 미지원 형식: {ext} (지원: hwp, hwpx, docx, pdf, xlsx, pptx, txt)")

        with open(dst, "w", encoding="utf-8") as f:
            f.write(md)
        print(json.dumps({
            "sourcePath": src,
            "outputPath": dst,
            "chars": len(md),
            "bytes": os.path.getsize(dst),
        }, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
