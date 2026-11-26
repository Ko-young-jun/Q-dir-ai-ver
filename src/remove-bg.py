import sys
import json
import base64

sys.stdout.reconfigure(encoding="utf-8")


def main():
    try:
        raw_in = sys.stdin.read()
        payload = json.loads(raw_in)
        data_url = payload.get("dataUrl", "")
        if "," in data_url:
            b64 = data_url.split(",", 1)[1]
        else:
            b64 = data_url
        img_bytes = base64.b64decode(b64)

        from rembg import remove
        out_bytes = remove(img_bytes)
        out_b64 = base64.b64encode(out_bytes).decode("ascii")
        print(json.dumps({"dataUrl": f"data:image/png;base64,{out_b64}"}, ensure_ascii=False))
    except Exception as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
