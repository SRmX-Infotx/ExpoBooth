import { get, getAll, put, remove } from './db.js';
import { toCSV, fromCSV, localDate } from './csv.js';

const $ = selector => document.querySelector(selector);
const DEFAULTS = {
  event: '', staff: '', interests: 'Product A, Product B, Product C',
  consent: 'The visitor agrees to be contacted and to have this information stored.',
  headerFade: 0, footerFade: 0
};
let files = [];
let contacts = [];

// Small preferences (settings, shortcuts, unfinished form).
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem('expobooth.' + key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem('expobooth.' + key, JSON.stringify(value)); }
  catch { showError('This setting could not be saved.'); }
}
let settings = { ...DEFAULTS, ...read('settings', {}) };
let pins = read('pins', []);

function showError(message) {
  const banner = $('#banner');
  banner.textContent = message + ' (tap to close)';
  banner.hidden = false;
}
$('#banner').onclick = () => { $('#banner').hidden = true; };

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}
const title = file => file.name.replace(/\.[^.]+$/, '');
const extension = file => file.name.split('.').pop().toLowerCase();
const sortedFiles = kind => files.filter(f => f.kind === kind)
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
const urls = new Map();
function urlFor(file) {
  if (!urls.has(file.id)) urls.set(file.id, URL.createObjectURL(file.blob));
  return urls.get(file.id);
}
// crypto.randomUUID needs https, so keep a fallback.
const newId = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2);

/* ---------- Tabs ---------- */
function showTab(name) {
  document.querySelectorAll('main > section').forEach(s => { s.hidden = s.id !== name; });
  document.querySelectorAll('#tabs button').forEach(b =>
    b.toggleAttribute('aria-current', b.dataset.tab === name));
  if (name === 'settings') showStorage();
  scrollTo(0, 0);
}
$('#tabs').onclick = e => { if (e.target.dataset.tab) showTab(e.target.dataset.tab); };

/* ---------- Lists ---------- */
function renderFiles() {
  const videos = sortedFiles('video');
  $('#loop').disabled = !videos.length;

  $('#videoList').replaceChildren(...videos.map((file, index) => el('div', { className: 'card' },
    el('video', { src: urlFor(file) + '#t=0.5', preload: 'metadata', muted: true, playsInline: true }),
    el('button', { className: 'tile play', textContent: '▶ ' + title(file), onclick: () => play(videos, index) }),
    el('button', { className: 'danger', textContent: 'Delete', onclick: () => deleteFile(file) }))));
  if (!videos.length) $('#videoList').append(el('p', { textContent: 'No videos yet. Tap Import videos.' }));

  const slides = sortedFiles('slides');
  $('#slideList').replaceChildren(...slides.map(file => el('div', { className: 'row' },
    el('button', {
      className: 'star', textContent: pins.includes(file.id) ? '★' : '☆',
      ariaLabel: 'Show on Home', onclick: () => togglePin(file.id)
    }),
    el('button', { className: 'grow', onclick: () => openSlides(file) },
      title(file), el('small', { textContent: extension(file).toUpperCase() })),
    el('button', { className: 'danger', textContent: 'Delete', onclick: () => deleteFile(file) }))));
  if (!slides.length) $('#slideList').append(el('p', { textContent: 'No presentations yet. Tap Import files.' }));

  const pinned = pins.map(id => slides.find(f => f.id === id)).filter(Boolean);
  $('#pinned').replaceChildren(...pinned.map(file => el('div', { className: 'card' },
    el('button', { className: 'tile', textContent: title(file), onclick: () => openSlides(file) }))));
  if (!pinned.length) $('#pinned').append(el('button', {
    textContent: 'Choose shortcuts: tap ☆ on a presentation', onclick: () => showTab('slides')
  }));
}

function togglePin(id) {
  pins = pins.includes(id) ? pins.filter(p => p !== id) : [...pins, id];
  write('pins', pins);
  renderFiles();
}

