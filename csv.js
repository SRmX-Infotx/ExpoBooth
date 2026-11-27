// Builds the CSV file text from the saved contacts.
const HEADER = ['Date', 'Event', 'Captured by', 'Name', 'Company', 'Job title', 'Email',
  'Phone', 'Interests', 'Priority', 'Notes', 'Consent', 'Consent text'];

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

export function toCSV(contacts) {
  const rows = [...contacts].sort((a, b) => a.created - b.created).map(c => [
    localDate(c.created), c.event, c.staff, c.name, c.company, c.role, c.email, c.phone,
    c.interests.join('; '), c.priority, c.notes, c.consent ? 'Yes' : 'No', c.consentText]);
  // The first character (BOM) makes Excel show accents correctly.
  return '﻿' + [HEADER, ...rows].map(r => r.map(escape).join(',')).join('\r\n') + '\r\n';
}
