import { FFmpeg } from '../vendor/ffmpeg/index.js';
import { fetchFile, toBlobURL } from '../vendor/util/index.js';
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, SEGMENT_SECONDS,
  FISH_TTS_URL, FISH_MODEL, MAGIC_HOUR_BASE, MAGIC_HOUR_MODEL
} from './config.js';

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let ffmpeg = null;
let isPremium = false;
let currentScript = [];
let availableVoices = [];
let voiceoverBlob = null;
let finalVideoBlob = null;
let isGenerating = false;
let abortController = null;
let videoUrl = null;
let isValidated = false;

// ==========================================
// 1. SUPABASE (comptes & abonnement)
// ==========================================
let supabaseClient = null;
if (window.supabase) supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function openLogin() { $('loginModal').classList.add('open'); }
function closeLogin() { $('loginModal').classList.remove('open'); }

async function loginMagicLink() {
  if (!supabaseClient) { toast('Client Supabase non disponible.', 'err'); return; }
  const email = $('loginEmail').value.trim();
  const msg = $('loginMsg');
  if (!email) { msg.innerHTML = '<span class="text-red-400">Veuillez saisir une adresse e-mail.</span>'; return; }
  msg.innerHTML = '<span class="text-sky-400">Envoi du lien magique...</span>';
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin + window.location.pathname }
  });
  msg.innerHTML = error
    ? `<span class="text-red-400">${esc(error.message)}</span>`
    : '<span class="text-emerald-400">Lien envoyé ! Consultez votre boîte mail.</span>';
}

async function checkUser() {
  if (!supabaseClient) return;
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    const btn = $('btnAuth');
    if (!session) {
      isPremium = false;
      updateSaaSUI('Gratuit', 'Connexion', false);
      btn.onclick = openLogin;
      return;
    }
    const { data } = await supabaseClient.from('subscriptions').select('status').eq('user_id', session.user.id).maybeSingle();
    isPremium = (data?.status === 'active' || data?.status === 'trialing');
    const name = esc(session.user.email.split('@')[0]);
    updateSaaSUI(isPremium ? 'Creator' : 'Gratuit', name, isPremium);
    btn.onclick = async () => { await supabaseClient.auth.signOut(); toast('Déconnecté.'); checkUser(); };
  } catch (e) { console.warn('Erreur session Supabase :', e); }
}

function updateSaaSUI(badgeText, btnText, premium) {
  const badge = $('authStatus');
  const btn = $('btnAuth');
  const hint = $('planHint');
  badge.textContent = badgeText;
  badge.classList.toggle('premium', premium);
  btn.innerHTML = `<i class="fa-solid ${premium ? 'fa-crown text-amber-300' : 'fa-user'}"></i> ${btnText}`;
  if (hint) hint.textContent = premium ? 'Mode Creator : export HD (720p/1080p)' : 'Mode Gratuit : 480p max';
  checkResAccess();
}

function checkResAccess() {
  const res = $('exportRes').value;
  if ((res === '720' || res === '1080') && !isPremium) {
    toast('La résolution HD (720p/1080p) est réservée au plan Creator. Passage en 480p.', 'err');
    $('exportRes').value = '480';
  }
  drawPreviewCanvas();
}

if (supabaseClient) { supabaseClient.auth.onAuthStateChange(() => checkUser()); checkUser(); }

// ==========================================
// 2. NAVIGATION, THÈME & NOTIFICATIONS
// ==========================================
function go(n) {
  for (let i = 1; i <= 3; i++) {
    $('s' + i).classList.toggle('hidden-s', i !== n);
    $('tab' + i).classList.toggle('on', i === n);
  }
  if (n === 2) drawPreviewCanvas();
  if (n === 3) {
    $('dlFormatLabel').textContent = '.' + (finalVideoBlob?.type.includes('webm') ? 'webm' : $('exportFormat').value);
    $('dlSrtBtn').classList.toggle('hidden-s', !$('burnSubtitles').checked);
  }
}

function toast(msg, type = 'info') {
  const t = document.createElement('div');
  t.className = 't' + (type === 'err' ? ' err' : type === 'ok' ? ' ok' : '');
  t.textContent = msg;
  $('toast').appendChild(t);
  setTimeout(() => t.remove(), 3800);
}

