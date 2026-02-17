# Renaissance

An essay archive site.  
Current published essay: `Etching God into Sand`.

## Run locally

Serve the folder with any static server, then open `index.html` in the browser.

PowerShell example:

```powershell
python -m http.server 8000
```

Then visit:

`http://localhost:8000/index.html`

## Routes

- Archive home: `index.html`
- Essay page: `essay.html?essay=etching-god-into-sand`
- Section reader: `section.html?essay=etching-god-into-sand&section=1`

## Notes

- Essay metadata is stored in `data/essays.json`.
- On `http://localhost`, section text is loaded at runtime from `raw/*.txt`.
- Section order for the current essay is defined in `data/essays.json`.
- For direct `file://` opening, the app falls back to `scripts/chapters-data.js` and `scripts/essays-data.js`.

## Refresh file-mode fallback

If you edit `raw/*.txt` or `data/essays.json`, regenerate the fallback data:

```powershell
node scripts/generate-embedded-data.js
```
