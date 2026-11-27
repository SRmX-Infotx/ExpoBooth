import { get, getAll, put, remove, change } from './db.js';
import { toCSV, fromCSV, localDate } from './csv.js';

const $ = selector => document.querySelector(selector);
const DEFAULTS = {
  staff: '', interests: 'Product A, Product B, Product C',
  consent: 'The visitor agrees to be contacted and to have this information stored.',
  priority: 'Normal', headerFade: 0, backgroundFade: 60, footerFade: 0
};
const SLOTS = ['header', 'background', 'footer'];
let files = [];
let contacts = [];
let currentId = '';

// Small preferences (settings, shortcuts, unfinished form).
function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem('expobooth.' + key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem('expobooth.' + key, JSON.stringify(value)); }
  catch { showError('This setting could not be saved.'); }
}
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

/* ---------- Expos ---------- */
// An expo remembers its files (ids), shortcuts, settings and pictures.
// Files are stored once and can be shared by several expos.
const expos = () => sortedFiles('expo');
const findExpo = id => files.find(f => f.id === id && f.kind === 'expo');
const currentExpo = () => findExpo(currentId);
const expoName = id => findExpo(id)?.name ?? '';
const expoOf = contact => findExpo(contact.folder) ? contact.folder : '';
const sameName = (a, b) => a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;
const makeExpo = (name, settings = DEFAULTS, pictures = {}, id = newId()) => ({
  id, kind: 'expo', name, content: [], pins: [], settings: { ...DEFAULTS, ...settings }, pictures: { ...pictures }
});
const expoFiles = kind => sortedFiles(kind).filter(f => currentExpo().content.includes(f.id));
const usedElsewhere = (fileId, expoId) => expos().some(e => e.id !== expoId &&
  (e.content.includes(fileId) || Object.values(e.pictures).includes(fileId)));

function forgetUrl(id) {
  URL.revokeObjectURL(urls.get(id));
  urls.delete(id);
}

// Changes are saved one after another so that none overwrites another.
let queue = Promise.resolve();
function updateExpo(id, edit) {
  const run = queue.then(async () => {
    if (!findExpo(id)) throw new Error('This expo no longer exists.');
    const expo = structuredClone(findExpo(id));
    const { puts = [], deletes = [] } = edit(expo) ?? {};
    await change('files', [expo, ...puts], deletes);
    const saved = [expo];
    for (const record of puts) saved.push(await get('files', record.id));
    const replaced = new Set([...deletes, ...saved.map(f => f.id)]);
    deletes.forEach(forgetUrl);
    files = [...files.filter(f => !replaced.has(f.id)), ...saved];
  });
  queue = run.catch(() => {});
  return run;
}

function selectExpo(id) {
  currentId = findExpo(id) ? id : expos()[0].id;
  write('expo', currentId);
  view = 'expo';
  $('#search').value = '';
  renderAll();
}

function renderAll() {
  $('#expoSelect').replaceChildren(...expos().map(e => el('option', { value: e.id, textContent: e.name })));
  $('#expoSelect').value = currentId;
  $('#title').textContent = currentExpo().name;
  renderFiles();
  renderContacts();
  renderPictures();
  renderSettings();
}
$('#expoSelect').onchange = e => selectExpo(e.target.value);

let renaming = false, savingExpo = false;
function openExpoDialog(rename) {
  renaming = rename ? currentId : false;
  const form = $('#expoForm');
  form.reset();
  $('#expoHeading').textContent = rename ? 'Rename expo' : 'New expo';
  form.elements.expoName.value = rename ? currentExpo().name : '';
  $('#copyRow').hidden = rename;
  $('#expoError').hidden = true;
  $('#expoDialog').showModal();
}
$('#newExpo').onclick = () => openExpoDialog(false);
$('#renameExpo').onclick = () => openExpoDialog(true);
$('#cancelExpo').onclick = () => $('#expoDialog').close();

$('#expoForm').onsubmit = async e => {
  e.preventDefault();
  if (savingExpo) return;
  const { expoName: input, copy } = $('#expoForm').elements;
  const name = input.value.trim();
  const fail = message => { $('#expoError').textContent = message; $('#expoError').hidden = false; };
  if (!name) return fail('Type a name for the expo.');
  if (expos().some(x => x.id !== renaming && sameName(x.name, name))) return fail('There is already an expo with this name.');
  savingExpo = true;
  try {
    if (renaming) {
      await updateExpo(renaming, x => { x.name = name; });
      renderAll();
    } else {
      await queue;
      const expo = copy.checked ? makeExpo(name, currentExpo().settings, currentExpo().pictures) : makeExpo(name);
      await put('files', expo);
      files.push(expo);
      selectExpo(expo.id);
    }
    $('#expoDialog').close();
  } catch (error) { fail('Not saved: ' + error.message); }
  finally { savingExpo = false; }
};

