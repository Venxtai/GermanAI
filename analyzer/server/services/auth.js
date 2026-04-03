const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');

const ACCESS_SHEETS_ID = process.env.GOOGLE_SHEETS_ID || '1sN307djAoZ8k0qjzlYFJtiOfxC9c_HAJCXHYgpGul4w';
const TEXT_DRIVE_FOLDER_ID = process.env.TEXT_DRIVE_FOLDER_ID || '13sfTRtoGNbOv9MMgEJD5w15CBJLs_G4c';

// Google credentials setup
let googleCredentials = null;
const credFilePath = path.resolve(process.env.GOOGLE_APPLICATION_CREDENTIALS || './service-account.json');
if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
  googleCredentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const tmpCredPath = path.join(require('os').tmpdir(), 'analyzer-service-account.json');
  fs.writeFileSync(tmpCredPath, process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = tmpCredPath;
} else if (fs.existsSync(credFilePath)) {
  googleCredentials = JSON.parse(fs.readFileSync(credFilePath, 'utf8'));
  process.env.GOOGLE_APPLICATION_CREDENTIALS = credFilePath;
}

function createGoogleAuth(scopes) {
  if (googleCredentials) {
    return new google.auth.GoogleAuth({ credentials: googleCredentials, scopes });
  }
  return new google.auth.GoogleAuth({ scopes });
}

let sheetsClient = null;
async function getSheetsClient() {
  if (sheetsClient) return sheetsClient;
  const auth = createGoogleAuth(['https://www.googleapis.com/auth/spreadsheets']);
  sheetsClient = google.sheets({ version: 'v4', auth: await auth.getClient() });
  return sheetsClient;
}

let driveClient = null;
async function getDriveClient() {
  if (driveClient) return driveClient;
  if (!googleCredentials) return null;
  const auth = createGoogleAuth(['https://www.googleapis.com/auth/drive']);
  driveClient = google.drive({ version: 'v3', auth });
  return driveClient;
}

/**
 * Validate an access code for the Text Analyzer.
 * Checks: code exists, uses remaining, Tool column is "Text" or "Both".
 *
 * Access Codes columns (updated):
 * A=Code, B=Type, C=Tool (Buddy/Text/Both), D=Max Uses, E=Used, F=Created By, G=Assigned To, H=Notes
 */
async function validateCode(code) {
  if (!code || typeof code !== 'string') {
    return { valid: false, error: 'No code provided' };
  }

  // Dev bypass
  if (!googleCredentials && code.trim().toLowerCase() === 'dev') {
    console.log('[AUTH] Dev mode — bypassing Google Sheets validation');
    return { valid: true, type: 'analyzer', remainingUses: 999, assignedTo: 'developer', sessionId: `dev_${Date.now()}` };
  }

  try {
    const sheets = await getSheetsClient();
    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: 'Access Codes!A2:H',
    });

    const rows = result.data.values || [];
    const codeLower = code.trim().toLowerCase();
    const rowIndex = rows.findIndex(r => (r[0] || '').toLowerCase() === codeLower);

    if (rowIndex === -1) {
      return { valid: false, error: 'Invalid access code' };
    }

    const row = rows[rowIndex];
    // A=Code, B=Type, C=Tool, D=Max Uses, E=Used, F=Created By, G=Assigned To, H=Notes
    const type = row[1] || 'student';
    const tool = (row[2] || '').toLowerCase().trim();
    const maxUses = parseInt(row[3]) || 0;
    const used = parseInt(row[4]) || 0;
    const assignedTo = row[6] || '';

    // Check Tool column: must be "text" or "both"
    if (tool !== 'text' && tool !== 'both') {
      return { valid: false, error: 'This access code is not authorized for the Text Analyzer' };
    }

    if (used >= maxUses) {
      return { valid: false, error: 'Access code has expired (all uses consumed)', used, maxUses };
    }

    // Increment usage count (column E = index 4, sheet row = rowIndex + 2)
    const sheetRow = rowIndex + 2;
    await sheets.spreadsheets.values.update({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: `Access Codes!E${sheetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[used + 1]] },
    });

    // Generate session ID
    const sessionId = `text_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Log to Text Usage Log sheet
    // Columns: A=Timestamp, B=Code, C=Type, D=Assigned To, E=Session ID, F=Original PDF, G=Adapted PDF
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
    await sheets.spreadsheets.values.append({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: 'Text Usage Log!A:G',
      valueInputOption: 'RAW',
      requestBody: {
        values: [[timestamp, code, type, assignedTo, sessionId, '', '']],
      },
    });

    console.log(`[AUTH] Code "${code}" validated for Text Analyzer — ${used + 1}/${maxUses} uses, session ${sessionId}`);

    return { valid: true, type, remainingUses: maxUses - used - 1, assignedTo, sessionId };
  } catch (err) {
    console.error('[AUTH] Google Sheets error:', err.message);
    const sessionId = `text_${Date.now()}_fallback`;
    return { valid: true, type: 'analyzer', remainingUses: -1, assignedTo: '', sessionId, error: 'Could not verify — access granted temporarily' };
  }
}

