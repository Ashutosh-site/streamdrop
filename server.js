const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const dns = require('dns').promises;
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(os.tmpdir(), 'streamdrop');
const STATS_FILE = path.join(DATA_DIR, 'stats.json');
const JOB_DIR = path.join(DATA_DIR, 'jobs');
fs.mkdirSync(JOB_DIR, { recursive: true });

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon'
};

async function readStats() {
  try { return JSON.parse(await fsp.readFile(STATS_FILE, 'utf8')); }
  catch { return { successfulDownloads: 0 }; }
}
async function incrementStats() {
  const s = await readStats();
  s.successfulDownloads = Number(s.successfulDownloads || 0) + 1;
  await fsp.writeFile(STATS_FILE, JSON.stringify(s));
  return s;
}
let statsWrite = Promise.resolve();
function recordSuccessfulDownload() {
  statsWrite = statsWrite.then(() => incrementStats());
  return statsWrite;
}
function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some(Number.isNaN)) return false;
  return p[0] === 10 || p[0] === 127 || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) || p[0] === 0;
}
function isPrivateIPv6(ip) {
  const s = ip.toLowerCase();
  return s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe80:');
}
async function validatePublicUrl(raw) {
  const u = new URL(raw);
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only HTTP/HTTPS URLs are supported.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || isPrivateIPv4(host) || isPrivateIPv6(host)) throw new Error('Private/local URLs are blocked.');
  try {
    const records = await dns.lookup(host, { all: true });
    if (records.some(r => isPrivateIPv4(r.address) || isPrivateIPv6(r.address))) throw new Error('Private/local network targets are blocked.');
  } catch (e) {
    if (e.message.includes('blocked')) throw e;
    if (e.code === 'ENOTFOUND') throw new Error('Could not resolve the video host.');
  }
}
function qualityHeight(q) { return ({ '16k': 8640, '8k': 4320, '4k': 2160, '1080p': 1080, '720p': 720 })[q] || null; }
function isDirectMedia(url) { return /\.(mp4|webm|mov|m4v|ogv|avi|mkv)(?:$|[?#])/i.test(new URL(url).pathname); }
function needsFfmpeg(format) { return ['mp4', 'webm', 'mov', 'audio'].includes(format); }
function findExecutable(command, args = ['--version']) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    child.once('error', reject);
    child.once('close', code => code === 0 ? resolve() : reject(new Error(`Could not run ${command}.`)));
  });
}
async function assertFfmpegAvailable() {
  try { await findExecutable(process.env.FFMPEG_BIN || 'ffmpeg', ['-version']); }
  catch { throw new Error('FFmpeg is required for this format or for merging separate video and audio streams. Install FFmpeg and add its bin folder to PATH, then restart StreamDrop.'); }
}
 function ytDlpCommand() {
  // Render/Linux and Windows: run yt-dlp as a Python module.
  // Optional YTDLP_BIN can still be used when a standalone binary is provided.
  if (process.env.YTDLP_BIN) {
    return {
      command: process.env.YTDLP_BIN,
      prefix: []
    };
  }

  const python = process.env.YTDLP_PYTHON ||
    (process.platform === 'win32' ? 'python' : 'python3');

  return {
    command: python,
    prefix: ['-m', 'yt_dlp']
  };
}

function buildArgs(url, quality, format, out) {
  const h = qualityHeight(quality);
  const cap = h ? `[height<=${h}]` : '';
  let selector;
  if (format === 'audio') selector = 'bestaudio/best';
  else if (format === 'mp4') selector = h ? `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${h}][ext=mp4]/best[height<=${h}]` : 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
  else if (format === 'webm') selector = h ? `bestvideo${cap}+bestaudio/best${cap}` : 'bestvideo+bestaudio/best';
  else selector = h ? `bestvideo${cap}+bestaudio/best${cap}` : 'bestvideo+bestaudio/best';
  const a = [
  '-f', selector,
  '--no-playlist',
  '--newline',
  '--no-warnings',
  '--extractor-args', 'generic:impersonate',
  '--extractor-args', 'youtube:player_client=android,web;player_skip=webpage,configs',
  '-o', out
];
  if (format === 'audio') a.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  if (format === 'mp4') a.push('--merge-output-format', 'mp4');
  if (format === 'webm') a.push('--merge-output-format', 'webm');
  a.push(url);
  return a;
}