async function importFiles(input, kind, allowed) {
  const label = input.parentElement;
  const text = label.firstChild.textContent;
  const chosen = [...input.files];
  label.firstChild.textContent = 'Importing…';
  input.disabled = true;
  const failed = [];
  for (const source of chosen) {
    if (!allowed.includes(extension(source))) { failed.push(`${source.name} (file type not supported)`); continue; }
    // Never overwrite: add a number if the name already exists.
    let name = source.name;
    for (let n = 2; files.some(f => f.kind === kind && f.name === name); n++) {
      name = source.name.replace(/(\.[^.]+)$/, ` ${n}$1`);
    }
    try {
      // The database keeps its own copy; large videos are not loaded into memory.
      const id = newId();
      await put('files', { id, kind, name, blob: source });
      files.push(await get('files', id));
    } catch (error) {
      failed.push(`${source.name} (${error.name === 'QuotaExceededError' ? 'not enough space' : error.message})`);
    }
  }
  input.value = '';
  input.disabled = false;
  label.firstChild.textContent = text;
  renderFiles();
  if (failed.length) showError('Could not import: ' + failed.join(', '));
}
$('#addVideo').onchange = e => importFiles(e.target, 'video', ['mp4', 'mov', 'm4v', 'webm']);
$('#addSlides').onchange = e => importFiles(e.target, 'slides', ['pdf', 'ppt', 'pptx']);

async function deleteFile(file) {
  if (!confirm(`Delete "${file.name}" from the app?`)) return;
  try {
    await remove('files', file.id);
    files = files.filter(f => f.id !== file.id);
    pins = pins.filter(p => p !== file.id);
    write('pins', pins);
    URL.revokeObjectURL(urls.get(file.id));
    urls.delete(file.id);
    renderFiles();
  } catch (error) { showError('Could not delete: ' + error.message); }
}

/* ---------- Keep the screen awake ---------- */
async function keepAwake() {
  try { await navigator.wakeLock?.request('screen'); } catch { /* Auto-Lock setting covers this */ }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) keepAwake(); });
document.addEventListener('click', keepAwake, { once: true });

/* ---------- Video player ---------- */
const video = $('#video');
let playlist = [], current = 0, errors = 0;
function play(list, index) {
  if (!list.length) return;
  playlist = list;
  current = index % list.length;
  $('#player').hidden = false;
  $('#playerTitle').textContent = title(list[current]);
  video.src = urlFor(list[current]);
  // If the iPad blocks automatic playback, the play control stays available.
  video.play().catch(() => {});
}
video.onended = () => play(playlist, current + 1);
video.onplaying = () => { errors = 0; };
video.onerror = () => {
  if ($('#player').hidden) return;
  showError(`This video cannot be played: ${playlist[current].name}`);
  if (++errors < playlist.length) play(playlist, current + 1); else closePlayer();
};
function closePlayer() {
  $('#player').hidden = true;
  video.pause();
  video.removeAttribute('src');
  video.load();
}
$('#loop').onclick = () => { errors = 0; play(sortedFiles('video'), 0); };
$('#next').onclick = () => play(playlist, current + 1);
$('#closePlayer').onclick = closePlayer;

/* ---------- Presentations ---------- */
let pdfLibrary, loading, pdf, page = 1, drawing, request = 0;

async function openSlides(file) {
  if (extension(file) !== 'pdf') return openElsewhere(file);
  const mine = ++request;
  $('#viewer').hidden = false;
  $('#viewerTitle').textContent = title(file);
  $('#page').textContent = 'Opening…';
  clearCanvas();
  try {
    pdfLibrary ??= await import('./pdf.min.js');
    pdfLibrary.GlobalWorkerOptions.workerSrc = new URL('./pdf.worker.min.js', import.meta.url).href;
    const data = await file.blob.arrayBuffer();
    if (mine !== request) return;
    loading = pdfLibrary.getDocument({ data, wasmUrl: new URL('./', import.meta.url).href });
    const loaded = await loading.promise;
    if (mine !== request) return;
    pdf = loaded;
    page = 1;
    await draw();
  } catch (error) {
    if (mine !== request) return;
    closeViewer();
    showError(`Could not open ${file.name}: ${error.message}`);
  }
}

