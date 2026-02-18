# Procedure

Simple maintenance flow with copy-paste commands.

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

Edit files:
- `raw/*.txt`
- `raw/manifest.json`
- `data/essays.json`

## 3. Validate Content

```powershell
node scripts/validate-content.js
```

## 4. Regenerate Embedded Fallback Data

```powershell
node scripts/generate-embedded-data.js
```

## 5. Validate Everything Before Commit

```powershell
Get-ChildItem -Recurse scripts\*.js | ForEach-Object { node --check $_.FullName }
node scripts/validate-content.js
node scripts/generate-embedded-data.js --check
npm.cmd run test:regression -- --base http://127.0.0.1:8000
```

## 6. Optional Portable Export

```powershell
node scripts/export-essay-text.js
```

Output:

`exports/etching-god-into-sand.txt`

## 7. Quick Smoke Check

- `http://localhost:8000/index.html`
- `http://localhost:8000/essay.html?essay=etching-god-into-sand`
- `http://localhost:8000/section.html?essay=etching-god-into-sand&section=1`
- `http://localhost:8000/search.html?q=sand`

## 8. Commit + Push

```powershell
git add .
git commit -m "Update content and validation artifacts"
git push origin main
```

## 9. Visual QA Workflow

Install dev tooling once:

```powershell
npm.cmd install
```

Capture current screenshots:

```powershell
npm.cmd run visual:capture -- --base http://127.0.0.1:8000
```

Compare against baseline:

```powershell
npm.cmd run visual:diff
```

Approve current as baseline (intentional visual change only):

```powershell
npm.cmd run visual:approve
```

One-shot warning mode:

```powershell
npm.cmd run visual:check -- --base http://127.0.0.1:8000 --warn-only
```