function run(cmd, args, cwd) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd, windowsHide: true }); let text = '';
    p.stdout.on('data', d => text += d.toString()); p.stderr.on('data', d => text += d.toString());
    p.on('error', reject); p.on('close', code => code === 0 ? resolve(text) : reject(new Error(text.slice(-5000) || `Process exited ${code}`)));
  });
}
function safeFilename(name) {
  let safe = name.replace(/[<>:"/\\|?*\x00-\x1F]/g, '_');
  safe = safe.replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return safe.slice(0, 200);
}
function asciiFallbackFilename(name) {
  // HTTP header values must be Latin-1/ASCII; strip anything outside that range
  // so the plain filename="..." part never crashes res.writeHead().
  let ascii = name.replace(/[^\x20-\x7E]/g, '_');
  ascii = ascii.replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '');
  return ascii.slice(0, 200) || 'StreamDrop_Download';
}
function directFilename(url, format) {
  const source = path.basename(new URL(url).pathname) || 'download';
  return safeFilename(format === 'original' ? source : `${path.parse(source).name}.${format === 'audio' ? 'mp3' : format}`);
}
async function downloadDirect(url, target) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000), redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`Direct media request failed with HTTP ${response.status}.`);
  await pipeline(response.body, fs.createWriteStream(target, { flags: 'wx' }));
}
function json(res, code, obj) { const body = JSON.stringify(obj); res.writeHead(code, {'Content-Type':'application/json; charset=utf-8'}); res.end(body); }
async function body(req) {
  let data=''; for await (const chunk of req) { data += chunk; if (data.length > 100000) throw new Error('Request too large.'); }
  return JSON.parse(data || '{}');
}

async function getVideoMetadata(url) {
  const ytdlp = ytDlpCommand();
  const metaArgs = [...ytdlp.prefix, '-j', '--no-playlist', '--no-warnings', url];
  const output = await run(ytdlp.command, metaArgs);
  const data = JSON.parse(output);
  return {
    title: data.title || 'Untitled Video',
    duration: data.duration || null,
    uploader: data.uploader || null,
    formats: data.formats ? data.formats.length : 0
  };
}

async function handleMetadata(req, res) {
  let data;
  try { data = await body(req); } catch (e) { return json(res, 400, {message:'Invalid JSON request.'}); }
  const {url} = data;
  if (typeof url !== 'string' || url.length > 4096) return json(res, 400, {message:'Invalid URL.'});
  try { await validatePublicUrl(url); } catch(e) { return json(res, 400, {message:e.message}); }
  try {
    const metadata = await getVideoMetadata(url);
    return json(res, 200, metadata);
  } catch(e) {
    const raw = String(e.message || e).replace(/\s+/g,' ').trim();
    let msg = raw.includes('DRM') || raw.includes('encrypted') ? 'This source is protected/encrypted and cannot be downloaded by StreamDrop.' : `Failed to fetch metadata: ${raw.slice(-900)}`;
    return json(res, 422, {success:false, error:msg, message:msg});
  }
}


