# gpt-image-studio

gpt-image-studio is a local-first web UI for `gpt-image-2` image generation and image editing through OpenAI-compatible image APIs.

It is designed for people who want a polished desktop-style image workspace without giving up control of API providers, local history, imported references, and generated files.

## Highlights

- Text-to-image generation through `/images/generations`.
- Image reference editing through `/images/edits`.
- Multiple OpenAI-compatible API profiles with hot switching.
- API health checks that can auto-resolve provider root URLs to `/v1` when needed.
- Multiple output resolutions, including common portrait, landscape, square, 2K, and 4K-style presets.
- Custom size input for providers that accept nonstandard dimensions.
- Multi-image jobs handled locally as one API request per image, so requesting 8 images produces 8 tracked outputs even when a provider ignores `n`.
- Multiple image jobs can run at the same time.
- Per-job progress, partial failure tracking, and cancellation from the left history panel.
- Drag-and-drop, file picker, and `Ctrl+V` clipboard image import.
- Reusable local image library for reference inputs.
- Local SQLite history with prompt, parameters, inputs, outputs, status, and errors.
- Deletion support for history records and imported library images.

## Screenshots

Screenshots are not committed by default because local generated images may contain private prompts, references, or API test data. Add sanitized screenshots under a separate docs/assets directory before publishing if you want a visual README.

## Requirements

- Windows 10 or later.
- Python 3.10+ available in `PATH`.
- An OpenAI-compatible image API that supports the image generation/edit endpoints you want to use.
- An API key for that provider.

The bundled `run.bat` creates and uses a local `.venv` automatically.

## Quick Start

1. Clone or download the project.
2. Run `run.bat`.
3. Open the URL printed in the terminal, usually:

   ```text
   http://127.0.0.1:7862
   ```

4. Click the Settings button in the top-right corner.
5. Add or edit a profile:
   - `Name`: any local profile name.
   - `Base URL`: provider API base, for example `https://api.example.com` or `https://api.example.com/v1`.
   - `API Key`: your provider key.
   - `Model`: usually `gpt-image-2`.
6. Click the test button for the current profile.
7. If the provider exposes models under `/v1/models`, gpt-image-studio can resolve a root URL like `https://api.example.com` into `https://api.example.com/v1`.
8. Save the profile and switch to it.
9. Enter a prompt and generate images.

## Manual Start

If you prefer running commands yourself:

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m image_studio.server
```

To prevent the server from opening a browser automatically:

```powershell
$env:GPT_IMAGE_STUDIO_NO_BROWSER = "1"
.\.venv\Scripts\python.exe -m image_studio.server
```

## Configuration

gpt-image-studio stores local configuration in:

```text
config/config.json
```

An example file is provided at:

```text
config/config.example.json
```

Recommended workflow for a fresh checkout:

```powershell
Copy-Item config\config.example.json config\config.json
```

Then configure providers from the UI.

`config/config.json` is intentionally ignored by Git because it may contain API keys. Do not commit real provider keys.

### Profile Format

```json
{
  "active_profile": "openai-compatible",
  "profiles": [
    {
      "name": "openai-compatible",
      "base_url": "https://api.openai.com/v1",
      "api_key": "",
      "model": "gpt-image-2"
    }
  ],
  "server": {
    "host": "127.0.0.1",
    "port": 7862
  }
}
```

Profile fields:

- `name`: local display name.
- `base_url`: API base URL. Root URLs are accepted when the provider can be resolved to `/v1`.
- `api_key`: provider key. Leave empty in examples and public repos.
- `model`: image model name, defaulting to `gpt-image-2`.

## Local Data

Runtime data is stored under `data/`:

- `data/uploads`: imported reference images.
- `data/outputs`: generated images.
- `data/history.sqlite3`: local generation history.

These files are ignored by Git. They can contain private prompts, references, generated images, and provider metadata.

## Development

Useful checks:

```powershell
.\.venv\Scripts\python.exe -m py_compile image_studio\server.py
node --check static\app.js
```

The app is intentionally simple:

- Backend: FastAPI, Uvicorn, HTTPX, SQLite.
- Frontend: static HTML, CSS, and vanilla JavaScript.
- No build step is required.

## API Compatibility Notes

gpt-image-studio expects an OpenAI-style image API surface:

- `GET /models`
- `POST /images/generations`
- `POST /images/edits`

Some compatible providers expose these endpoints only under `/v1`. When testing a profile, gpt-image-studio checks reasonable base URL candidates and saves the resolved working base URL when possible.

For multi-image generation, gpt-image-studio runs repeated single-image calls and tracks each image separately. This is deliberate because many compatible APIs either ignore `n` or handle it inconsistently.

## Security Notes

- Do not commit `config/config.json`.
- Do not commit `data/`.
- Do not commit `server.out.log` or `server.err.log`.
- Rotate any API key that was previously pasted into a public issue, README, screenshot, or commit.
- Review generated images and prompts before publishing screenshots or demo data.

## License

Add a `LICENSE` file before publishing. MIT is a common choice for small tools, while Apache-2.0 is also common when you want an explicit patent grant.