function applyThemeIcon(isDark) {
  $('themeIcon').className = isDark ? 'fa-solid fa-sun text-amber-400' : 'fa-solid fa-moon text-sky-600';
}

function toggleTheme() {
  const isDark = document.documentElement.classList.toggle('dark');
  document.body.classList.toggle('dark', isDark);
  applyThemeIcon(isDark);
  localStorage.setItem('theme', isDark ? 'dark' : 'light');
  drawPreviewCanvas();
}

(function initTheme() {
  const light = localStorage.getItem('theme') === 'light';
  document.documentElement.classList.toggle('dark', !light);
  document.body.classList.toggle('dark', !light);
  applyThemeIcon(!light);
})();

function togglePass(id) {
  const inp = $(id);
  inp.type = inp.type === 'password' ? 'text' : 'password';
}

function setProgress(pct, statusText) {
  $('rBar').style.width = `${Math.min(100, Math.max(0, pct))}%`;
  $('rPct').textContent = `${Math.round(pct)}%`;
  if (statusText) $('rStatus').textContent = statusText;
}

// ==========================================
// 3. SYNTHÈSE VOCALE, PRÉRÉGLAGES & SCRIPT
// ==========================================
const PRESETS = {
  cnc: { topic: "l'usinage CNC haute précision sur un bloc d'aluminium brossé", lang: 'fr', dur: '20', theme: 'macro' },
  forge: { topic: "le martelage de l'acier incandescent sur l'enclume dans une forge traditionnelle", lang: 'fr', dur: '20', theme: 'cinematic' },
  rain: { topic: "les gouttes de pluie ruisselant doucement sur une verrière la nuit", lang: 'fr', dur: '30', theme: 'watercolor' },
  cyber: { topic: "a lone spacecraft drifting past a glowing nebula in deep space", lang: 'en', dur: '20', theme: '3d' }
};

function applyPreset() {
  const key = $('presetSelect').value;
  if (!key || !PRESETS[key]) return;
  const p = PRESETS[key];
  $('topic').value = p.topic;
  $('lang').value = p.lang;
  $('dur').value = p.dur;
  $('visualTheme').value = p.theme;
  loadVoices();
  generateScript();
}

function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  availableVoices = window.speechSynthesis.getVoices();
  const lang = $('lang').value;
  const sel = $('voiceSelect');
  const filtered = availableVoices.filter(v => v.lang.toLowerCase().startsWith(lang));
  const list = filtered.length ? filtered : availableVoices;
  sel.innerHTML = list.map(v => `<option value="${esc(v.name)}">${esc(v.name)} (${esc(v.lang)})</option>`).join('');
}
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
  loadVoices();
}

function speakText(text) {
  if (!('speechSynthesis' in window) || !$('ttsEnabled').checked || !text) return;
  window.speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  const voice = availableVoices.find(v => v.name === $('voiceSelect').value);
  if (voice) { utt.voice = voice; utt.lang = voice.lang; }
  utt.rate = parseFloat($('ttsRate').value) || 0.85;
  utt.pitch = parseFloat($('ttsPitch').value) || 0.90;
  window.speechSynthesis.speak(utt);
}

function speakSegment(i) { speakText(currentScript[i]); }
function stopVoice() { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); }

function testVoice() {
  speakText($('lang').value === 'fr' ? 'Bienvenue dans le studio FaceVideo IA.' : 'Welcome to FaceVideo AI Studio.');
}

function readFullScript() {
  if (!currentScript.length) { toast('Générez ou ajoutez un script.', 'err'); return; }
  speakText(currentScript.join(' ... '));
}

function updateSegment(i, value) {
  currentScript[i] = value;
  $('estDurationBadge').textContent = `~${currentScript.length * SEGMENT_SECONDS}s estimées`;
}

