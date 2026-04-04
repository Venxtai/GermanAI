import { create } from 'zustand';

// Restore session from sessionStorage (survives page refresh)
function loadSession() {
  try {
    const saved = sessionStorage.getItem('analyzer_session');
    if (saved) return JSON.parse(saved);
  } catch (_) {}
  return null;
}

const savedSession = loadSession();

const useAnalyzerStore = create((set, get) => ({
  // Auth — restored from sessionStorage
  accessCode: savedSession?.accessCode || null,
  isAuthenticated: !!savedSession?.sessionId,
  authError: null,
  sessionId: savedSession?.sessionId || null,
  remainingUses: savedSession?.remainingUses ?? null,

  // Unit selection
  chapters: null,
  selectedUnits: new Set(JSON.parse(localStorage.getItem('analyzer_selectedUnits') || '[]')),

  // Input — restored from sessionStorage
  inputText: savedSession?.inputText || '',
  inputHtml: savedSession?.inputHtml || '',
  inputMode: 'paste',
  uploadedFilename: null,

  // Analysis — restored from sessionStorage
  _restoredAnalysis: !!savedSession?.analysisResult, // flag: was analysis restored?

  // New session dialog
  showNewSessionDialog: false,

  // Analysis state — restored from sessionStorage
  isAnalyzing: false,
  analysisResult: savedSession?.analysisResult || null,

  // Interaction
  selectedWord: null,
  selectedCircle: null,
  selectedRewriteWord: null,
  infoPanel: 'instructions',

  // Word modifications — restored from sessionStorage
  wordModifications: savedSession?.wordModifications || {},
  sentenceRewrites: savedSession?.sentenceRewrites || {},

  // Formatting preservation (bold/italic from paste/upload)
  wordFormatting: savedSession?.wordFormatting || {},

  // Cached word alternatives
  wordAlternatives: savedSession?.wordAlternatives || {},

  // What If mode
  whatIfMode: false,
  whatIfUnits: null, // Set, only used in What If mode
  whatIfResults: null, // { wordStatuses, readability } from recheck API
  whatIfLoading: false,

  // Read-only shared session
  isReadOnly: false,
  shareId: null,

  // Auto-adapt
  isAutoAdapting: false,

  // Vocabulary lookup
  showVocabLookup: false,

  // Batch comparison mode
  compareMode: false,
  compareTexts: [], // [{id, text, html, analysisResult, wordModifications, sentenceRewrites, wordFormatting}]
  activeCompareId: null,
  editingCompareId: null,
  _savedMainState: null,
  showAddTextsDialog: false,

  // Actions
  setAccessCode: (code) => { set({ accessCode: code }); _saveSession(get()); },
  setAuthenticated: (val) => set({ isAuthenticated: val }),
  setSessionId: (id) => { set({ sessionId: id }); _saveSession(get()); },
  setRemainingUses: (n) => { set({ remainingUses: n }); _saveSession(get()); },
  setAuthError: (err) => set({ authError: err }),

  setChapters: (chapters) => set({ chapters }),

  setWhatIfResults: (results) => set({ whatIfResults: results }),
  setWhatIfLoading: (val) => set({ whatIfLoading: val }),

  toggleUnit: (unitId) => {
    const current = get().whatIfMode ? new Set(get().whatIfUnits) : new Set(get().selectedUnits);
    if (current.has(unitId)) {
      current.delete(unitId);
    } else {
      current.add(unitId);
    }
    if (get().whatIfMode) {
      set({ whatIfUnits: new Set(current) });
    } else {
      set({ selectedUnits: new Set(current) });
      localStorage.setItem('analyzer_selectedUnits', JSON.stringify([...current]));
    }
  },

  selectAllInChapter: (bookId, chapter) => {
    const current = get().whatIfMode ? new Set(get().whatIfUnits) : new Set(get().selectedUnits);
    const chapData = get().chapters?.[bookId]?.chapters?.find(c => c.chapter === chapter.chapter);
    if (chapData?.units) {
      for (const u of chapData.units) current.add(u.id);
    }
    if (get().whatIfMode) {
      set({ whatIfUnits: new Set(current) });
    } else {
      set({ selectedUnits: new Set(current) });
      localStorage.setItem('analyzer_selectedUnits', JSON.stringify([...current]));
    }
  },

  deselectAllInChapter: (bookId, chapter) => {
    const current = get().whatIfMode ? new Set(get().whatIfUnits) : new Set(get().selectedUnits);
    const chapData = get().chapters?.[bookId]?.chapters?.find(c => c.chapter === chapter.chapter);
    if (chapData?.units) {
      for (const u of chapData.units) current.delete(u.id);
    }
    if (get().whatIfMode) {
      set({ whatIfUnits: new Set(current) });
    } else {
      set({ selectedUnits: new Set(current) });
      localStorage.setItem('analyzer_selectedUnits', JSON.stringify([...current]));
    }
  },

  selectAllInBook: (bookId) => {
    const current = get().whatIfMode ? new Set(get().whatIfUnits) : new Set(get().selectedUnits);
    const book = get().chapters?.[bookId];
    if (book?.chapters) {
      for (const ch of book.chapters) {
        for (const u of (ch.units || [])) current.add(u.id);
      }
    }
    if (get().whatIfMode) {
      set({ whatIfUnits: new Set(current) });
    } else {
      set({ selectedUnits: new Set(current) });
      localStorage.setItem('analyzer_selectedUnits', JSON.stringify([...current]));
    }
  },

  deselectAllInBook: (bookId) => {
    const current = get().whatIfMode ? new Set(get().whatIfUnits) : new Set(get().selectedUnits);
    const book = get().chapters?.[bookId];
    if (book?.chapters) {
      for (const ch of book.chapters) {
        for (const u of (ch.units || [])) current.delete(u.id);
      }
    }
    if (get().whatIfMode) {
      set({ whatIfUnits: new Set(current) });
    } else {
      set({ selectedUnits: new Set(current) });
      localStorage.setItem('analyzer_selectedUnits', JSON.stringify([...current]));
    }
  },

  setInputText: (text) => { set({ inputText: text }); _saveSession(get()); },
  setInputHtml: (html) => { set({ inputHtml: html }); _saveSession(get()); },
  setWordFormatting: (map) => { set({ wordFormatting: map }); _saveSession(get()); },
  setUploadedFilename: (name) => set({ uploadedFilename: name }),

  setAnalyzing: (val) => set({ isAnalyzing: val }),
  setAnalysisResult: (result) => { set({ analysisResult: result }); _saveSession(get()); },

  selectWord: (sentenceIndex, wordIndex) => {
    const sentence = get().analysisResult?.sentences?.[sentenceIndex];
    const word = sentence?.words?.[wordIndex];
    if (word) {
      set({ selectedWord: { sentenceIndex, wordIndex, word }, selectedCircle: null, selectedRewriteWord: null, infoPanel: 'word' });
    }
  },

  selectCircle: (sentenceIndex) => {
    set({ selectedCircle: { sentenceIndex }, selectedWord: null, selectedRewriteWord: null, infoPanel: 'circle' });
  },

  selectRewriteWord: (sentenceIndex, wordText, isChanged) => {
    const rewrite = get().sentenceRewrites[sentenceIndex];
    set({
      selectedRewriteWord: { sentenceIndex, wordText, isChanged, rewrite },
      selectedWord: null,
      selectedCircle: null,
      infoPanel: 'rewriteWord',
    });
  },

  clearSelection: () => set({ selectedWord: null, selectedCircle: null, selectedRewriteWord: null, infoPanel: 'instructions' }),

  setWordAlternatives: (sentenceIndex, wordIndex, data) => {
    const key = `${sentenceIndex}_${wordIndex}`;
    const alts = { ...get().wordAlternatives };
    alts[key] = data;
    set({ wordAlternatives: alts });
    // Only save to session if not loading (avoid saving intermediate loading states)
    if (!data.loading) _saveSession(get());
  },

  getWordAlternatives: (sentenceIndex, wordIndex) => {
    return get().wordAlternatives[`${sentenceIndex}_${wordIndex}`] || null;
  },

  setWordModification: (sentenceIndex, wordIndex, mod) => {
    const key = `${sentenceIndex}_${wordIndex}`;
    const mods = { ...get().wordModifications };
    if (mod === null) {
      delete mods[key];
    } else {
      mods[key] = mod;
    }
    set({ wordModifications: mods });
    _saveSession(get());
  },

  setSentenceRewrite: (sentenceIndex, rewrite) => {
    const rewrites = { ...get().sentenceRewrites };
    if (rewrite === null) {
      delete rewrites[sentenceIndex];
    } else {
      rewrites[sentenceIndex] = rewrite;
    }
    set({ sentenceRewrites: rewrites });
    _saveSession(get());
  },

  toggleWhatIfMode: () => {
    const current = get().whatIfMode;
    if (!current) {
      // Entering What If mode — copy current selection
      set({ whatIfMode: true, whatIfUnits: new Set(get().selectedUnits), whatIfResults: null });
    } else {
      // Exiting What If mode — clear results
      set({ whatIfMode: false, whatIfUnits: null, whatIfResults: null, whatIfLoading: false });
    }
  },

  toggleVocabLookup: () => set({ showVocabLookup: !get().showVocabLookup }),

  // Auto-adapt actions
  setAutoAdapting: (val) => set({ isAutoAdapting: val }),
  applyAutoAdaptResults: (wordMods, sentRewrites) => {
    const current = get();
    set({
      wordModifications: { ...current.wordModifications, ...wordMods },
      sentenceRewrites: { ...current.sentenceRewrites, ...sentRewrites },
    });
    _saveSession(get());
  },

  // Read-only shared session actions
  setReadOnly: (val) => set({ isReadOnly: val }),
  setShareId: (id) => set({ shareId: id }),
  loadSharedSession: (state) => {
    // Hydrate store from a shared session snapshot
    set({
      inputText: state.inputText || '',
      inputHtml: state.inputHtml || '',
      analysisResult: state.analysisResult || null,
      wordModifications: state.wordModifications || {},
      sentenceRewrites: state.sentenceRewrites || {},
      wordAlternatives: state.wordAlternatives || {},
      wordFormatting: state.wordFormatting || {},
    });
    // Restore selected units
    if (state.selectedUnits && Array.isArray(state.selectedUnits)) {
      set({ selectedUnits: new Set(state.selectedUnits) });
      localStorage.setItem('analyzer_selectedUnits', JSON.stringify(state.selectedUnits));
    }
  },

  // New Session — show confirmation dialog
  requestNewSession: () => set({ showNewSessionDialog: true }),
  cancelNewSession: () => set({ showNewSessionDialog: false }),

  // Start new session with same access code (uses another credit)
  confirmNewSessionSameCode: async () => {
    const { accessCode } = get();
    set({ showNewSessionDialog: false });

    // Validate again (uses a credit)
    try {
      const res = await fetch('/api/auth/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: accessCode }),
      });
      const data = await res.json();
      if (data.valid) {
        set({
          sessionId: data.sessionId,
          remainingUses: data.remainingUses ?? get().remainingUses,
          inputText: '', inputHtml: '', uploadedFilename: null, isAnalyzing: false, analysisResult: null,
          selectedWord: null, selectedCircle: null, selectedRewriteWord: null,
          infoPanel: 'instructions', wordModifications: {}, sentenceRewrites: {},
          wordAlternatives: {}, wordFormatting: {}, whatIfMode: false, whatIfUnits: null,
          whatIfResults: null, whatIfLoading: false,
        });
        _saveSession(get());
      } else {
        alert(data.error || 'Could not start new session — no uses remaining');
      }
    } catch (err) {
      alert('Could not connect to server');
    }
  },

  // Start new session with different access code (go back to login)
  confirmNewSessionDifferentCode: () => {
    set({
      showNewSessionDialog: false,
      accessCode: null, isAuthenticated: false, sessionId: null, authError: null,
      inputText: '', inputHtml: '', uploadedFilename: null, isAnalyzing: false, analysisResult: null,
      selectedWord: null, selectedCircle: null, selectedRewriteWord: null,
      infoPanel: 'instructions', wordModifications: {}, sentenceRewrites: {},
      wordAlternatives: {}, wordFormatting: {}, whatIfMode: false, whatIfUnits: null,
      whatIfResults: null, whatIfLoading: false,
    });
    sessionStorage.removeItem('analyzer_session');
  },

  // Batch comparison actions
  setShowAddTextsDialog: (val) => set({ showAddTextsDialog: val }),
  setCompareMode: (val) => set({ compareMode: val }),
  setCompareTexts: (texts) => set({ compareTexts: texts }),
  setActiveCompareId: (id) => set({ activeCompareId: id }),

  promoteCompareText: (id) => {
    const ct = get().compareTexts.find(t => t.id === id);
    if (!ct) return;
    set({
      inputText: ct.text,
      inputHtml: ct.html || '',
      analysisResult: ct.analysisResult,
      wordModifications: ct.wordModifications || {},
      sentenceRewrites: ct.sentenceRewrites || {},
      wordFormatting: ct.wordFormatting || {},
      compareMode: false,
      compareTexts: [],
      activeCompareId: null,
      editingCompareId: null,
      _savedMainState: null,
    });
    _saveSession(get());
  },

  editCompareText: (id) => {
    const ct = get().compareTexts.find(t => t.id === id);
    if (!ct) return;
    set({
      _savedMainState: {
        inputText: get().inputText,
        inputHtml: get().inputHtml,
        analysisResult: get().analysisResult,
        wordModifications: get().wordModifications,
        sentenceRewrites: get().sentenceRewrites,
        wordFormatting: get().wordFormatting,
      },
      inputText: ct.text,
      inputHtml: ct.html || '',
      analysisResult: ct.analysisResult,
      wordModifications: ct.wordModifications || {},
      sentenceRewrites: ct.sentenceRewrites || {},
      wordFormatting: ct.wordFormatting || {},
      compareMode: false,
      editingCompareId: id,
    });
  },

  returnFromEdit: () => {
    const editId = get().editingCompareId;
    const saved = get()._savedMainState;
    if (!editId || !saved) return;
    const updated = get().compareTexts.map(ct =>
      ct.id === editId ? {
        ...ct,
        text: get().inputText,
        html: get().inputHtml,
        analysisResult: get().analysisResult,
        wordModifications: { ...get().wordModifications },
        sentenceRewrites: { ...get().sentenceRewrites },
        wordFormatting: { ...get().wordFormatting },
      } : ct
    );
    set({
      inputText: saved.inputText,
      inputHtml: saved.inputHtml,
      analysisResult: saved.analysisResult,
      wordModifications: saved.wordModifications,
      sentenceRewrites: saved.sentenceRewrites,
      wordFormatting: saved.wordFormatting,
      compareTexts: updated,
      compareMode: true,
      editingCompareId: null,
      _savedMainState: null,
    });
  },

  // Get effective selected units (respects What If mode)
  getEffectiveUnits: () => {
    const state = get();
    return state.whatIfMode ? state.whatIfUnits : state.selectedUnits;
  },
}));

// Save full session state to sessionStorage (survives page refresh)
function _saveSession(state) {
  try {
    sessionStorage.setItem('analyzer_session', JSON.stringify({
      accessCode: state.accessCode,
      sessionId: state.sessionId,
      remainingUses: state.remainingUses,
      inputText: state.inputText,
      inputHtml: state.inputHtml,
      analysisResult: state.analysisResult,
      wordModifications: state.wordModifications,
      sentenceRewrites: state.sentenceRewrites,
      wordAlternatives: state.wordAlternatives,
      wordFormatting: state.wordFormatting,
    }));
  } catch (e) {
    // sessionStorage might be full for very large texts — try without alternatives cache
    try {
      sessionStorage.setItem('analyzer_session', JSON.stringify({
        accessCode: state.accessCode,
        sessionId: state.sessionId,
        remainingUses: state.remainingUses,
        inputText: state.inputText,
        inputHtml: state.inputHtml,
        analysisResult: state.analysisResult,
        wordModifications: state.wordModifications,
        sentenceRewrites: state.sentenceRewrites,
        wordFormatting: state.wordFormatting,
      }));
    } catch (_) {}
  }
}

export default useAnalyzerStore;
