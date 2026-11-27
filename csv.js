// Builds the CSV file text from the saved contacts.
const HEADER = ['Date', 'Event', 'Captured by', 'Name', 'Company', 'Job title', 'Email',
  'Phone', 'Interests', 'Priority', 'Notes', 'Consent', 'Consent text', 'Expo', 'ID'];

function escape(value) {
  let text = String(value ?? '');
  // Stops spreadsheets from running typed text as a formula, and keeps + in phone numbers.
  if (/^[=+\-@\t\r]/.test(text)) text = '\t' + text;
  return '"' + text.replaceAll('"', '""') + '"';
}

const two = n => String(n).padStart(2, '0');
export function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
}

export function toCSV(contacts, expoName = () => '') {
  const rows = [...contacts].sort((a, b) => a.created - b.created).map(c => [
    localDate(c.created), c.event, c.staff, c.name, c.company, c.role, c.email, c.phone,
    c.interests.join('; '), c.priority, c.notes, c.consent ? 'Yes' : 'No', c.consentText, expoName(c.folder), c.id]);
  // The first character (BOM) makes Excel show accents correctly.
  return '﻿' + [HEADER, ...rows].map(r => r.map(escape).join(',')).join('\r\n') + '\r\n';
}

// Splits CSV text into rows. Handles quotes, commas and line breaks inside a field.
function parse(text, separator) {
  const rows = [];
  let row = [], value = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quoted) {
      if (char !== '"') value += char;
      else if (text[i + 1] === '"') { value += '"'; i++; }
      else quoted = false;
    } else if (char === '"' && value === '') quoted = true;
    else if (char === separator) { row.push(value); value = ''; }
    else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i++;
      rows.push([...row, value]); row = []; value = '';
    } else value += char;
  }
  if (quoted) throw new Error('The file is incomplete: a quoted value is never closed.');
  if (value !== '' || row.length) rows.push([...row, value]);
  return rows.filter(r => r.some(v => v.trim() !== ''));
}

// Returns null if the date is not in the exported format (YYYY-MM-DD HH:MM).
function readDate(text) {
  const m = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/.exec(text);
  if (!m) return null;
  const ms = new Date(m[1], m[2] - 1, m[3], m[4], m[5]).getTime();
  return localDate(ms) === text ? ms : null;
}

export function fromCSV(text) {
  text = text.replace(/^﻿/, '');
  // Some spreadsheet programs save with semicolons or tabs instead of commas.
  const first = text.split(/\r?\n|\r/, 1)[0];
  const separator = [',', ';', '\t'].sort((a, b) => first.split(b).length - first.split(a).length)[0];
  const [header = [], ...rows] = parse(text, separator);
  const columns = header.map(h => h.trim().toLowerCase());
  if (!columns.includes('name') || !(columns.includes('email') || columns.includes('phone'))) {
    throw new Error('This does not look like an ExpoBooth CSV (Name, Email or Phone columns are missing).');
  }
  return rows.map(row => {
    const get = name => {
      const value = row[columns.indexOf(name.toLowerCase())] ?? '';
      // Remove the protective tab added during export.
      return value.replace(/^\t(?=[=+\-@\t\r])/, '').trim();
    };
    const priority = get('Priority').toLowerCase();
    return {
      id: get('ID'), created: readDate(get('Date')), event: get('Event'), staff: get('Captured by'),
      name: get('Name'), company: get('Company'), role: get('Job title'), email: get('Email'),
      phone: get('Phone'),
      interests: get('Interests').split(';').map(s => s.trim()).filter(Boolean),
      priority: ['High', 'Normal', 'Low'].find(p => p.toLowerCase() === priority) ?? 'Normal',
      notes: get('Notes'), consent: get('Consent').toLowerCase() === 'yes',
      consentText: get('Consent text'),
      // null means the file has no expo column ('Folder' was its earlier name).
      expoName: columns.includes('expo') ? get('Expo') : columns.includes('folder') ? get('Folder') : null
    };
  });
}