function clearCanvas() { $('#canvas').width = 0; $('#canvas').height = 0; }

async function draw() {
  if (!pdf) return;
  const doc = pdf, number = page;
  drawing?.cancel();
  const sheet = await doc.getPage(number);
  if (doc !== pdf || number !== page) return;
  const stage = $('#stage');
  const natural = sheet.getViewport({ scale: 1 });
  const fit = Math.min(stage.clientWidth / natural.width, stage.clientHeight / natural.height);
  const view = sheet.getViewport({ scale: fit * Math.min(devicePixelRatio, 2) });
  // Draw off screen first so the old slide stays until the new one is ready.
  const buffer = el('canvas', { width: Math.floor(view.width), height: Math.floor(view.height) });
  const task = sheet.render({ canvas: buffer, viewport: view });
  drawing = task;
  try { await task.promise; }
  catch (error) { if (error.name === 'RenderingCancelledException') return; throw error; }
  if (doc !== pdf || number !== page) return;
  const canvas = $('#canvas');
  canvas.width = buffer.width;
  canvas.height = buffer.height;
  canvas.style.width = natural.width * fit + 'px';
  canvas.style.height = natural.height * fit + 'px';
  canvas.getContext('2d').drawImage(buffer, 0, 0);
  canvas.dataset.page = number;
  $('#page').textContent = `${number} / ${doc.numPages}`;
}

function go(step) {
  if (!pdf) return;
  const next = Math.min(Math.max(page + step, 1), pdf.numPages);
  if (next === page) return;
  page = next;
  draw().catch(error => showError('Could not show this slide: ' + error.message));
}

function closeViewer() {
  request++;
  drawing?.cancel();
  loading?.destroy();
  loading = pdf = undefined;
  $('#viewer').hidden = true;
}

// PowerPoint files are handed to PowerPoint or Keynote through the share menu.
async function openElsewhere(file) {
  const copy = new File([file.blob], file.name, { type: file.blob.type || 'application/octet-stream' });
  try {
    if (navigator.canShare?.({ files: [copy] })) await navigator.share({ files: [copy] });
    else download(copy);
  } catch (error) {
    if (error.name !== 'AbortError') showError('Could not open this file. Convert it to PDF and import that.');
  }
}

$('#prev').onclick = () => go(-1);
$('#forward').onclick = () => go(1);
$('#closeViewer').onclick = closeViewer;
let startX = null;
$('#stage').onpointerdown = e => { startX = e.clientX; };
$('#stage').onpointercancel = () => { startX = null; };
$('#stage').onpointerup = e => {
  if (startX === null) return;
  const moved = e.clientX - startX;
  startX = null;
  if (Math.abs(moved) > 50) go(moved < 0 ? 1 : -1);
  else go(e.clientX < innerWidth / 3 ? -1 : 1);
};
addEventListener('keydown', e => {
  if ($('#viewer').hidden) return;
  if (['ArrowRight', 'ArrowDown', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); go(1); }
  if (['ArrowLeft', 'ArrowUp', 'PageUp'].includes(e.key)) { e.preventDefault(); go(-1); }
  if (e.key === 'Escape') closeViewer();
});
addEventListener('resize', () => { if (pdf) draw().catch(() => {}); });

/* ---------- Contacts ---------- */
const form = $('#form');
const field = name => form.elements.namedItem(name);
let editing = null, original = '';

