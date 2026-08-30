const form = document.getElementById('downloadForm');
const input = document.getElementById('videoUrl');
const statusText = document.getElementById('statusText');
const clearBtn = document.getElementById('clearBtn');
const qualitySelect = document.getElementById('qualitySelect');
const formatSelect = document.getElementById('formatSelect');
const selectionInfo = document.getElementById('selectionInfo');
const historyList = document.getElementById('historyList');
const emptyState = document.getElementById('emptyState');
const clearHistory = document.getElementById('clearHistory');
const privateDownload = document.getElementById('privateDownload');
const themeBtn = document.getElementById('themeBtn');
const progressPanel = document.getElementById('progressPanel');
const progressLabel = document.getElementById('progressLabel');
const progressPercent = document.getElementById('progressPercent');
const progressMeta = document.getElementById('progressMeta');
const progressBar = document.getElementById('progressBar');
const cancelBtn = document.getElementById('cancelBtn');
const globalCount = document.getElementById('globalCount');
const statDownloads = document.getElementById('statDownloads');
const deviceQuality = document.getElementById('deviceQuality');
const deviceProgress = document.getElementById('deviceProgress');

const STORAGE_KEY = 'streamdrop_history_v2';
const API_BASE = '';
const STATS_ENDPOINT = '/api/stats';
const DOWNLOAD_ENDPOINT = '/api/download';
const METADATA_ENDPOINT = '/api/metadata';
let activeController = null;

function readHistory(){ try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); } catch { return []; } }
function writeHistory(items){ localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0,20))); }
function shortUrl(url){ try { const u = new URL(url); return u.hostname + u.pathname; } catch { return url; } }
function isDirectMedia(url){ return /\.(mp4|webm|mov|m4v|ogv|avi|mkv)(?:$|[?#])/i.test(url); }
function escapeHtml(value){ return String(value).replace(/[&<>'"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[ch])); }
function prettyQuality(value){ return ({best:'Best available',original:'Original / Source', '16k':'16K Ultra HD','8k':'8K Ultra HD','4k':'4K Ultra HD','1080p':'1080p Full HD','720p':'720p HD'})[value] || value; }
function prettyFormat(value){ return value === 'audio' ? 'MP3' : value === 'original' ? 'Original' : value.toUpperCase(); }

function renderHistory(){
  const items = readHistory();
  historyList.innerHTML = '';
  emptyState.style.display = items.length ? 'none' : 'block';
  items.forEach((item, index)=>{
    const row = document.createElement('div'); row.className = 'history-item';
    row.innerHTML = `<div class="history-url"><strong>${escapeHtml(item.label)}</strong><span>${escapeHtml(item.when)} • ${escapeHtml(item.quality || 'Best available')} • ${escapeHtml(item.format || 'Original')}</span></div><button class="history-action" data-index="${index}">Use link</button>`;
    historyList.appendChild(row);
  });
}

function setCounter(n){ const value = Math.max(0, Number(n) || 0); globalCount.textContent = value.toLocaleString(); statDownloads.textContent = value.toLocaleString(); }
async function refreshGlobalCount(){
  try {
    const res = await fetch(STATS_ENDPOINT, {cache:'no-store'});
    if(!res.ok) throw new Error('stats unavailable');
    const data = await res.json();
    if(typeof data.successfulDownloads === 'number') setCounter(data.successfulDownloads);
  } catch {
    statusText.textContent = 'Backend unavailable.';
  }
}

async function fetchVideoMetadata(urlStr) {
  try {
    const res = await fetch(METADATA_ENDPOINT, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ url: urlStr })
    });
    if (!res.ok) throw new Error('Metadata unavailable');
    const data = await res.json();
    return data.title || 'Untitled Video';
  } catch {
    return null;
  }
}

function setProgress(percent, label, meta){
  const p = Math.max(0, Math.min(100, percent));
  progressPanel.hidden = false; progressBar.style.width = p + '%'; deviceProgress.style.width = p + '%'; progressPercent.textContent = Math.round(p) + '%'; progressLabel.textContent = label; progressMeta.textContent = meta;
}
function resetProgress(){ progressPanel.hidden = true; progressBar.style.width = '0%'; deviceProgress.style.width = '76%'; progressPercent.textContent = '0%'; }

function updateSelection(){
  const q = qualitySelect.value; const f = formatSelect.value;
  selectionInfo.textContent = q === 'best' ? 'Best available keeps the highest quality exposed by the source/backend.' : `${prettyQuality(q)} requested • ${prettyFormat(f)} output.`;
  deviceQuality.textContent = `${prettyQuality(q)} • ${prettyFormat(f)}`;
}
qualitySelect.addEventListener('change', updateSelection); formatSelect.addEventListener('change', updateSelection); updateSelection();

form.addEventListener('submit', async (event)=>{
  event.preventDefault();
  const value = input.value.trim(); if(!value) return;
  let url; try { url = new URL(value); } catch { statusText.textContent = 'Please paste a valid URL.'; return; }
  if(!/^https?:$/.test(url.protocol)){ statusText.textContent = 'Only HTTP/HTTPS links are supported.'; return; }

  activeController = new AbortController(); cancelBtn.disabled = false;
  const q = qualitySelect.value, f = formatSelect.value;
  setProgress(8, 'Preparing download…', `${prettyQuality(q)} • ${prettyFormat(f)}`); statusText.textContent = 'Checking the downloadable source…';

  try{
    const videoTitle = await fetchVideoMetadata(url.href);
    if (videoTitle) {
      setProgress(12, 'Video found', `Title: ${videoTitle}`);
    }
    
    const response = await fetch(DOWNLOAD_ENDPOINT, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ url:url.href, quality:q, format:f }), signal:activeController.signal
    });

    if(!response.ok){
      let serverMessage = null;
      try {
        const errData = await response.json();
        serverMessage = errData && (errData.message || errData.error);
      } catch { /* response wasn't JSON, fall through to generic message */ }
      throw new Error(serverMessage || `Download API unavailable (HTTP ${response.status}).`);
    }
    const contentType = response.headers.get('content-type') || '';
    if(contentType.includes('application/json')){
      const data = await response.json();
      if(!data.downloadUrl) throw new Error(data.message || 'No download URL returned');
      setProgress(55, 'Starting file transfer…', 'Resolver selected the requested quality/format');
      const a = document.createElement('a'); a.href = data.downloadUrl; a.download = ''; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
    } else {
      setProgress(55, 'Streaming file…', 'Browser transfer started');
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = blobUrl; a.download = getResponseFilename(response, url, f); document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(blobUrl), 1000);
    }
    setProgress(100, 'Download started ✓', 'Success recorded by server');
    statusText.textContent = 'Download started successfully.';
    if (!privateDownload || !privateDownload.checked) { saveHistory(url.href, q, f); }
    refreshGlobalCount();
  } catch(err){
    if(err.name === 'AbortError'){ statusText.textContent = 'Download cancelled.'; resetProgress(); }
    else {
      statusText.textContent = err.message || 'Download failed.';
      setProgress(0, 'Download failed', err.message || 'The server could not resolve or fetch this source');
    }
  } finally { activeController = null; cancelBtn.disabled = false; }
});

