/**
 * Convert GermanAI_Personas.xlsx → server/personaDatabase.json
 *
 * Each sheet ("Chapter 1"–"Chapter 8", "BLAU Ch1"–"BLAU Ch4", "ORANGE Ch1"–"ORANGE Ch4")
 * becomes one key in the output JSON. Within each key, traits are stored as
 * { traitName: [opt1, opt2, opt3, opt4, opt5] } — identical shape to the old format.
 *
 * Empty strings in the spreadsheet are converted to "-" (unavailable).
 * Nachname and password rows are excluded.
 */

const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const INPUT  = process.argv[2] || path.join(__dirname, '..', 'GermanAI_Personas.xlsx');
const OUTPUT = path.join(__dirname, '..', 'server', 'personaDatabase.json');

const SKIP_TRAITS = new Set(['Nachname', 'password']);

const wb = XLSX.readFile(INPUT);

console.log('Sheets found:', wb.SheetNames.join(', '));

const db = {
  _comment: 'Persona database generated from GermanAI_Personas.xlsx. ' +
            'Each key is a chapter sheet with traits as { name: [5 options] }. ' +
            'Pick ONE column index (0-4) per session for a coherent persona. ' +
            '"-" means trait is unavailable at this level.',
};

for (const sheetName of wb.SheetNames) {
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

  // Skip header row
  const traits = {};
  let traitCount = 0;
  let availableCount = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[1]) continue; // skip empty rows

    const source = String(row[0] || '').trim();
    const traitName = String(row[1] || '').trim();

    if (!traitName || SKIP_TRAITS.has(traitName)) continue;

    // Extract 5 options (columns C-G, indices 2-6)
    const options = [];
    for (let col = 2; col <= 6; col++) {
      const val = String(row[col] ?? '').trim();
      options.push(val || '-');
    }

    // Use "Source|Trait" as a composite key to avoid collisions
    // (e.g. multiple chapters may have traits with same name like "Lieblingsessen")
    // But actually — each trait name within a sheet is unique because the Source
    // differentiates them. However, some trait names repeat across sources
    // (e.g. "Beruf" appears in ID1_Ch1). Let's prefix with source for uniqueness.
    // Actually, looking at the data, trait names ARE unique within each sheet.
    // "Beruf" only appears once per sheet. Let's verify and use plain trait name.

    if (traits[traitName]) {
      // Collision — use source prefix
      const key = `${source}: ${traitName}`;
      traits[key] = options;
      console.warn(`  ⚠ Trait name collision in "${sheetName}": "${traitName}" → using "${key}"`);
    } else {
      traits[traitName] = options;
    }

    traitCount++;
    const hasValue = options.some(o => o !== '-');
    if (hasValue) availableCount++;
  }

  db[sheetName] = traits;
  console.log(`  ${sheetName}: ${traitCount} traits (${availableCount} with values)`);
}

fs.writeFileSync(OUTPUT, JSON.stringify(db, null, 2), 'utf8');
console.log(`\nWritten to ${OUTPUT}`);
console.log(`Total sheets: ${wb.SheetNames.length}`);
