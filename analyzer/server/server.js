const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const path = require('path');

// Load environment variables — check multiple locations
// Use override:true because system env may have empty-string placeholders
dotenv.config({ path: path.join(__dirname, '../.env'), override: true });           // analyzer/.env
dotenv.config({ path: path.join(__dirname, '../../.env'), override: true });        // GermanAI/.env (or worktree root)
dotenv.config({ path: path.join(__dirname, '../../../.env'), override: true });     // parent of worktree
// Walk up to find .env in any parent (handles worktrees)
const fs = require('fs');
let envDir = path.resolve(__dirname, '..');
let envFound = false;
for (let i = 0; i < 6 && !envFound; i++) {
  const envPath = path.join(envDir, '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, override: true });
    console.log(`Loaded .env from ${envPath}`);
    envFound = true;
  }
  envDir = path.resolve(envDir, '..');
}
// Also check sibling worktrees (for shared API keys during development)
if (!process.env.ANTHROPIC_API_KEY) {
  // __dirname is analyzer/server/, go up to the main repo root
  // In a worktree: analyzer/server -> analyzer -> recursing-wilbur -> worktrees -> .claude -> GermanAI
  const possibleRoots = [
    path.resolve(__dirname, '../../../../..'),  // worktree path
    path.resolve(__dirname, '../..'),           // direct repo path
  ];
  for (const root of possibleRoots) {
    try {
      const wtDir = path.join(root, '.claude', 'worktrees');
      if (!fs.existsSync(wtDir)) continue;
      const worktrees = fs.readdirSync(wtDir).filter(d =>
        fs.existsSync(path.join(wtDir, d, '.env'))
      );
      for (const wt of worktrees) {
        const wtEnv = path.join(wtDir, wt, '.env');
        dotenv.config({ path: wtEnv, override: true });
        if (process.env.ANTHROPIC_API_KEY) {
          console.log(`Loaded API keys from worktree: ${wt}`);
          break;
        }
      }
      if (process.env.ANTHROPIC_API_KEY) break;
    } catch (_) {}
  }
}

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Catch body-parser errors (e.g. payload too large) and return JSON instead of HTML
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Payload too large', message: 'The analysis data exceeds the maximum size.' });
  }
  if (err.status === 400 && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Invalid JSON', message: err.message });
  }
  next(err);
});

// Load unit display names
let unitNames = {};
try {
  unitNames = JSON.parse(fs.readFileSync(path.join(__dirname, './unitNames.json'), 'utf8'));
  console.log(`Unit names loaded: ${Object.keys(unitNames).length} entries`);
} catch (e) {
  console.warn('unitNames.json not found — unit names will be empty');
}

// Load curriculum data
const { loadUnits, buildVocabIndex } = require('./services/vocabIndex');
const unitMap = loadUnits();
const vocabData = buildVocabIndex(unitMap);

// Load auth service
const auth = require('./services/auth');

// Initialize and mount API routes
const { router: analyzerRouter, init: initAnalyzer } = require('./routes/analyzer');
initAnalyzer({ unitMap, vocabData, auth, unitNames });
app.use('/api', analyzerRouter);

// Serve frontend static files (production)
const distPath = path.join(__dirname, '../frontend/dist');
const { existsSync } = require('fs');
if (existsSync(distPath)) {
  app.use(express.static(distPath));
  app.get('*', (req, res) => {
    res.sendFile(path.join(distPath, 'index.html'));
  });
  console.log(`Serving frontend from ${distPath}`);
}

app.listen(PORT, () => {
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  Impuls Deutsch Text Analyzer                           ║`);
  console.log(`║  Server running on port ${PORT}                            ║`);
  console.log(`║  Units loaded: ${Object.keys(unitMap).length.toString().padEnd(41)}║`);
  console.log(`║  Vocab index: ${vocabData.vocabIndex.size} unique words${' '.repeat(Math.max(0, 29 - String(vocabData.vocabIndex.size).length))}║`);
  console.log(`║  Verb forms: ${vocabData.verbFormIndex.size} entries${' '.repeat(Math.max(0, 32 - String(vocabData.verbFormIndex.size).length))}║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
});
