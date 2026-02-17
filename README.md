# Renaissance

Renaissance is a clean, book-style static website for long-form essays.

Current published essay:
- `Etching God into Sand`

## Quick Start

Run a local static server from the project root:

```powershell
python -m http.server 8000
```

If `python` is not available:

```powershell
py -m http.server 8000
```

Open:

`http://localhost:8000/index.html`

## Routes

- Home archive: `index.html`
- Essay page: `essay.html?essay=etching-god-into-sand`
- Section reader: `section.html?essay=etching-god-into-sand&section=1`

## Project Structure

- `raw/*.txt`: section source text files
- `data/essays.json`: essay metadata and section titles/subtitles
- `scripts/content.js`: data loading, rendering helpers, search helpers
- `scripts/archive.js`: home/archive page logic
- `scripts/essay.js`: essay page + section list + in-essay search
- `scripts/section.js`: section reader page
- `styles/site.css`: site theme and typography

## Content Workflow

After editing `raw/*.txt` or `data/essays.json`, regenerate embedded fallback files:

```powershell
node scripts/generate-embedded-data.js
```

Export all 10 sections into one portable text file:

```powershell
node scripts/export-essay-text.js
```

Output:

`exports/etching-god-into-sand.txt`

## Deployment

This project is designed for GitHub Pages project-site deployment:

`https://juniorhat78.github.io/renaissance/`
