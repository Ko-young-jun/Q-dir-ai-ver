import sys
import os
import json
import struct
import ctypes
from ctypes import wintypes

CF_HDROP = 15
GMEM_MOVEABLE = 0x0002
GMEM_ZEROINIT = 0x0040

user32 = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32

kernel32.GlobalAlloc.argtypes = [wintypes.UINT, ctypes.c_size_t]
kernel32.GlobalAlloc.restype = wintypes.HGLOBAL
kernel32.GlobalLock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalLock.restype = ctypes.c_void_p
kernel32.GlobalUnlock.argtypes = [wintypes.HGLOBAL]
kernel32.GlobalUnlock.restype = wintypes.BOOL
user32.OpenClipboard.argtypes = [wintypes.HWND]
user32.OpenClipboard.restype = wintypes.BOOL
user32.EmptyClipboard.argtypes = []
user32.EmptyClipboard.restype = wintypes.BOOL
user32.SetClipboardData.argtypes = [wintypes.UINT, wintypes.HANDLE]
user32.SetClipboardData.restype = wintypes.HANDLE
user32.CloseClipboard.argtypes = []
user32.CloseClipboard.restype = wintypes.BOOL


def set_file_drop_list(paths):
    # DROPFILES struct: pFiles (DWORD=20), pt.x (LONG=0), pt.y (LONG=0), fNC (BOOL=0), fWide (BOOL=1)
    header = struct.pack("<IiiII", 20, 0, 0, 0, 1)
    files_str = "\0".join(paths) + "\0\0"
    data = header + files_str.encode("utf-16-le")

    h_mem = kernel32.GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, len(data))
    if not h_mem:
        raise RuntimeError("GlobalAlloc failed")
    ptr = kernel32.GlobalLock(h_mem)
    if not ptr:
        raise RuntimeError("GlobalLock failed")
    ctypes.memmove(ptr, data, len(data))
    kernel32.GlobalUnlock(h_mem)

    if not user32.OpenClipboard(None):
        raise RuntimeError("OpenClipboard failed")
    try:
        user32.EmptyClipboard()
        if not user32.SetClipboardData(CF_HDROP, h_mem):
            raise RuntimeError("SetClipboardData failed")
    finally:
        user32.CloseClipboard()


def main():
    raw = sys.stdin.read()
    payload = json.loads(raw)
    paths = [os.path.abspath(p) for p in payload.get("paths", []) if os.path.exists(p)]
    if not paths:
        print(json.dumps({"error": "No valid paths"}, ensure_ascii=False))
        sys.exit(1)
    set_file_drop_list(paths)
    print(json.dumps({"copiedCount": len(paths), "paths": paths}, ensure_ascii=False))


if __name__ == "__main__":
    main()