function renderSegments() {
  $('segCount').textContent = currentScript.length;
  $('estDurationBadge').textContent = `~${currentScript.length * SEGMENT_SECONDS}s estimées`;

  if (!currentScript.length) {
    $('segs').innerHTML = `<div class="text-xs opacity-75 text-center py-12">Générez un script ou ajoutez manuellement des segments pour commencer.</div>`;
    return;
  }

  $('segs').innerHTML = currentScript.map((s, i) => `
    <div class="seg-box p-3 rounded-lg border text-sm flex flex-col gap-1.5 transition-all">
      <div class="flex items-center justify-between">
        <span class="text-[10px] text-sky-400 font-bold uppercase tracking-wider">Segment ${i + 1} · ${SEGMENT_SECONDS}s</span>
        <div class="flex items-center gap-2">
          <button class="text-xs opacity-75 hover:opacity-100 hover:text-sky-400" onclick="speakSegment(${i})" title="Écouter"><i class="fa-solid fa-volume-low"></i></button>
          <button class="text-xs opacity-75 hover:opacity-100 hover:text-amber-400" onclick="moveSegment(${i}, -1)" ${i === 0 ? 'disabled' : ''} title="Monter"><i class="fa-solid fa-arrow-up"></i></button>
          <button class="text-xs opacity-75 hover:opacity-100 hover:text-amber-400" onclick="moveSegment(${i}, 1)" ${i === currentScript.length - 1 ? 'disabled' : ''} title="Descendre"><i class="fa-solid fa-arrow-down"></i></button>
          <button class="text-xs opacity-75 hover:opacity-100 hover:text-red-400" onclick="deleteSegment(${i})" title="Supprimer"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>
      <textarea class="inp !text-xs" rows="2" oninput="updateSegment(${i}, this.value)">${esc(s)}</textarea>
    </div>
  `).join('');
}

function addSegment() {
  currentScript.push($('lang').value === 'fr' ? 'Nouveau segment narratif à personnaliser...' : 'New narrative segment to customize...');
  renderSegments();
}
function deleteSegment(idx) { currentScript.splice(idx, 1); renderSegments(); }
function moveSegment(idx, dir) {
  const n = idx + dir;
  if (n < 0 || n >= currentScript.length) return;
  [currentScript[idx], currentScript[n]] = [currentScript[n], currentScript[idx]];
  renderSegments();
}

function generateScript() {
  const lang = $('lang').value;
  const topic = $('topic').value.trim() || (lang === 'fr' ? 'ambiance sonore mécanique' : 'mechanical soundscape');
  const dur = parseInt($('dur').value) || 10;
  const sentences = lang === 'fr' ? [
    `Bienvenue dans cette expérience immersive dédiée à ${topic}.`,
    `Prenez un instant pour observer la précision de chaque mouvement.`,
    `Chaque détail compte, chaque texture révèle une harmonie subtile.`,
    `Le contraste entre la matière brute et la douceur sonore apaise l'esprit.`,
    `Inspirez profondément, puis laissez la tension se dissiper lentement.`,
    `Les vibrations résonnent avec clarté dans cet espace hors du temps.`,
    `Nous explorons ensemble les moindres nuances visuelles et acoustiques.`,
    `La régularité du rythme crée une sensation de calme absolu.`,
    `Observez la lumière glisser délicatement sur les surfaces.`,
    `Un dernier instant de contemplation avant de conclure en douceur.`,
    `Merci d'avoir partagé ce moment de sérénité.`,
    `À très bientôt pour une nouvelle exploration sensorielle.`
  ] : [
    `Welcome to this immersive experience dedicated to ${topic}.`,
    `Take a moment to observe the precision of every single motion.`,
    `Every detail matters, every texture reveals a subtle harmony.`,
    `The contrast between raw material and soft acoustics calms the mind.`,
    `Take a deep breath, and let all tension slowly fade away.`,
    `Vibrations resonate clearly through this timeless space.`,
    `Together, we explore every subtle visual and acoustic nuance.`,
    `The steady rhythm creates a deep sense of tranquility.`,
    `Watch the light glide delicately across every surface.`,
    `One final moment of contemplation before we conclude softly.`,
    `Thank you for sharing this peaceful moment.`,
    `See you soon for another sensory exploration.`
  ];
  const count = Math.min(sentences.length, Math.max(2, Math.ceil(dur / SEGMENT_SECONDS)));
  currentScript = sentences.slice(0, count);
  renderSegments();
  toast('Script généré ! Vous pouvez éditer chaque segment.', 'ok');
}

