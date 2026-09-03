import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import crypto from 'crypto';
import { ethers } from 'ethers';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 3000);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = new Set(['image/jpeg', 'image/png', 'image/webp']);
    if (!allowed.has(file.mimetype)) return cb(new Error('Only JPG, PNG, and WebP images are supported.'));
    cb(null, true);
  }
});

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SOCIAL_DOMAINS = [
  'instagram.com', 'facebook.com', 'x.com', 'twitter.com',
  'threads.net', 'linkedin.com', 'tiktok.com', 'youtube.com'
];

const sha256Hex = (value) => crypto.createHash('sha256').update(value).digest('hex');

function domainOf(value) {
  try { return new URL(value).hostname.replace(/^www\./, '').toLowerCase(); }
  catch { return 'unknown'; }
}

function validHttpUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch { return false; }
}

function socialDomain(value) {
  const host = domainOf(value);
  return SOCIAL_DOMAINS.find(d => host === d || host.endsWith(`.${d}`)) || null;
}

function isSocialUrl(value) { return Boolean(socialDomain(value)); }

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function isValidBbox(b) {
  return b && [b.x,b.y,b.width,b.height].every(Number.isFinite) && b.width > 0 && b.height > 0;
}

function faceDigest(buffer, bbox) {
  const region = isValidBbox(bbox)
    ? JSON.stringify({ x:+bbox.x.toFixed(6), y:+bbox.y.toFixed(6), width:+bbox.width.toFixed(6), height:+bbox.height.toFixed(6) })
    : 'full-image';
  return sha256Hex(Buffer.concat([Buffer.from(`face-region:${region}:`), buffer]));
}

function buildRecordId(imageHash, sourceUrl) {
  return '0x' + sha256Hex(`${imageHash}:${sourceUrl || 'NO_SOURCE'}`);
}

async function serpApiLens(buffer, mimeType) {
  const apiKey = process.env.SERPAPI_KEY?.trim();
  if (!apiKey) {
    const err = new Error('SERPAPI_KEY is missing. Add your SerpApi key to .env and restart the server.');
    err.code = 'SERPAPI_KEY_MISSING';
    throw err;
  }

  // SerpApi Image API accepts JPG/JPEG, PNG and WebP up to 500 KB.
  if (buffer.length > 500 * 1024) {
    const err = new Error('The image sent to SerpApi is over 500 KB. Compress it in the browser and try again.');
    err.code = 'SERPAPI_IMAGE_TOO_LARGE';
    throw err;
  }

  const form = new FormData();
  form.append('image', new Blob([buffer], { type: mimeType || 'image/jpeg' }), 'facechain-image');
  form.append('api_key', apiKey);

  const uploadResponse = await fetch('https://serpapi.com/image', { method: 'POST', body: form });
  const uploadText = await uploadResponse.text();
  let uploadData;
  try { uploadData = JSON.parse(uploadText); } catch { uploadData = {}; }

  if (!uploadResponse.ok || uploadData.error || !uploadData.image_id) {
    const err = new Error(uploadData.error || `SerpApi image upload failed (HTTP ${uploadResponse.status}).`);
    err.status = uploadResponse.status;
    throw err;
  }

  const params = new URLSearchParams({
    engine: 'google_lens',
    image_id: uploadData.image_id,
    type: 'all',
    api_key: apiKey
  });

  const searchResponse = await fetch(`https://serpapi.com/search?${params.toString()}`);
  const searchText = await searchResponse.text();
  let data;
  try { data = JSON.parse(searchText); } catch { data = {}; }

  if (!searchResponse.ok || data.error) {
    const err = new Error(data.error || `SerpApi Google Lens search failed (HTTP ${searchResponse.status}).`);
    err.status = searchResponse.status;
    throw err;
  }

  return data;
}

function normalizeLensResults(data) {
  const out = [];
  const add = (item, type, fallbackScore) => {
    const url = item?.link || item?.url || item?.source_url;
    if (!validHttpUrl(url)) return;
    out.push({
      url,
      title: item?.title || item?.source || '',
      source: item?.source || domainOf(url),
      type,
      score: typeof item?.match_score === 'number' ? item.match_score : fallbackScore,
      thumbnail: item?.thumbnail || item?.image || null
    });
  };

  for (const item of data.exact_matches || []) add(item, 'exact_match', 0.98);
  for (const item of data.visual_matches || []) add(item, 'visual_match', 0.80);
  for (const item of data.related_content || []) add(item, 'related_content', 0.60);
  for (const item of data.image_results || []) add(item, 'image_result', 0.55);

  const unique = new Map();
  for (const item of out) if (!unique.has(item.url)) unique.set(item.url, item);
  return Array.from(unique.values()).slice(0, 30);
}

function evidenceScore(item, index) {
  let score = item.type === 'exact_match' ? 90 : item.type === 'visual_match' ? 70 : 50;
  if (isSocialUrl(item.url)) score += 8;
  score += Math.round(clamp(Number(item.score) || 0, 0, 1) * 2);
  score += Math.max(0, 2 - index);
  return clamp(score, 0, 100);
}