async function handleDownload(req, res) {
  let data;
  try { data = await body(req); } catch (e) { return json(res, 400, {message:'Invalid JSON request.'}); }
  const {url, quality='best', format='original'} = data;
  console.log('[DOWNLOAD] Request received');
  console.log('[DOWNLOAD] URL:', url);
  console.log('[DOWNLOAD] Quality:', quality);
  console.log('[DOWNLOAD] Format:', format);
  if (typeof url !== 'string' || url.length > 4096) return json(res, 400, {message:'Invalid URL.'});
  if (!['best','original','16k','8k','4k','1080p','720p'].includes(quality)) return json(res,400,{message:'Invalid quality.'});
  if (!['original','mp4','webm','mov','audio'].includes(format)) return json(res,400,{message:'Invalid format.'});
  try { await validatePublicUrl(url); } catch(e) { console.log('[DOWNLOAD] URL validation failed:', e.message); return json(res, 400, {message:e.message}); }

  const job = path.join(JOB_DIR, `${Date.now()}-${Math.random().toString(36).slice(2,9)}`); await fsp.mkdir(job);
  const template = path.join(job, '%(title)s.%(ext)s');
  try {
    if (needsFfmpeg(format)) { console.log('[DOWNLOAD] Checking FFmpeg availability'); await assertFfmpegAvailable(); }
    if (isDirectMedia(url) && format === 'original') {
      console.log('[DOWNLOAD] Direct media fetch (no yt-dlp needed)');
      await downloadDirect(url, path.join(job, directFilename(url, format)));
    } else {
      const ytdlp = ytDlpCommand();
      const fullArgs = [...ytdlp.prefix, ...buildArgs(url, quality, format, template)];
      console.log('[DOWNLOAD] Starting yt-dlp:', ytdlp.command, fullArgs.join(' '));
      try {
        await run(ytdlp.command, fullArgs, job);
        console.log('[DOWNLOAD] yt-dlp exit code: 0');
      } catch (ytErr) {
        console.log('[DOWNLOAD] yt-dlp exit code: non-zero');
        console.log('[DOWNLOAD] yt-dlp stderr:', ytErr.message);
        throw ytErr;
      }
    }
    let files = (await fsp.readdir(job)).filter(x => !x.endsWith('.part') && !x.endsWith('.ytdl'));
    if (!files.length) throw new Error('No downloadable media was returned by the source.');
    let file = path.join(job, files[0]);
    console.log('[DOWNLOAD] File created:', files[0]);
    if (format === 'mov') {
      const target = path.join(job, path.parse(file).name + '.mov');
      await run(process.env.FFMPEG_BIN || 'ffmpeg', ['-y','-i',file,'-c','copy',target], job);
      await fsp.unlink(file).catch(()=>{}); file = target;
    }
    const st = await fsp.stat(file); const filename = safeFilename(path.basename(file)) || 'StreamDrop_Download';
    const asciiName = asciiFallbackFilename(filename);
    const encodedFilename = encodeURIComponent(filename).replace(/['()]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const mime = format === 'audio' ? 'audio/mpeg' : format === 'webm' ? 'video/webm' : format === 'mov' ? 'video/quicktime' : 'video/mp4';
    res.writeHead(200, {'Content-Type':mime,'Content-Disposition':`attachment; filename="${asciiName.replace(/"/g,'')}"; filename*=UTF-8''${encodedFilename}`,'Content-Length':st.size,'Cache-Control':'no-store','Access-Control-Expose-Headers':'Content-Disposition'});
    let completed = false;
    const stream = fs.createReadStream(file);
    stream.on('error', async () => { if (!res.headersSent) json(res,500,{message:'File streaming failed.'}); await fsp.rm(job,{recursive:true,force:true}); });
    res.on('finish', async () => { if (!completed) { completed=true; await recordSuccessfulDownload(); } await fsp.rm(job,{recursive:true,force:true}); });
    res.on('close', () => { if (!res.writableEnded) stream.destroy(); });
    stream.pipe(res);
  } catch(e) {
    await fsp.rm(job,{recursive:true,force:true}).catch(()=>{});
    const raw = String(e.message || e).replace(/\s+/g,' ').trim();
    let msg = raw.includes('DRM') || raw.includes('encrypted') ? 'This source is protected/encrypted and cannot be downloaded by StreamDrop.' : `Download failed: ${raw.slice(-900)}`;
    return json(res,422,{success:false, error:msg, message:msg});
  }
}

function serveStatic(req,res) {
  let pathname; try { pathname = decodeURIComponent(new URL(req.url,'http://localhost').pathname); } catch { return json(res,400,{message:'Bad URL.'}); }
  if (pathname === '/') pathname = '/index.html';
  const safe = path.normalize(path.join(ROOT, pathname));
  if (!safe.startsWith(ROOT + path.sep) && safe !== ROOT) return json(res,403,{message:'Forbidden.'});
  fs.stat(safe,(err,st)=>{
    if (err || !st.isFile()) return json(res,404,{message:'Not found.'});
    res.writeHead(200, {'Content-Type':TYPES[path.extname(safe).toLowerCase()] || 'application/octet-stream'}); fs.createReadStream(safe).pipe(res);
  });
}

function serveFavicon(req, res) {
  // Keep the endpoint valid even when the optional favicon asset is absent.
  // This is a tiny standards-compliant SVG served at the conventional path.
  const icon = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#2563eb"/><path fill="white" d="M18 16h28v8H26v8h16v8H26v8h20v8H18z"/></svg>';
  res.writeHead(200, {'Content-Type':'image/svg+xml; charset=utf-8', 'Cache-Control':'public, max-age=86400'});
  res.end(icon);
}

const server = http.createServer(async (req,res)=>{
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/health') return json(res,200,{success:true, service:'StreamDrop', status:'ok'});
  if (req.method === 'GET' && req.url.split('?')[0] === '/api/stats') return json(res,200,await readStats());
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/metadata') return handleMetadata(req,res);
  if (req.method === 'POST' && req.url.split('?')[0] === '/api/download') return handleDownload(req,res);
  if (req.method === 'GET' && req.url.split('?')[0] === '/favicon.ico') return serveFavicon(req,res);
  if (req.method === 'GET') return serveStatic(req,res);
  return json(res,405,{message:'Method not allowed.'});
});
server.listen(PORT,()=>console.log(`StreamDrop running at http://localhost:${PORT}`));