function renderContacts() {
  const query = $('#search').value.trim().toLowerCase();
  const shown = contacts
    .filter(c => `${c.name} ${c.company} ${c.email} ${c.phone}`.toLowerCase().includes(query))
    .sort((a, b) => b.created - a.created);
  $('#contactList').replaceChildren(...shown.map(c => el('div', { className: 'row' },
    el('button', { className: 'grow contact', onclick: () => openForm(c) },
      el('strong', { textContent: c.name }),
      el('small', { textContent: [c.company, c.email, c.phone].filter(Boolean).join(' · ') }),
      el('small', { textContent: `${c.priority} · ${localDate(c.created)} · ${c.exported ? '✓ exported' : '● not exported'}` })))));
  if (!shown.length) $('#contactList').append(el('p', { textContent: contacts.length ? 'No matches.' : 'No contacts yet.' }));
  const pending = contacts.filter(c => !c.exported).length;
  $('#contactTitle').textContent = `Contacts (${contacts.length})`;
  $('#count').textContent = `${contacts.length} contacts saved, ${pending} not yet exported`;
  $('#count').className = pending ? 'warn' : 'muted';
  $('#export').disabled = !contacts.length;
}
$('#search').oninput = renderContacts;

function values() {
  return {
    name: field('name').value.trim(), company: field('company').value.trim(),
    role: field('role').value.trim(), email: field('email').value.trim(),
    phone: field('phone').value.trim(), notes: field('notes').value.trim(),
    priority: field('priority').value, consent: field('consent').checked,
    interests: [...form.querySelectorAll('[name=interest]:checked')].map(i => i.value)
  };
}

function checkForm() {
  const v = values();
  const emailOK = !v.email || /^\S+@\S+\.\S+$/.test(v.email);
  $('#save').disabled = !(v.name && emailOK && (v.email || v.phone) && v.consent);
  $('#formHint').textContent = emailOK ? 'To save you need a name, an email or phone, and consent.'
    : 'Check the email address.';
  $('#duplicate').hidden = !v.email ||
    !contacts.some(c => c.id !== editing?.id && c.email.toLowerCase() === v.email.toLowerCase());
}

function openForm(contact = null) {
  editing = contact;
  // An unfinished new contact comes back if the app was closed.
  const data = contact ?? read('draft', null) ?? { priority: 'Normal', interests: [] };
  form.reset();
  for (const name of ['name', 'company', 'role', 'email', 'phone', 'notes', 'priority']) {
    field(name).value = data[name] ?? '';
  }
  field('consent').checked = !!data.consent;
  const options = [...new Set([
    ...settings.interests.split(',').map(s => s.trim()).filter(Boolean), ...(data.interests ?? [])])];
  $('#interests').replaceChildren(el('legend', { textContent: 'Interested in' }),
    ...options.map(option => el('label', { className: 'check' },
      el('input', { type: 'checkbox', name: 'interest', value: option, checked: !!data.interests?.includes(option) }),
      option)));
  $('#consentText').textContent = contact?.consentText ?? settings.consent;
  $('#formTitle').textContent = contact ? 'Edit contact' : 'New contact';
  $('#delete').hidden = !contact;
  $('#formError').hidden = true;
  original = JSON.stringify(values());
  checkForm();
  $('#formDialog').showModal();
}

form.oninput = () => {
  checkForm();
  if (!editing) write('draft', values());
};

function closeForm() {
  if (!editing) {
    try { localStorage.removeItem('expobooth.draft'); } catch { /* nothing to clear */ }
  }
  $('#formDialog').close();
}
function cancelForm() {
  const changed = JSON.stringify(values()) !== original || (!editing && read('draft', null));
  if (!changed || confirm('Discard what you typed?')) closeForm();
}
$('#cancel').onclick = cancelForm;
$('#formDialog').addEventListener('cancel', e => { e.preventDefault(); cancelForm(); });

function formFailed(error) {
  $('#formError').textContent = 'NOT saved: ' + error.message;
  $('#formError').hidden = false;
}

form.onsubmit = async e => {
  e.preventDefault();
  checkForm();
  if ($('#save').disabled) return;
  $('#save').disabled = true;
  const record = {
    id: editing?.id ?? newId(), created: editing?.created ?? Date.now(),
    event: editing?.event ?? settings.event, staff: editing?.staff ?? settings.staff,
    consentText: editing?.consentText ?? settings.consent, ...values(), exported: false
  };
  try {
    await put('contacts', record);
    contacts = [...contacts.filter(c => c.id !== record.id), record];
    closeForm();
    renderContacts();
  } catch (error) { formFailed(error); $('#save').disabled = false; }
};