// ==========================================
// 4. GESTION DES PROJETS (LOCALSTORAGE)
// ==========================================
const getProjects = () => { try { return JSON.parse(localStorage.getItem('fv_projects') || '[]'); } catch { return []; } };
const setProjects = list => localStorage.setItem('fv_projects', JSON.stringify(list.slice(0, 20)));

function saveCurrentProject() {
  if (!currentScript.length) { toast('Rien à sauvegarder : le script est vide.', 'err'); return; }
  const projects = getProjects();
  projects.unshift({
    id: Date.now(),
    title: ($('topic').value.trim() || 'Projet sans titre').slice(0, 45),
    date: new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }),
    lang: $('lang').value,
    dur: $('dur').value,
    theme: $('visualTheme').value,
    script: [...currentScript]
  });
  setProjects(projects);
  toast('Projet sauvegardé localement !', 'ok');
}

function openProjectsModal() {
  const projects = getProjects();
  const listEl = $('projectsList');
  listEl.innerHTML = !projects.length
    ? `<p class="text-xs opacity-75 text-center py-6">Aucun projet sauvegardé.</p>`
    : projects.map((p, idx) => `
      <div class="sub-box p-3 rounded-lg border flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="text-xs font-bold truncate">${esc(p.title)}</div>
          <div class="text-[10px] opacity-75">${esc(p.date)} · ${p.script.length} segments · ${esc(String(p.lang).toUpperCase())}</div>
        </div>
        <div class="flex gap-1.5 shrink-0">
          <button class="btn b-main !py-1 !px-2.5 !text-xs" onclick="loadProject(${idx})">Charger</button>
          <button class="btn b-danger !py-1 !px-2 !text-xs" onclick="deleteProject(${idx})"><i class="fa-solid fa-trash"></i></button>
        </div>
      </div>`).join('');
  $('projectsModal').classList.add('open');
}
function closeProjectsModal() { $('projectsModal').classList.remove('open'); }

function loadProject(idx) {
  const p = getProjects()[idx];
  if (!p) return;
  $('topic').value = p.title;
  $('lang').value = p.lang;
  $('dur').value = p.dur;
  $('visualTheme').value = p.theme;
  currentScript = [...p.script];
  loadVoices();
  renderSegments();
  closeProjectsModal();
  go(1);
  toast('Projet chargé !', 'ok');
}

function deleteProject(idx) {
  const projects = getProjects();
  projects.splice(idx, 1);
  setProjects(projects);
  openProjectsModal();
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

function exportProjects() {
  const projects = getProjects();
  if (!projects.length) { toast('Aucun projet à exporter.', 'err'); return; }
  downloadBlob(new Blob([JSON.stringify(projects, null, 2)], { type: 'application/json' }), 'facevideo_projets.json');
}

function importProjects(input) {
  const file = input.files?.[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const data = JSON.parse(reader.result);
      if (!Array.isArray(data)) throw new Error('format invalide');
      const clean = data.filter(p => p && Array.isArray(p.script) && p.script.every(s => typeof s === 'string'))
        .map(p => ({ id: Date.now() + Math.random(), title: String(p.title || 'Projet importé').slice(0, 45), date: String(p.date || ''), lang: p.lang === 'en' ? 'en' : 'fr', dur: String(p.dur || '10'), theme: String(p.theme || 'cinematic'), script: p.script }));
      setProjects([...clean, ...getProjects()]);
      openProjectsModal();
      toast(`${clean.length} projet(s) importé(s).`, 'ok');
    } catch (e) { toast('Import impossible : ' + e.message, 'err'); }
    input.value = '';
  };
  reader.readAsText(file);
}

