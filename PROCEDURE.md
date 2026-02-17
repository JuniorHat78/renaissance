# Procedure

Simple maintenance flow for this project.

## 1. Run Locally

```powershell
python -m http.server 8000
```

If needed:

```powershell
py -m http.server 8000
```

Open:

`http://localhost:8000/index.html`

## 2. Edit Content

Edit:
- `raw/1.txt` ... `raw/10.txt`
- `data/essays.json` (essay metadata + section titles/subtitles)

## 3. Regenerate Embedded Fallback Data

Run after content/metadata changes:

```powershell
node scripts/generate-embedded-data.js
```

This updates:
- `scripts/chapters-data.js`
- `scripts/essays-data.js`

## 4. Export One Combined Text File

```powershell
node scripts/export-essay-text.js
```

Output:

`exports/etching-god-into-sand.txt`

Note:
- `exports/` is generated output and is ignored by git.

## 5. Quick Smoke Check

Check these URLs:

- `http://localhost:8000/index.html`
- `http://localhost:8000/essay.html?essay=etching-god-into-sand`
- `http://localhost:8000/section.html?essay=etching-god-into-sand&section=1`

## 6. Commit + Push

```powershell
git add .
git commit -m "Update content and regenerate data"
git push origin main
```