$('#delete').onclick = async () => {
  if (!confirm(`Delete ${editing.name}?`)) return;
  try {
    await remove('contacts', editing.id);
    contacts = contacts.filter(c => c.id !== editing.id);
    closeForm();
    renderContacts();
  } catch (error) { formFailed(error); }
};
$('#newHome').onclick = $('#newContact').onclick = () => openForm();

/* ---------- Export ---------- */
function download(file) {
  const link = el('a', { href: URL.createObjectURL(file), download: file.name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60000);
}

$('#export').onclick = async () => {
  const batch = [...contacts];
  const stamp = localDate(Date.now()).replace(' ', '_').replace(':', '');
  const file = new File([toCSV(batch)], `contacts_${stamp}.csv`, { type: 'text/csv' });
  try {
    if (navigator.canShare?.({ files: [file] })) await navigator.share({ files: [file] });
    else download(file);
  } catch (error) {
    if (error.name !== 'AbortError') showError('Export failed: ' + error.message);
    return;
  }
  // The browser cannot tell whether the file was really kept, so ask.
  if (!confirm('Did you save the CSV file?\n\nOK marks these contacts as exported.')) return;
  // Skip any contact changed while the question was open.
  const done = batch.filter(c => contacts.includes(c)).map(c => ({ ...c, exported: true }));
  try {
    await put('contacts', ...done);
    contacts = contacts.map(c => done.find(d => d.id === c.id) ?? c);
    renderContacts();
  } catch (error) { showError('Could not mark as exported: ' + error.message); }
};

/* ---------- Import ---------- */
// Adds contacts from a CSV file. Contacts already on this iPad are never changed.
async function importContacts(file) {
  const bytes = await file.arrayBuffer();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { text = new TextDecoder('windows-1252').decode(bytes); } // older Excel files
  const rows = fromCSV(text);

  const key = c => [c.created && localDate(c.created), c.name, c.email, c.phone].join('|').toLowerCase();
  const ids = new Set(contacts.map(c => c.id));
  const keys = new Set(contacts.map(key));
  const added = [];
  let repeated = 0, unnamed = 0, undated = 0;
  for (const row of rows) {
    if (!row.name) { unnamed++; continue; }
    if ((row.id && ids.has(row.id)) || keys.has(key(row))) { repeated++; continue; }
    const record = { ...row, id: row.id || newId(), exported: true };
    ids.add(record.id);
    keys.add(key(record));
    if (record.created === null) { record.created = Date.now(); undated++; }
    added.push(record);
  }

  const notes = [
    repeated && `${repeated} already on this iPad or repeated (skipped)`,
    unnamed && `${unnamed} without a name (skipped)`,
    undated && `${undated} with an unreadable date (today's date will be used)`
  ].filter(Boolean).join('\n');
  if (!added.length) { alert(`No new contacts to import.\n${notes}`); return; }
  if (!confirm(`Import ${added.length} new contacts?\n${notes}`)) return;
  // One transaction: either all are saved or none.
  await put('contacts', ...added);
  contacts = [...contacts, ...added];
  renderContacts();
  alert(`Imported ${added.length} contacts.`);
}
$('#importCsv').onchange = async e => {
  const input = e.target;
  const file = input.files[0];
  if (!file) return;
  input.disabled = true;
  try { await importContacts(file); }
  catch (error) { showError('Import failed, nothing was added. ' + error.message); }
  input.value = '';
  input.disabled = false;
};

/* ---------- Home header and footer pictures ---------- */
// Each picture is stored with the id "header" or "footer".
const pictureBoxes = [...document.querySelectorAll('[data-picture]')];

function renderPictures() {
  for (const box of pictureBoxes) {
    const slot = box.dataset.picture;
    const file = files.find(f => f.id === slot);
    const fade = settings[slot + 'Fade'];
    for (const image of [$(`#${slot}Image`), box.querySelector('img')]) {
      if (file) image.src = urlFor(file); else image.removeAttribute('src');
      image.hidden = !file;
      image.style.opacity = 1 - fade / 100;
    }
    box.querySelector('.remove').hidden = !file;
    box.querySelector('[type=range]').value = fade;
    box.querySelector('output').textContent = fade + '%';
  }
}
// A new picture reuses the same id, so forget the previous address.
function forgetUrl(id) {
  URL.revokeObjectURL(urls.get(id));
  urls.delete(id);
}

async function choosePicture(slot, input) {
  const source = input.files[0];
  if (!source) return;
  const test = URL.createObjectURL(source);
  try {
    // Check that it really is a picture before replacing the current one.
    await Object.assign(new Image(), { src: test }).decode();
    await put('files', { id: slot, kind: slot, name: source.name, blob: source });
    const saved = await get('files', slot);
    forgetUrl(slot);
    files = [...files.filter(f => f.id !== slot), saved];
    renderPictures();
  } catch (error) {
    showError(error.name === 'EncodingError' ? 'This file is not a picture the iPad can show.'
      : 'Could not save the picture: ' + error.message);
  } finally {
    URL.revokeObjectURL(test);
    input.value = '';
  }
}

async function removePicture(slot) {
  if (!confirm(`Remove the ${slot} picture?`)) return;
  try {
    await remove('files', slot);
    files = files.filter(f => f.id !== slot);
    forgetUrl(slot);
    renderPictures();
  } catch (error) { showError('Could not remove the picture: ' + error.message); }
}

for (const box of pictureBoxes) {
  const slot = box.dataset.picture;
  box.querySelector('[type=file]').onchange = e => choosePicture(slot, e.target);
  box.querySelector('.remove').onclick = () => removePicture(slot);
  box.querySelector('[type=range]').oninput = e => {
    settings[slot + 'Fade'] = Number(e.target.value);
    write('settings', settings);
    renderPictures();
  };
}

/* ---------- Settings and start ---------- */
function applySettings() { $('#title').textContent = settings.event || 'Welcome'; }
document.querySelectorAll('[data-setting]').forEach(input => {
  input.value = settings[input.dataset.setting];
  input.oninput = () => {
    settings[input.dataset.setting] = input.value;
    write('settings', settings);
    applySettings();
  };
});

async function showStorage() {
  try {
    const { usage, quota } = await navigator.storage.estimate();
    const kept = await navigator.storage.persisted();
    $('#storage').textContent = `Storage used: ${(usage / 1e6).toFixed(0)} MB of about ${(quota / 1e9).toFixed(1)} GB available. ` +
      `Protected storage: ${kept ? 'yes' : 'not confirmed; export contacts often'}.`;
  } catch { $('#storage').textContent = 'Storage information is not available.'; }
}

async function offline() {
  const status = $('#offline');
  if (!('serviceWorker' in navigator)) { status.textContent = '⚠ Offline use is not available here. Open the https link.'; return; }
  try {
    await navigator.serviceWorker.register('sw.js');
    await navigator.serviceWorker.ready;
    status.textContent = '✓ App ready to work offline';
  } catch { status.textContent = '⚠ Offline setup failed. Connect to the internet and reopen the app.'; }
}

async function start() {
  applySettings();
  showTab('home');
  offline();
  navigator.storage?.persist?.().catch(() => {});
  try {
    [files, contacts] = await Promise.all([getAll('files'), getAll('contacts')]);
    renderFiles();
    renderContacts();
    renderPictures();
    document.body.dataset.ready = 'yes';
  } catch (error) {
    // Block editing so nothing is lost or overwritten.
    document.querySelector('main').inert = true;
    showError('Saved data could not be opened. Close the app and open it again. ' + error.message);
  }
}
start();