// ==========================================
// 5. CANVAS PREVIEW & PIPELINE IA
// ==========================================
function drawPreviewCanvas(activeSegmentIdx = -1, statusOverlay = '') {
  const canvas = $('cv');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;

  const theme = $('visualTheme').value;
  const grads = {
    cinematic: ['#0f172a', '#1e293b'], macro: ['#18181b', '#27272a'],
    anime: ['#1e1b4b', '#312e81'], '3d': ['#042f2e', '#115e59'], watercolor: ['#2e1065', '#4c1d95']
  };
  const [c1, c2] = grads[theme] || grads.cinematic;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, c1); g.addColorStop(1, c2);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  ctx.strokeStyle = 'rgba(255,255,255,0.05)';
  ctx.lineWidth = 1;
  for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
  for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillRect(16, 16, 210, 26);
  ctx.fillStyle = '#38bdf8';
  ctx.font = '600 11px "JetBrains Mono", monospace';
  ctx.textAlign = 'left';
  ctx.fillText(`STYLE: ${theme.toUpperCase()} · ${$('exportRes').value}P`, 24, 33);

  if (!isPremium) {
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.font = '700 13px Inter, sans-serif';
    ctx.fillText('FaceVideo Studio · Gratuit', w - 190, h - 18);
  }

  ctx.fillStyle = '#f8fafc';
  ctx.textAlign = 'center';
  if (activeSegmentIdx >= 0 && currentScript[activeSegmentIdx]) {
    ctx.font = '600 15px Inter, sans-serif';
    wrapCanvasText(ctx, `"${currentScript[activeSegmentIdx]}"`, w / 2, h / 2 - 10, w - 80, 22);
  } else if (currentScript.length) {
    ctx.font = '600 16px Inter, sans-serif';
    ctx.fillText(`Storyboard prêt : ${currentScript.length} scènes (${currentScript.length * SEGMENT_SECONDS}s)`, w / 2, h / 2 - 10);
    ctx.font = '400 12px Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Cliquez sur "Lancer le pipeline IA" ou "Mode Démo"', w / 2, h / 2 + 16);
  } else {
    ctx.font = '500 14px Inter, sans-serif';
    ctx.fillStyle = '#94a3b8';
    ctx.fillText('Aucun segment de script défini (Étape 1)', w / 2, h / 2);
  }

  if (statusOverlay) {
    ctx.fillStyle = 'rgba(2, 132, 199, 0.9)';
    ctx.fillRect(0, h - 36, w, 36);
    ctx.fillStyle = '#fff';
    ctx.font = '600 12px "JetBrains Mono", monospace';
    ctx.fillText(statusOverlay, w / 2, h - 14);
  }
  ctx.textAlign = 'left';
}

function wrapCanvasText(ctx, text, x, y, maxWidth, lineHeight) {
  const words = text.split(' ');
  let line = '';
  for (let n = 0; n < words.length; n++) {
    const test = line + words[n] + ' ';
    if (ctx.measureText(test).width > maxWidth && n > 0) {
      ctx.fillText(line, x, y);
      line = words[n] + ' ';
      y += lineHeight;
    } else line = test;
  }
  ctx.fillText(line, x, y);
}

async function generateVoiceoverFish(text, signal) {
  const apiKey = $('fishAudioKey').value.trim();
  if (!apiKey) throw new Error('Clé API Fish Audio manquante.');
  const response = await fetch(FISH_TTS_URL, {
    method: 'POST', signal,
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'model': FISH_MODEL },
    body: JSON.stringify({ text, format: 'mp3' })
  });
  if (!response.ok) throw new Error(`Erreur Fish Audio (${response.status})`);
  return await response.blob();
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Annulé', 'AbortError')); }, { once: true });
  });
}

