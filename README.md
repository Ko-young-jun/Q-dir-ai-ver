# Q-Dir AI — 4분할 파일 탐색기 + 문서·이미지·PDF 편집 + AI(MCP) 연동

Windows 4분할 탐색기(Q-Dir)의 핵심 워크플로우를 재구현하고, **사람(웹 UI)과 AI 에이전트(MCP 서버)**가 실시간으로 협업할 수 있도록 만든 로컬 파일·문서·이미지·PDF 작업 도구입니다.

## 주요 기능

- **4분할(Quad) 파일 탐색기**: 6종 레이아웃(4분할/좌우/상하/좌1우2/상1하2/1분할), 멀티 탭, 드라이브 바, `Q-Dir.ini` 확장자별 색상 필터, 드래그 앤 드롭(복사 / `Shift+드롭` 이동), Windows 표준 단축키(`Ctrl+C/X/V/A`, `F2`, `Delete`, `Backspace`, `Alt+←/→`)
- **저토큰 AI(MCP) 실시간 협업**:
  - `📌 AI전달` 원클릭 경로 전달 (긴 경로 복사·붙여넣기 불필요)
  - `🤖 AI 작업 파일` 실시간 하이라이트 & Windows 탐색기 열기(`📂`)
  - 초압축 컨텍스트(`qdir_get_context`) 및 로컬 텍스트 검색(`qdir_grep`)으로 AI 토큰 절감
  - **Antigravity · Codex · Claude Desktop · Claude Code** 모두 지원 (MCP 도구 17종)
- **업무 문서 미리보기**: `.hwp`/`.hwpx`(원본 미리보기 이미지·표·텍스트 3단 탭), `.xlsx`(시트별 표), `.pdf`(원본 뷰어), `.docx`/`.pptx`, `.zip`(내부 파일 더블클릭 즉시 열기 · 바로 미리보기 · 압축 풀기)
- **내장 이미지 편집기 (`✏️ 편집`)**:
  - 포스터에 QR코드/로고 `Ctrl+V` 붙여넣기·이동·크기조절·자유회전(`-180°~+180°`)
  - 우측 `📑 레이어` 패널, 사각/자유 올가미 선택(복제·오려내기·투명삭제)
  - `🧹 투명지우개`, `🪄 마술봉 누끼`, `🤍 흰배경 제거`, `✨ AI 누끼(rembg)`
  - `🤖 AI 수정영역` 드래그 지정 → 원본+참조이미지+좌표+메모를 AI에 원클릭 전달
  - 휠 줌인/줌아웃, 드래그 화면 이동(팬), 밝기·대비·채도 보정, 모자이크, Windows 단축키
- **내장 WYSIWYG PDF 편집기 (`✏️ PDF 편집`)**:
  - 페이지 순서 변경·90° 회전·삭제·다른 PDF 병합·선택 페이지 추출
  - `T 텍스트 추가`(PDF 위 원하는 위치 클릭해 바로 타이핑, 한글 지원), 드래그 `⬜ 가리기`, `🖼️ 도장/QR`(`Ctrl+V`)

---

## 설치 방법 (Windows)

### 필수 요구사항
- [Node.js (LTS)](https://nodejs.org/) 18 이상
- *(선택 — Excel/PDF/HWP 미리보기·편집 및 AI 누끼용)* Python 3.10 이상

### 1. 다운로드 및 원클릭 설치
PowerShell에서 아래 명령어를 실행합니다:

```powershell
git clone https://github.com/Ko-young-jun/Q-dir-ai-ver.git
cd Q-dir-ai-ver
powershell -ExecutionPolicy Bypass -File .\setup.ps1
```

`setup.ps1`이 자동으로 다음을 수행합니다:
1. `npm install` 실행
2. PC에 설치된 **Antigravity / Codex / Claude Desktop / Claude Code**에 `qdir-ai` MCP 서버 자동 등록
3. 바탕화면에 **`Q-Dir AI`** 바로가기 생성

### 2. *(선택)* 문서·PDF·AI 누끼 기능용 Python 패키지 설치
```powershell
pip install openpyxl pypdf pypdfium2 reportlab pillow olefile "rembg[cpu]"
```

### 3. 실행
- 바탕화면의 **`Q-Dir AI`** 바로가기를 더블클릭하거나, 터미널에서 `npm start` 후 브라우저에서 `http://127.0.0.1:4747`을 엽니다.
- AI 연동을 사용하려면 **사용 중인 AI 앱(Antigravity, Codex, Claude 등)을 재시작**해 주세요.

## 라이선스
MIT License