/**
 * Upload a PDF buffer to Google Drive and return the file ID + link.
 */
async function uploadPdfToDrive(pdfBuffer, filename) {
  try {
    const drive = await getDriveClient();
    if (!drive) {
      console.warn('[DRIVE] No Drive client — skipping upload');
      return null;
    }

    const stream = new Readable();
    stream.push(pdfBuffer);
    stream.push(null);

    const driveRes = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: filename,
        mimeType: 'application/pdf',
        parents: [TEXT_DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: 'application/pdf',
        body: stream,
      },
      fields: 'id',
    });

    const fileId = driveRes.data.id;
    const link = `https://drive.google.com/file/d/${fileId}/view`;
    console.log(`[DRIVE] Uploaded ${filename}: ${link}`);
    return { fileId, link };
  } catch (err) {
    console.error('[DRIVE] Upload error:', err.message, err.errors || '');
    return null;
  }
}

/**
 * Update or replace an existing file on Google Drive.
 */
async function updatePdfOnDrive(fileId, pdfBuffer) {
  try {
    const drive = await getDriveClient();
    if (!drive) return null;

    const stream = new Readable();
    stream.push(pdfBuffer);
    stream.push(null);

    await drive.files.update({
      fileId,
      supportsAllDrives: true,
      media: {
        mimeType: 'application/pdf',
        body: stream,
      },
    });

    console.log(`[DRIVE] Updated file ${fileId}`);
    return true;
  } catch (err) {
    console.error('[DRIVE] Update error:', err.message);
    return null;
  }
}

/**
 * Update the Text Usage Log with Drive links for a session.
 * @param {string} sessionId
 * @param {'original'|'adapted'} column - which PDF link to update
 * @param {string} driveLink
 */
async function updateTextUsageLog(sessionId, column, driveLink) {
  try {
    const sheets = await getSheetsClient();
    const logData = await sheets.spreadsheets.values.get({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: 'Text Usage Log!E:E',
    });
    const rows = logData.data.values || [];
    let targetRow = -1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if ((rows[i][0] || '').trim() === sessionId) { targetRow = i + 1; break; }
    }
    if (targetRow < 1) {
      console.warn(`[LOG] Session ${sessionId} not found in Text Usage Log`);
      return;
    }

    // F = Original PDF, G = Adapted PDF
    const col = column === 'original' ? 'F' : 'G';
    await sheets.spreadsheets.values.update({
      spreadsheetId: ACCESS_SHEETS_ID,
      range: `Text Usage Log!${col}${targetRow}`,
      valueInputOption: 'USER_ENTERED',
      requestBody: { values: [[`=HYPERLINK("${driveLink}","open")`]] },
    });
    console.log(`[LOG] Updated ${column} link for session ${sessionId}`);
  } catch (err) {
    console.error('[LOG] Update error:', err.message);
  }
}

/**
 * Upload a JSON object to Google Drive and return the file ID + link.
 */
async function uploadJsonToDrive(jsonData, filename) {
  try {
    const drive = await getDriveClient();
    if (!drive) {
      console.warn('[DRIVE] No Drive client — skipping JSON upload');
      return null;
    }

    const jsonStr = JSON.stringify(jsonData);
    const stream = new Readable();
    stream.push(jsonStr);
    stream.push(null);

    const driveRes = await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: filename,
        mimeType: 'application/json',
        parents: [TEXT_DRIVE_FOLDER_ID],
      },
      media: {
        mimeType: 'application/json',
        body: stream,
      },
      fields: 'id',
    });

    const fileId = driveRes.data.id;
    const link = `https://drive.google.com/file/d/${fileId}/view`;
    console.log(`[DRIVE] Uploaded JSON ${filename}: ${link}`);
    return { fileId, link };
  } catch (err) {
    console.error('[DRIVE] JSON upload error:', err.message, err.errors || '');
    return null;
  }
}

/**
 * Download a JSON file from Google Drive by file ID.
 */
async function downloadJsonFromDrive(fileId) {
  try {
    const drive = await getDriveClient();
    if (!drive) return null;

    const res = await drive.files.get(
      { fileId, alt: 'media', supportsAllDrives: true },
      { responseType: 'text' }
    );

    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch (err) {
    console.error('[DRIVE] JSON download error:', err.message);
    return null;
  }
}

/**
 * Search for a file by name in the Drive folder.
 * Returns the file ID if found, null otherwise.
 */
async function findDriveFileByName(filename) {
  try {
    const drive = await getDriveClient();
    if (!drive) return null;

    const res = await drive.files.list({
      q: `name = '${filename}' and '${TEXT_DRIVE_FOLDER_ID}' in parents and trashed = false`,
      fields: 'files(id, name)',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });

    const files = res.data.files || [];
    return files.length > 0 ? files[0].id : null;
  } catch (err) {
    console.error('[DRIVE] File search error:', err.message);
    return null;
  }
}

module.exports = {
  validateCode,
  uploadPdfToDrive,
  updatePdfOnDrive,
  updateTextUsageLog,
  getDriveClient,
  uploadJsonToDrive,
  downloadJsonFromDrive,
  findDriveFileByName,
  googleCredentials,
};