$('#deleteExpo').onclick = async () => {
  await queue;
  const expo = currentExpo();
  if (expos().length === 1) return showError('You need at least one expo. Create another one first.');
  const count = contacts.filter(c => c.folder === expo.id).length;
  if (count) return showError(`This expo has ${count} contacts. Export them, then move or delete them before deleting the expo.`);
  const unused = [...new Set([...expo.content, ...Object.values(expo.pictures)])]
    .filter(id => !usedElsewhere(id, expo.id));
  if (!confirm(`Delete the expo "${expo.name}"?\n\n${unused.length} files and pictures used only by this expo will be deleted from the iPad.`)) return;
  try {
    await change('files', [], [expo.id, ...unused]);
    unused.forEach(forgetUrl);
    files = files.filter(f => f.id !== expo.id && !unused.includes(f.id));
    selectExpo(expos()[0].id);
  } catch (error) { showError('Could not delete the expo: ' + error.message); }
};

/* ---------- Lists ---------- */
function renderFiles() {
  const videos = expoFiles('video');
  $('#loop').disabled = !videos.length;

  $('#videoList').replaceChildren(...videos.map((file, index) => el('div', { className: 'card' },
    el('video', { src: urlFor(file) + '#t=0.5', preload: 'metadata', muted: true, playsInline: true }),
    el('button', { className: 'tile play', textContent: '▶ ' + title(file), onclick: () => play(videos, index) }),
    el('button', { className: 'danger', textContent: 'Remove', onclick: () => removeFile(file) }))));
  if (!videos.length) $('#videoList').append(el('p', { textContent: 'No videos in this expo. Import videos or add them from this iPad.' }));

  const slides = expoFiles('slides');
  const pins = currentExpo().pins;
  $('#slideList').replaceChildren(...slides.map(file => el('div', { className: 'row' },
    el('button', {
      className: 'star', textContent: pins.includes(file.id) ? '★' : '☆',
      ariaLabel: 'Show on Home', onclick: () => togglePin(file.id)
    }),
    el('button', { className: 'grow', onclick: () => openSlides(file) },
      title(file), el('small', { textContent: extension(file).toUpperCase() })),
    el('button', { className: 'danger', textContent: 'Remove', onclick: () => removeFile(file) }))));
  if (!slides.length) $('#slideList').append(el('p', { textContent: 'No presentations in this expo. Import files or add them from this iPad.' }));

  const pinned = pins.map(id => slides.find(f => f.id === id)).filter(Boolean);
  $('#pinned').replaceChildren(...pinned.map(file => el('div', { className: 'card' },
    el('button', { className: 'tile', textContent: title(file), onclick: () => openSlides(file) }))));
  if (!pinned.length) $('#pinned').append(el('button', {
    textContent: 'Choose shortcuts: tap ☆ on a presentation', onclick: () => showTab('slides')
  }));
}

async function togglePin(id) {
  try {
    await updateExpo(currentId, e => {
      e.pins = e.pins.includes(id) ? e.pins.filter(p => p !== id) : [...e.pins, id];
    });
    renderFiles();
  } catch (error) { showError('Could not save the shortcut: ' + error.message); }
}