function decodeContentDispositionFilename(header){
  if(!header) return null;
  const star = header.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
  if(star){ try { return decodeURIComponent(star[1].trim().replace(/^\"|\"$/g,'')); } catch {} }
  const normal = header.match(/filename\s*=\s*\"([^\"]+)\"/i) || header.match(/filename\s*=\s*([^;]+)/i);
  return normal ? normal[1].trim() : null;
}
function getResponseFilename(response, url, format){
  const fromHeader = decodeContentDispositionFilename(response.headers.get('content-disposition'));
  if(fromHeader) return fromHeader;
  return dataFileName(url, format);
}
function dataFileName(url, format){ const base = (url.pathname.split('/').pop() || 'download'); if(format==='original') return base; return base.replace(/\.[^.]+$/, '') + '.' + (format==='audio'?'mp3':format); }
function saveHistory(url,q,f){ const items = readHistory(); items.unshift({label:shortUrl(url), when:new Date().toLocaleString(), quality:prettyQuality(q), format:prettyFormat(f)}); writeHistory(items); renderHistory(); }
cancelBtn.addEventListener('click', ()=>{ if(activeController) activeController.abort(); });
clearBtn.addEventListener('click', ()=>{ input.value=''; input.focus(); statusText.textContent='Use only content you own or are explicitly allowed to download.'; resetProgress(); });
clearHistory.addEventListener('click', ()=>{ localStorage.removeItem(STORAGE_KEY); renderHistory(); });
historyList.addEventListener('click', e=>{ const btn=e.target.closest('[data-index]'); if(!btn) return; const item=readHistory()[Number(btn.dataset.index)]; if(item){ input.value = item.label.startsWith('http') ? item.label : ''; input.focus(); }});

const savedTheme = localStorage.getItem('streamdrop_theme'); if(savedTheme==='light') document.body.classList.add('light'); themeBtn.textContent=document.body.classList.contains('light')?'☾':'☼';
themeBtn.addEventListener('click', ()=>{ document.body.classList.toggle('light'); const light=document.body.classList.contains('light'); localStorage.setItem('streamdrop_theme', light?'light':'dark'); themeBtn.textContent=light?'☾':'☼'; });

renderHistory(); refreshGlobalCount(); setInterval(refreshGlobalCount, 5000);
