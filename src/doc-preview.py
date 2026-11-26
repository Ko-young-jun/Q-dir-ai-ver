import sys
import os
import json
import base64
import zipfile
import xml.etree.ElementTree as ET

sys.stdout.reconfigure(encoding="utf-8")

HWP_SCRIPTS = os.environ.get("QDIR_HWP_SCRIPTS") or os.path.join(
    os.path.expanduser("~"),
    ".gemini", "config", "plugins", "wku-report-toolkit", "skills", "hwp-toolkit", "scripts"
)
if os.path.isdir(HWP_SCRIPTS) and HWP_SCRIPTS not in sys.path:
    sys.path.insert(0, HWP_SCRIPTS)


def detect_image_mime(raw: bytes) -> str:
    if raw.startswith(b"\x89PNG"):
        return "image/png"
    if raw.startswith(b"GIF8"):
        return "image/gif"
    if raw.startswith(b"\xff\xd8"):
        return "image/jpeg"
    if raw.startswith(b"BM"):
        return "image/bmp"
    return "image/png"


def extract_hwp_prv_image(path: str):
    ext = os.path.splitext(path)[1].lower()
    try:
        if ext == ".hwpx":
            with zipfile.ZipFile(path, "r") as zf:
                for cand in ("Preview/PrvImage.png", "Preview/PrvImage.gif", "Preview/PrvImage.jpg"):
                    if cand in zf.namelist():
                        raw = zf.read(cand)
                        if raw:
                            mime = detect_image_mime(raw)
                            return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
        else:
            import olefile
            with olefile.OleFileIO(path) as ole:
                if ole.exists("PrvImage"):
                    raw = ole.openstream("PrvImage").read()
                    if raw:
                        mime = detect_image_mime(raw)
                        return f"data:{mime};base64,{base64.b64encode(raw).decode('ascii')}"
    except Exception:
        pass
    return None


def preview_hwp(path, max_chars=25000):
    import hwp_lib
    prv_image = extract_hwp_prv_image(path)
    text = hwp_lib.extract_text(path)
    tables_out = []
    try:
        raw_tables = hwp_lib.extract_tables(path)
        for idx, tbl in enumerate(raw_tables[:15], 1):
            grid = hwp_lib.table_grid(tbl)
            # Limit rows/cols for fast preview
            rows = [["" if c is None else str(c) for c in row[:15]] for row in grid[:60]]
            tables_out.append({
                "index": idx,
                "nrows": len(grid),
                "ncols": max((len(r) for r in grid), default=0),
                "rows": rows,
                "truncated": len(grid) > 60,
            })
    except Exception:
        pass

    return {
        "kind": "hwp",
        "docType": os.path.splitext(path)[1].lower().lstrip(".").upper(),
        "previewImage": prv_image,
        "tables": tables_out,
        "content": text[:max_chars],
        "truncated": len(text) > max_chars,
        "totalChars": len(text),
    }


def preview_xlsx(path, max_rows=80, max_cols=20):
    import openpyxl
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    sheets = []
    try:
        for name in wb.sheetnames[:10]:
            ws = wb[name]
            rows = []
            truncated = False
            for r_idx, row in enumerate(ws.iter_rows(values_only=True)):
                if r_idx >= max_rows:
                    truncated = True
                    break
                vals = ["" if v is None else str(v) for v in list(row)[:max_cols]]
                while vals and vals[-1] == "":
                    vals.pop()
                rows.append(vals)
            while rows and not rows[-1]:
                rows.pop()
            sheets.append({"name": name, "rows": rows, "truncated": truncated})
    finally:
        wb.close()
    return {"kind": "xlsx", "sheets": sheets}


def preview_docx(path, max_chars=25000):
    ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
    lines = []
    with zipfile.ZipFile(path, "r") as zf:
        if "word/document.xml" not in zf.namelist():
            return {"kind": "document", "docType": "DOCX", "content": "(본문 없음)", "truncated": False}
        root = ET.fromstring(zf.read("word/document.xml"))
        for p in root.findall(".//w:p", ns):
            texts = [t.text for t in p.findall(".//w:t", ns) if t.text]
            if texts:
                lines.append("".join(texts))
    full = "\n".join(lines)
    return {
        "kind": "document",
        "docType": "DOCX",
        "content": full[:max_chars],
        "truncated": len(full) > max_chars,
        "totalChars": len(full),
    }