async function generateVideoClipMagicHour(prompt, resolution, signal) {
  const apiKey = $('magicHourKey').value.trim();
  if (!apiKey) throw new Error('Clé API Magic Hour manquante.');
  const headers = { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };

  const createRes = await fetch(`${MAGIC_HOUR_BASE}/text-to-video`, {
    method: 'POST', signal, headers,
    body: JSON.stringify({
      name: `FaceVideo ${Date.now()}`,
      model: MAGIC_HOUR_MODEL,
      end_seconds: SEGMENT_SECONDS,
      duration: SEGMENT_SECONDS,
      resolution: `${resolution}p`,
      style: { prompt }
    })
  });
  if (!createRes.ok) throw new Error(`Erreur création Magic Hour (${createRes.status})`);
  const job = await createRes.json();
  const jobId = job.id;
  if (!jobId) throw new Error('Magic Hour : identifiant de tâche absent de la réponse.');

  const deadline = Date.now() + 10 * 60 * 1000; // 10 min max par clip
  while (Date.now() < deadline) {
    await sleep(5000, signal);
    const statusRes = await fetch(`${MAGIC_HOUR_BASE}/video-projects/${jobId}`, { signal, headers: { 'Authorization': `Bearer ${apiKey}` } });
    if (!statusRes.ok) throw new Error(`Erreur de statut Magic Hour (${statusRes.status})`);
    const status = await statusRes.json();
    if (status.status === 'complete') {
      const url = status.downloads?.[0]?.url || status.download_url;
      if (!url) throw new Error('Magic Hour : aucun lien de téléchargement dans la réponse.');
      return url;
    }
    if (status.status === 'error' || status.status === 'canceled') {
      throw new Error('Erreur lors de la génération vidéo Magic Hour');
    }
  }
  throw new Error('Magic Hour : délai dépassé pour un clip.');
}

async function loadFFmpeg() {
  if (ffmpeg) return;
  const inst = new FFmpeg();
  // Le moteur FFmpeg (32 Mo) est chargé depuis un CDN pour garder le dépôt léger.
  const bases = [
    'https://unpkg.com/@ffmpeg/core@0.12.6/dist/umd',
    'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.6/dist/umd'
  ];
  let lastErr;
  for (const base of bases) {
    try {
      await inst.load({
        coreURL: await toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      });
      ffmpeg = inst;
      return;
    } catch (e) { lastErr = e; }
  }
  throw new Error('Chargement de FFmpeg impossible : ' + (lastErr?.message || 'réseau'));
}

async function run(args) {
  const code = await ffmpeg.exec(args);
  if (code !== 0) throw new Error(`FFmpeg a échoué (code ${code}).`);
}