async function importFiles(input, kind, allowed) {
  const label = input.parentElement;
  const text = label.firstChild.textContent;
  const chosen = [...input.files];
  // The files go to the expo selected when the import started.
  const expoId = currentId;
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
      await updateExpo(expoId, e => {
        e.content.push(id);
        return { puts: [{ id, kind, name, blob: source }] };
      });
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

function openLibrary(kind) {
  const available = sortedFiles(kind).filter(f => !currentExpo().content.includes(f.id));
  $('#libraryList').replaceChildren(...available.map(f => el('label', { className: 'check' },
    el('input', { type: 'checkbox', value: f.id }), f.name)));
  if (!available.length) $('#libraryList').append(el('p', { textContent: 'There are no other files on this iPad to add.' }));
  $('#libraryDialog').showModal();
}
$('#existingVideo').onclick = () => openLibrary('video');
$('#existingSlides').onclick = () => openLibrary('slides');
$('#cancelLibrary').onclick = () => $('#libraryDialog').close();
$('#libraryForm').onsubmit = async e => {
  e.preventDefault();
  const ids = [...$('#libraryList').querySelectorAll('input:checked')].map(i => i.value);
  $('#libraryDialog').close();
  if (!ids.length) return;
  try {
    await updateExpo(currentId, x => { x.content = [...new Set([...x.content, ...ids])]; });
    renderFiles();
  } catch (error) { showError('Could not add the files: ' + error.message); }
};

async function removeFile(file) {
  await queue;
  const expo = currentExpo();
  const shared = usedElsewhere(file.id, expo.id);
  const message = shared ? 'It stays in the other expos that use it.'
    : 'No other expo uses it, so it will be deleted from the iPad.';
  if (!confirm(`Remove "${file.name}" from ${expo.name}?\n\n${message}`)) return;
  try {
    await updateExpo(expo.id, e => {
      e.content = e.content.filter(id => id !== file.id);
      e.pins = e.pins.filter(id => id !== file.id);
      return { deletes: shared ? [] : [file.id] };
    });
    renderFiles();
  } catch (error) { showError('Could not remove the file: ' + error.message); }
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
$('#loop').onclick = () => { errors = 0; play(expoFiles('video'), 0); };
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
// Which list is on screen: this expo, contacts without an expo, or all.
let view = 'expo';

const inView = () => view === 'all' ? contacts
  : contacts.filter(c => expoOf(c) === (view === 'none' ? '' : currentId));

function renderContacts() {
  const unassigned = contacts.filter(c => !expoOf(c));
  if (view === 'none' && !unassigned.length) view = 'expo';
  const chip = (id, label, count) => el('button', {
    textContent: `${label} (${count})`, ariaPressed: String(view === id),
    onclick: () => { view = id; renderContacts(); }
  });
  $('#viewBar').replaceChildren(
    chip('expo', 'This expo', contacts.filter(c => c.folder === currentId).length),
    ...(unassigned.length ? [chip('none', 'Unassigned', unassigned.length)] : []),
    chip('all', 'All expos', contacts.length));
  $('#claim').hidden = view !== 'none';
  $('#claim').textContent = `Move all ${unassigned.length} to ${currentExpo().name}`;
  $('#saveTarget').textContent = `New contacts are saved in: ${currentExpo().name}`;

  const query = $('#search').value.trim().toLowerCase();
  const listed = inView();
  const shown = listed
    .filter(c => `${c.name} ${c.company} ${c.email} ${c.phone}`.toLowerCase().includes(query))
    .sort((a, b) => b.created - a.created);
  $('#contactList').replaceChildren(...shown.map(c => el('div', { className: 'row' },
    el('button', { className: 'grow contact', onclick: () => openForm(c) },
      el('strong', { textContent: c.name }),
      el('small', { textContent: [c.company, c.email, c.phone].filter(Boolean).join(' · ') }),
      el('small', { textContent: `${view === 'all' ? (expoName(c.folder) || 'Unassigned') + ' · ' : ''}${c.priority} · ${localDate(c.created)} · ${c.exported ? '✓ exported' : '● not exported'}` })))));
  if (!shown.length) $('#contactList').append(el('p', { textContent: listed.length ? 'No matches.' : 'No contacts here yet.' }));
  $('#contactTitle').textContent = `Contacts (${listed.length})`;

  const here = contacts.filter(c => c.folder === currentId);
  const pending = here.filter(c => !c.exported).length;
  $('#count').textContent = `${here.length} contacts in this expo, ${pending} not yet exported`;
  $('#count').className = pending ? 'warn' : 'muted';
  const others = contacts.filter(c => c.folder !== currentId && !c.exported).length;
  $('#otherCount').hidden = !others;
  $('#otherCount').textContent = `${others} contacts outside this expo are not yet exported`;
  $('#export').disabled = !listed.length;
  $('#export').textContent = { expo: 'Export this expo (CSV)', none: 'Export unassigned (CSV)', all: 'Export all (CSV)' }[view];
}
$('#search').oninput = renderContacts;

$('#claim').onclick = async () => {
  const expo = currentExpo();
  const moved = contacts.filter(c => !expoOf(c)).map(c => ({ ...c, folder: expo.id, exported: false }));
  if (!confirm(`Move ${moved.length} unassigned contacts to ${expo.name}?`)) return;
  try {
    await put('contacts', ...moved);
    contacts = contacts.map(c => moved.find(m => m.id === c.id) ?? c);
    view = 'expo';
    renderContacts();
  } catch (error) { showError('Could not move the contacts: ' + error.message); }
};

function values() {
  return {
    name: field('name').value.trim(), company: field('company').value.trim(),
    role: field('role').value.trim(), email: field('email').value.trim(),
    folder: field('folder').value,
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
    !contacts.some(c => c.id !== editing?.id && expoOf(c) === v.folder && c.email.toLowerCase() === v.email.toLowerCase());
}

// The product list and consent sentence belong to the chosen expo.
function fillExpoFields(selected) {
  const settings = findExpo(field('folder').value)?.settings ?? currentExpo().settings;
  const options = [...new Set([
    ...settings.interests.split(',').map(s => s.trim()).filter(Boolean), ...selected])];
  $('#interests').replaceChildren(el('legend', { textContent: 'Interested in' }),
    ...options.map(option => el('label', { className: 'check' },
      el('input', { type: 'checkbox', name: 'interest', value: option, checked: selected.includes(option) }),
      option)));
  $('#consentText').textContent = editing?.consentText || settings.consent;
}

function openForm(contact = null) {
  editing = contact;
  // An unfinished new contact comes back if the app was closed.
  const data = contact ?? read('draft', null) ?? { priority: currentExpo().settings.priority, interests: [] };
  form.reset();
  for (const name of ['name', 'company', 'role', 'email', 'phone', 'notes', 'priority']) {
    field(name).value = data[name] ?? '';
  }
  field('consent').checked = !!data.consent;
  field('folder').replaceChildren(
    ...(contact && !expoOf(contact) ? [el('option', { value: '', textContent: 'Unassigned' })] : []),
    ...expos().map(e => el('option', { value: e.id, textContent: e.name })));
  field('folder').value = contact ? expoOf(contact) : findExpo(data.folder) ? data.folder : currentId;
  fillExpoFields(data.interests ?? []);
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
form.onchange = e => {
  if (e.target.name !== 'folder') return;
  // A new contact must agree to the sentence of the newly chosen expo.
  if (!editing) field('consent').checked = false;
  fillExpoFields(values().interests);
  form.oninput();
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
    event: editing?.event ?? expoName(field('folder').value),
    staff: editing?.staff ?? findExpo(field('folder').value).settings.staff,
    consentText: editing?.consentText || $('#consentText').textContent, ...values(), exported: false
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
  const batch = [...inView()];
  const label = view === 'expo' ? currentExpo().name.replace(/[^\p{L}\p{N}]+/gu, '-')
    : view === 'none' ? 'unassigned' : 'all';
  const stamp = localDate(Date.now()).replace(' ', '_').replace(':', '');
  const file = new File([toCSV(batch, expoName)], `contacts_${label}_${stamp}.csv`, { type: 'text/csv' });
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
  const added = [], newExpos = [];
  // Use the expo named in the file; without an expo column, use the selected one.
  const expoFor = name => {
    if (name === null) return currentId;
    if (!name) return '';
    let expo = [...expos(), ...newExpos].find(e => sameName(e.name, name));
    if (!expo) newExpos.push(expo = makeExpo(name, currentExpo().settings));
    return expo.id;
  };
  let repeated = 0, unnamed = 0, undated = 0;
  for (const row of rows) {
    if (!row.name) { unnamed++; continue; }
    if ((row.id && ids.has(row.id)) || keys.has(key(row))) { repeated++; continue; }
    const { expoName: name, ...data } = row;
    const record = { ...data, folder: expoFor(name), id: row.id || newId(), exported: true };
    ids.add(record.id);
    keys.add(key(record));
    if (record.created === null) { record.created = Date.now(); undated++; }
    added.push(record);
  }

  const notes = [
    newExpos.length && `New expos: ${newExpos.map(e => e.name).join(', ')}`,
    repeated && `${repeated} already on this iPad or repeated (skipped)`,
    unnamed && `${unnamed} without a name (skipped)`,
    undated && `${undated} with an unreadable date (today's date will be used)`
  ].filter(Boolean).join('\n');
  if (!added.length) { alert(`No new contacts to import.\n${notes}`); return; }
  if (!confirm(`Import ${added.length} new contacts?\n${notes}`)) return;
  if (newExpos.length) {
    await put('files', ...newExpos);
    files = [...files, ...newExpos];
  }
  // One transaction: either all are saved or none.
  await put('contacts', ...added);
  contacts = [...contacts, ...added];
  renderAll();
  alert(`Imported ${added.length} contacts.`);
}
$('#importCsv').onchange = async e => {
  const input = e.target;
  const file = input.files[0];
  if (!file) return;
  input.disabled = true;
  try { await importContacts(file); }
  catch (error) { showError('Import failed, no contacts were added. ' + error.message); renderContacts(); }
  input.value = '';
  input.disabled = false;
};

/* ---------- Header, background and footer pictures ---------- */
const pictureBoxes = [...document.querySelectorAll('[data-picture]')];

function showFade(box, fade) {
  const slot = box.dataset.picture;
  for (const image of [$(`#${slot}Image`), box.querySelector('img')]) image.style.opacity = 1 - fade / 100;
  box.querySelector('output').textContent = fade + '%';
}

function renderPictures() {
  for (const box of pictureBoxes) {
    const slot = box.dataset.picture;
    const file = files.find(f => f.id === currentExpo().pictures[slot]);
    for (const image of [$(`#${slot}Image`), box.querySelector('img')]) {
      if (file) image.src = urlFor(file); else image.removeAttribute('src');
      image.hidden = !file;
    }
    box.querySelector('.remove').hidden = !file;
    box.querySelector('[type=range]').value = currentExpo().settings[slot + 'Fade'];
    showFade(box, currentExpo().settings[slot + 'Fade']);
    if (slot === 'background') $('#backdrop').classList.toggle('has-picture', !!file);
  }
}

// Replaces or removes a picture; the old one is deleted only if no expo uses it.
function setPicture(expoId, slot, record) {
  return updateExpo(expoId, e => {
    const old = e.pictures[slot];
    if (record) e.pictures[slot] = record.id; else delete e.pictures[slot];
    const keep = !old || usedElsewhere(old, e.id) || Object.values(e.pictures).includes(old) || e.content.includes(old);
    return { puts: record ? [record] : [], deletes: keep ? [] : [old] };
  });
}

async function choosePicture(slot, input) {
  const source = input.files[0];
  if (!source) return;
  const expoId = currentId;
  const test = URL.createObjectURL(source);
  try {
    // Check that it really is a picture before replacing the current one.
    await Object.assign(new Image(), { src: test }).decode();
    await setPicture(expoId, slot, { id: newId(), kind: 'picture', name: source.name, blob: source });
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
  if (!confirm(`Remove the ${slot} picture from this expo?`)) return;
  try {
    await setPicture(currentId, slot);
    renderPictures();
  } catch (error) { showError('Could not remove the picture: ' + error.message); }
}

function saveSetting(key, value) {
  updateExpo(currentId, e => { e.settings[key] = value; })
    .catch(error => showError('This setting could not be saved: ' + error.message));
}

for (const box of pictureBoxes) {
  const slot = box.dataset.picture;
  box.querySelector('[type=file]').onchange = e => choosePicture(slot, e.target);
  box.querySelector('.remove').onclick = () => removePicture(slot);
  box.querySelector('[type=range]').oninput = e => {
    showFade(box, Number(e.target.value));
    saveSetting(slot + 'Fade', Number(e.target.value));
  };
}

/* ---------- Settings and start ---------- */
function renderSettings() {
  $('#settingsFor').textContent = currentExpo().name;
  document.querySelectorAll('[data-setting]').forEach(input => {
    input.value = currentExpo().settings[input.dataset.setting];
  });
}
document.querySelectorAll('[data-setting]').forEach(input => {
  input.oninput = () => saveSetting(input.dataset.setting, input.value);
});

// Turns the data of earlier versions into expos. Nothing is deleted.
async function createFirstExpos() {
  const old = read('settings', {});
  const { event, ...settings } = old;
  const folders = sortedFiles('folder');
  // Earlier folders keep their id, so their contacts stay inside.
  const created = folders.length ? folders.map(f => makeExpo(f.name, settings, {}, f.id))
    : [makeExpo(event?.trim() || 'My first expo', settings)];
  const first = created.find(e => e.id === read('folder', '')) ?? created[0];
  first.content = files.filter(f => f.kind === 'video' || f.kind === 'slides').map(f => f.id);
  first.pins = read('pins', []).filter(id => first.content.includes(id));
  for (const slot of SLOTS) if (files.some(f => f.id === slot)) first.pictures[slot] = slot;
  await change('files', created);
  const ids = new Set(created.map(e => e.id));
  files = [...files.filter(f => !ids.has(f.id)), ...created];
  write('expo', first.id);
}

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
  showTab('home');
  offline();
  navigator.storage?.persist?.().catch(() => {});
  // Nothing can be edited until the saved data is loaded.
  const locked = [$('main'), $('.expoRow')];
  locked.forEach(node => { node.inert = true; });
  try {
    [files, contacts] = await Promise.all([getAll('files'), getAll('contacts')]);
    if (!expos().length) await createFirstExpos();
    selectExpo(read('expo', ''));
    locked.forEach(node => { node.inert = false; });
    document.body.dataset.ready = 'yes';
  } catch (error) {
    showError('Saved data could not be opened. Close the app and open it again. ' + error.message);
  }
}
start();