def preview_pptx(path, max_chars=25000):
    ns = {"a": "http://schemas.openxmlformats.org/drawingml/2006/main"}
    slides_out = []
    with zipfile.ZipFile(path, "r") as zf:
        slide_names = sorted(
            [n for n in zf.namelist() if n.startswith("ppt/slides/slide") and n.endswith(".xml")],
            key=lambda s: int("".join(ch for ch in os.path.basename(s) if ch.isdigit()) or "0"),
        )
        for idx, sname in enumerate(slide_names, 1):
            root = ET.fromstring(zf.read(sname))
            texts = [t.text.strip() for t in root.findall(".//a:t", ns) if t.text and t.text.strip()]
            if texts:
                slides_out.append(f"=== 슬라이드 {idx} ===\n" + "\n".join(texts))
    full = "\n\n".join(slides_out) if slides_out else "(추출된 텍스트 없음)"
    return {
        "kind": "document",
        "docType": "PPTX",
        "content": full[:max_chars],
        "truncated": len(full) > max_chars,
        "totalChars": len(full),
    }


def decode_zip_name(info):
    name = info.filename
    try:
        if not (info.flag_bits & 0x800):
            name = name.encode("cp437").decode("cp949", errors="replace")
    except Exception:
        pass
    return name


def preview_zip(path, max_entries=150):
    entries = []
    with zipfile.ZipFile(path, "r") as zf:
        infos = zf.infolist()
        for idx, info in enumerate(infos[:max_entries]):
            entries.append({
                "index": idx,
                "name": decode_zip_name(info),
                "size": info.file_size,
                "isDir": info.is_dir(),
            })
        return {
            "kind": "zip",
            "totalEntries": len(infos),
            "truncated": len(infos) > max_entries,
            "entries": entries,
        }


def safe_join(base_dir, rel_path):
    parts = [p for p in rel_path.replace("\\", "/").split("/") if p and p not in (".", "..")]
    target = os.path.abspath(os.path.join(base_dir, *parts)) if parts else os.path.abspath(base_dir)
    if not target.startswith(os.path.abspath(base_dir)):
        raise ValueError("Invalid zip entry path")
    return target


def extract_zip_entry(zip_path, entry_index, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        infos = zf.infolist()
        idx = int(entry_index)
        if idx < 0 or idx >= len(infos):
            raise IndexError("Entry index out of range")
        info = infos[idx]
        if info.is_dir():
            raise ValueError("Cannot open directory entry")
        name = decode_zip_name(info)
        dest = safe_join(out_dir, name)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with zf.open(info, "r") as src, open(dest, "wb") as dst:
            dst.write(src.read())
        return {"extractedPath": dest, "name": os.path.basename(dest)}


def extract_zip_all(zip_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    count = 0
    with zipfile.ZipFile(zip_path, "r") as zf:
        for info in zf.infolist():
            name = decode_zip_name(info)
            dest = safe_join(out_dir, name)
            if info.is_dir():
                os.makedirs(dest, exist_ok=True)
            else:
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with zf.open(info, "r") as src, open(dest, "wb") as dst:
                    dst.write(src.read())
                count += 1
    return {"destDir": out_dir, "fileCount": count}


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "No file path provided"}, ensure_ascii=False))
        sys.exit(1)

    if sys.argv[1] == "--zip-extract-entry":
        try:
            res = extract_zip_entry(sys.argv[2], sys.argv[3], sys.argv[4])
            print(json.dumps(res, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"error": str(e)}, ensure_ascii=False))
            sys.exit(1)
        return

    if sys.argv[1] == "--zip-extract-all":
        try:
            res = extract_zip_all(sys.argv[2], sys.argv[3])
            print(json.dumps(res, ensure_ascii=False))
        except Exception as e:
            print(json.dumps({"error": str(e)}, ensure_ascii=False))
            sys.exit(1)
        return

    target = sys.argv[1]
    base = os.path.basename(target)
    if base.startswith("~$"):
        print(json.dumps({
            "kind": "unsupported",
            "message": "Microsoft Office 임시 잠금 파일(~$)입니다. 원본 문서를 선택해 주세요."
        }, ensure_ascii=False))
        return

    ext = os.path.splitext(target)[1].lower()
    try:
        if ext in (".hwp", ".hwpx"):
            res = preview_hwp(target)
        elif ext in (".xlsx", ".xlsm"):
            res = preview_xlsx(target)
        elif ext == ".docx":
            res = preview_docx(target)
        elif ext == ".pptx":
            res = preview_pptx(target)
        elif ext == ".zip":
            res = preview_zip(target)
        else:
            res = {"error": f"Unsupported extension: {ext}"}
        print(json.dumps(res, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