async function assembleVideo(videoSources, audioBlob) {
  await loadFFmpeg();
  const list = [];
  for (let i = 0; i < videoSources.length; i++) {
    let data;
    try { data = await fetchFile(videoSources[i]); }
    catch (e) { throw new Error(`Téléchargement du clip ${i + 1} impossible (CORS ou réseau).`); }
    await ffmpeg.writeFile(`clip${i}.mp4`, data);
    list.push(`file 'clip${i}.mp4'`);
  }
  await ffmpeg.writeFile('list.txt', list.join('\n'));
  if (audioBlob) await ffmpeg.writeFile('voiceover.mp3', await fetchFile(audioBlob));

  // Concaténation : copie directe, sinon ré-encodage de secours
  try { await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'video_only.mp4']); }
  catch { await run(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-an', 'video_only.mp4']); }

  const webm = $('exportFormat').value === 'webm';
  const outName = `final_video.${webm ? 'webm' : 'mp4'}`;
  const vArgs = webm ? ['-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8'] : ['-c:v', 'copy'];

  if (audioBlob) {
    await run(['-i', 'video_only.mp4', '-i', 'voiceover.mp3', ...vArgs, '-c:a', webm ? 'libopus' : 'aac', '-map', '0:v:0', '-map', '1:a:0', '-shortest', outName]);
  } else {
    await run(['-i', 'video_only.mp4', ...vArgs, '-an', outName]);
  }

  const out = await ffmpeg.readFile(outName);
  return new Blob([out.buffer], { type: webm ? 'video/webm' : 'video/mp4' });
}

const STEP_LABELS = [
  '1. Validation du script & des paramètres',
  '2. Génération de la voix off (Fish Audio)',
  '3. Génération des clips vidéo (Magic Hour)',
  '4. Assemblage final & encodage (FFmpeg)'
];

function updateStepUI(num, status) {
  for (let i = 1; i <= 4; i++) {
    const el = $('step' + i);
    if (!el) continue;
    if (i < num || (i === num && status === 'done')) {
      el.innerHTML = `<i class="fa-solid fa-check-circle text-emerald-400"></i> ${STEP_LABELS[i - 1]}`;
      el.classList.remove('opacity-50');
    } else if (i === num && status === 'loading') {
      el.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin text-sky-400"></i> ${STEP_LABELS[i - 1]}`;
      el.classList.remove('opacity-50');
    } else {
      el.innerHTML = `<i class="fa-regular fa-circle text-slate-500"></i> ${STEP_LABELS[i - 1]}`;
      el.classList.add('opacity-50');
    }
  }
}

function setBusy(busy) {
  isGenerating = busy;
  $('btnRender').disabled = busy;
  $('btnDemo').disabled = busy;
  $('btnCancel').classList.toggle('hidden-s', !busy);
}

async function generateFullVideoAI() {
  if (isGenerating) return;
  if (!currentScript.length) generateScript();
  if (!currentScript.every(s => s.trim())) { toast('Un segment est vide : complétez ou supprimez-le.', 'err'); return; }
  checkResAccess();

  setBusy(true);
  isValidated = false;
  abortController = new AbortController();
  const signal = abortController.signal;
  $('pipelineSteps').classList.remove('hidden-s');
  setProgress(5, 'Initialisation du pipeline...');

  try {
    updateStepUI(1, 'loading');
    await sleep(300, signal);
    updateStepUI(1, 'done');
    setProgress(15, 'Script validé.');

    updateStepUI(2, 'loading');
    setProgress(25, 'Génération de la voix off via Fish Audio...');
    drawPreviewCanvas(0, 'Synthèse vocale en cours...');
    voiceoverBlob = await generateVoiceoverFish(currentScript.join(' '), signal);
    updateStepUI(2, 'done');
    setProgress(40, 'Voix off générée.');

    updateStepUI(3, 'loading');
    const videoUrls = [];
    const style = $('visualTheme').value;
    const res = $('exportRes').value;
    for (let i = 0; i < currentScript.length; i++) {
      setProgress(40 + (i / currentScript.length) * 45, `Génération clip ${i + 1}/${currentScript.length}...`);
      drawPreviewCanvas(i, `Génération vidéo IA (${i + 1}/${currentScript.length})...`);
      videoUrls.push(await generateVideoClipMagicHour(`${style} cinematic visual, high detail, smooth motion: ${currentScript[i]}`, res, signal));
    }
    updateStepUI(3, 'done');
    setProgress(85, 'Tous les clips sont prêts.');

    updateStepUI(4, 'loading');
    setProgress(90, 'Assemblage final avec FFmpeg (peut prendre quelques minutes)...');
    drawPreviewCanvas(-1, 'Montage & encodage FFmpeg...');
    finalVideoBlob = await assembleVideo(videoUrls, voiceoverBlob);
    updateStepUI(4, 'done');
    setProgress(100, 'Rendu terminé avec succès !');
    finalizeOutput();
  } catch (err) {
    if (err.name === 'AbortError') {
      setProgress(0, 'Rendu annulé par l’utilisateur.');
      toast('Pipeline annulé.');
    } else {
      console.error(err);
      toast(err.message, 'err');
      $('rStatus').textContent = 'Erreur : ' + err.message;
    }
  } finally {
    abortController = null;
    setBusy(false);
    drawPreviewCanvas();
  }
}

async function generateLocalDemoVideo() {
  if (isGenerating) return;
  if (!currentScript.length) generateScript();
  if (typeof MediaRecorder === 'undefined') { toast('MediaRecorder non supporté par ce navigateur.', 'err'); return; }

  setBusy(true);
  $('btnCancel').classList.add('hidden-s');
  isValidated = false;
  voiceoverBlob = null;
  $('pipelineSteps').classList.remove('hidden-s');

  try {
    updateStepUI(2, 'done');
    updateStepUI(3, 'loading');
    setProgress(10, 'Rendu des scènes locales (Canvas)...');

    const mimeType = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find(t => MediaRecorder.isTypeSupported(t)) || '';
    const recorder = new MediaRecorder($('cv').captureStream(30), mimeType ? { mimeType } : undefined);
    const chunks = [];
    recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    const done = new Promise(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' })); });

    recorder.start();
    for (let i = 0; i < currentScript.length; i++) {
      setProgress(10 + ((i + 1) / currentScript.length) * 80, `Rendu scène démo ${i + 1}/${currentScript.length}...`);
      drawPreviewCanvas(i, `APERÇU DÉMO · SCÈNE ${i + 1}/${currentScript.length}`);
      await new Promise(r => setTimeout(r, 1200));
    }
    recorder.stop();
    finalVideoBlob = await done;

    updateStepUI(4, 'done');
    setProgress(100, 'Vidéo démo prête (format .webm).');
    finalizeOutput();
  } catch (e) {
    toast('Erreur mode démo : ' + e.message, 'err');
  } finally {
    setBusy(false);
    drawPreviewCanvas();
  }
}

function finalizeOutput() {
  if (videoUrl) URL.revokeObjectURL(videoUrl);
  videoUrl = URL.createObjectURL(finalVideoBlob);
  $('player').src = videoUrl;
  $('videoContainer').classList.remove('hidden-s');
  $('noVideoMsg').classList.add('hidden-s');
  toast('Vidéo générée avec succès !', 'ok');
  go(3);
}

function cancelRender() {
  if (abortController) abortController.abort();
  if (ffmpeg) { try { ffmpeg.terminate(); } catch {} ffmpeg = null; } // relancé au prochain rendu
}

// ==========================================
// 6. EXPORT & SOUS-TITRES (.SRT)
// ==========================================
function approve() {
  if (!videoUrl) { toast('Générez d\'abord la vidéo.', 'err'); return; }
  isValidated = true;
  toast('Montage validé ! Prêt pour le téléchargement.', 'ok');
}

function dlVideo() {
  if (!finalVideoBlob) { toast('Aucune vidéo à télécharger.', 'err'); return; }
  if (!isValidated) { toast('Veuillez d\'abord cliquer sur "Valider le montage".', 'err'); return; }
  const ext = finalVideoBlob.type.includes('webm') ? 'webm' : 'mp4';
  downloadBlob(finalVideoBlob, `facevideo_ai_${$('exportRes').value}p.${ext}`);
}

function dlAudio() {
  if (!voiceoverBlob) { toast('Aucune piste audio IA générée (le mode démo n\'en produit pas).', 'err'); return; }
  downloadBlob(voiceoverBlob, 'facevideo_voiceover.mp3');
}

function formatSrtTime(total) {
  const p = (n, l = 2) => String(n).padStart(l, '0');
  return `${p(Math.floor(total / 3600))}:${p(Math.floor((total % 3600) / 60))}:${p(Math.floor(total % 60))},000`;
}

function dlSrt() {
  if (!currentScript.length) { toast('Aucun script pour générer les sous-titres.', 'err'); return; }
  const srt = currentScript.map((text, i) =>
    `${i + 1}\n${formatSrtTime(i * SEGMENT_SECONDS)} --> ${formatSrtTime((i + 1) * SEGMENT_SECONDS)}\n${text}\n`
  ).join('\n');
  downloadBlob(new Blob([srt], { type: 'text/plain;charset=utf-8' }), 'facevideo_subtitles.srt');
  toast('Fichier sous-titres (.srt) téléchargé !', 'ok');
}

// ==========================================
// 7. EXPOSITION GLOBALE & INITIALISATION
// ==========================================
Object.assign(window, {
  go, openLogin, closeLogin, loginMagicLink, toggleTheme, togglePass,
  applyPreset, loadVoices, testVoice, stopVoice, readFullScript, speakSegment, updateSegment,
  generateScript, addSegment, deleteSegment, moveSegment,
  saveCurrentProject, openProjectsModal, closeProjectsModal, loadProject, deleteProject, exportProjects, importProjects,
  drawPreviewCanvas, checkResAccess, generateFullVideoAI, generateLocalDemoVideo, cancelRender,
  approve, dlVideo, dlAudio, dlSrt
});

$('magicHourKey').value = localStorage.getItem('mh_key') || '';
$('fishAudioKey').value = localStorage.getItem('fish_key') || '';
$('magicHourKey').addEventListener('change', e => localStorage.setItem('mh_key', e.target.value));
$('fishAudioKey').addEventListener('change', e => localStorage.setItem('fish_key', e.target.value));

updateStepUI(0, 'idle');
renderSegments();
drawPreviewCanvas();
