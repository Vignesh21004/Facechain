# FaceChain — Hacker House Goa Task #3 (SerpApi Fixed)

FaceChain is a privacy-conscious image provenance and evidence-verification demo. It detects a face locally, creates SHA-256 evidence fingerprints, performs a genuine Google Lens reverse-image search through SerpApi, validates returned source URLs, and can optionally anchor the evidence record on Polygon Amoy.

## What was fixed

- Removed the broken direct Google Lens browser POST that could return Google's 403 page.
- Uses the current SerpApi image-upload flow: `POST https://serpapi.com/image` → `image_id` → `engine=google_lens`.
- Keeps `SERPAPI_KEY` on the Node.js server instead of exposing it in frontend JavaScript.
- Compresses the image in the browser to stay below SerpApi's 500 KB Image API limit.
- Uses only built-in Node 18 `fetch`, `FormData`, and `Blob`; no `sharp`, `axios`, or native image dependency is required.
- Provides explicit messages for common SerpApi 401/403/429 errors.
- Keeps Polygon Amoy anchoring optional.

## Requirements

- Node.js 18.17+ (20+ recommended)
- A SerpApi API key for automatic Google Lens search
- Optional: Polygon Amoy wallet + deployed `MatchRegistry.sol` contract

## Run on Windows

1. Extract the ZIP.
2. Open the folder in Command Prompt.
3. Run:

```bash
npm install
```

4. Copy `.env.example` to `.env`.
5. Put your real key in `.env`:

```env
SERPAPI_KEY=YOUR_REAL_SERPAPI_KEY
```

6. Start:

```bash
npm start
```

7. Open `http://localhost:3000`.

Or double-click `run.bat`.

## SerpApi workflow

1. Browser detects a face if the TensorFlow.js model loads.
2. Browser compresses the selected image to <= 480 KB for search.
3. Node hashes the uploaded search image with SHA-256.
4. Node uploads the image to SerpApi Image API.
5. SerpApi returns an `image_id`.
6. Node sends that `image_id` to the Google Lens API.
7. FaceChain displays real exact/visual matches returned by SerpApi.
8. User reviews a source URL.
9. User can optionally anchor the evidence record on Polygon Amoy.

## Important

SerpApi currently documents a 500 KB maximum for Image API uploads and says uploaded image IDs expire after about 10 minutes. The project therefore compresses the image before the search request.

SerpApi usage is account/quota dependent. This project does not claim that SerpApi is unlimited or free.

A Lens match is image/source evidence. It should not be presented as conclusive identification of an unknown person.