async function anchorOnPolygon({ recordId, imageHash, faceDigestValue, sourceUrl, score }) {
  const privateKey = process.env.POLYGON_PRIVATE_KEY?.trim();
  const contractAddress = process.env.CONTRACT_ADDRESS?.trim();
  if (!privateKey || !contractAddress) {
    return { status: 'demo', txHash: null, explorerUrl: null, recordId, reason: 'Polygon credentials are not configured.' };
  }
  if (!ethers.isAddress(contractAddress)) throw new Error('CONTRACT_ADDRESS is not a valid EVM address.');

  const rpc = process.env.POLYGON_RPC_URL?.trim() || 'https://rpc-amoy.polygon.technology/';
  const provider = new ethers.JsonRpcProvider(rpc, { name: 'polygon-amoy', chainId: 80002 });
  const network = await provider.getNetwork();
  if (Number(network.chainId) !== 80002) throw new Error(`Wrong network. Expected Polygon Amoy (80002), got ${network.chainId}.`);

  const wallet = new ethers.Wallet(privateKey, provider);
  const abi = ['function anchorMatch(bytes32 recordId, bytes32 imageHash, bytes32 faceDigest, string sourceUrl, string sourceDomain, uint16 confidenceBps) external'];
  const contract = new ethers.Contract(contractAddress, abi, wallet);
  const tx = await contract.anchorMatch(recordId, `0x${imageHash}`, `0x${faceDigestValue}`, sourceUrl, domainOf(sourceUrl), Math.round(clamp(score,0,100)*100));
  const receipt = await tx.wait();
  return { status: 'anchored', txHash: receipt.hash, explorerUrl: `https://amoy.polygonscan.com/tx/${receipt.hash}`, recordId };
}

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'FaceChain',
    searchProvider: 'SerpApi Google Lens',
    serpApiConfigured: Boolean(process.env.SERPAPI_KEY?.trim()),
    blockchainConfigured: Boolean(process.env.POLYGON_PRIVATE_KEY?.trim() && process.env.CONTRACT_ADDRESS?.trim()),
    timestamp: new Date().toISOString()
  });
});

app.post('/api/analyze', upload.single('image'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Upload a JPG, PNG, or WebP image.' });

    let bbox = null;
    if (req.body?.bbox) {
      try { const parsed = JSON.parse(req.body.bbox); if (isValidBbox(parsed)) bbox = parsed; } catch {}
    }

    const imageHash = sha256Hex(req.file.buffer);
    const digest = faceDigest(req.file.buffer, bbox);
    const lens = await serpApiLens(req.file.buffer, req.file.mimetype);
    const rawMatches = normalizeLensResults(lens);
    const matches = rawMatches.map((m, i) => ({ ...m, evidenceScore: evidenceScore(m, i), domain: domainOf(m.url) }))
      .sort((a,b) => b.evidenceScore - a.evidenceScore);
    const socialMatches = matches.filter(m => isSocialUrl(m.url));
    const bestMatch = socialMatches[0] || matches[0] || null;
    const recordId = buildRecordId(imageHash, bestMatch?.url || '');

    res.json({
      ok: true,
      provider: 'SerpApi Google Lens',
      detection: { faceDetected: Boolean(bbox), bbox },
      privacy: { imageHash, faceDigest: digest, rawImageStored: false },
      search: {
        genuine: true,
        imageId: lens.search_metadata?.image_id || null,
        matchesFound: matches.length,
        socialMatchesFound: socialMatches.length,
        bestMatch: bestMatch ? { ...bestMatch } : null,
        matches,
        bestGuess: lens.best_guess || lens.search_parameters?.q || null
      },
      evidence: {
        recordId,
        sourceUrl: bestMatch?.url || '',
        sourceDomain: bestMatch ? domainOf(bestMatch.url) : '',
        score: bestMatch?.evidenceScore || 0
      }
    });
  } catch (err) {
    console.error('Analyze error:', err);
    const status = err.status === 401 ? 401 : err.status === 403 ? 403 : err.status === 429 ? 429 : 500;
    let message = err.message || 'Analysis failed.';
    if (status === 401) message = 'SerpApi rejected the API key (401). Check SERPAPI_KEY in .env.';
    if (status === 403) message = 'SerpApi denied this account/request (403). Check your SerpApi account permissions.';
    if (status === 429) message = 'SerpApi quota/rate limit reached (429). Check your remaining searches or wait before retrying.';
    res.status(status).json({ error: message });
  }
});

app.post('/api/anchor', async (req, res) => {
  try {
    const { imageHash, faceDigest: digest, sourceUrl, score = 0 } = req.body || {};
    if (!/^[a-f0-9]{64}$/i.test(imageHash || '')) return res.status(400).json({ error: 'Invalid image SHA-256.' });
    if (!/^[a-f0-9]{64}$/i.test(digest || '')) return res.status(400).json({ error: 'Invalid face digest.' });
    if (!validHttpUrl(sourceUrl)) return res.status(400).json({ error: 'Enter a valid http(s) source URL.' });

    const normalizedScore = clamp(Number(score) || 0, 0, 100);
    const recordId = buildRecordId(imageHash, sourceUrl);
    const chain = await anchorOnPolygon({ recordId, imageHash, faceDigestValue: digest, sourceUrl, score: normalizedScore });
    res.json({ ok: true, source: { url: sourceUrl, domain: domainOf(sourceUrl), social: isSocialUrl(sourceUrl), score: normalizedScore }, chain });
  } catch (err) {
    console.error('Anchor error:', err);
    res.status(500).json({ error: err?.message || 'Blockchain anchoring failed.' });
  }
});

app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Image is too large. Maximum upload is 5 MB.' });
  res.status(400).json({ error: err?.message || 'Request failed.' });
});

app.listen(PORT, () => {
  console.log('========================================');
  console.log('🔥 FaceChain Task #3');
  console.log(`🌐 http://localhost:${PORT}`);
  console.log(`🔎 SerpApi Google Lens: ${process.env.SERPAPI_KEY ? 'CONFIGURED' : 'MISSING KEY'}`);
  console.log(`⛓️ Polygon Amoy: ${process.env.CONTRACT_ADDRESS ? 'CONFIGURED' : 'DEMO MODE'}`);
  console.log('========================================');
});
