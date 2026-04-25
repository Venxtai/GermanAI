import { useState } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';
import { buildExportData } from '../utils/exportData';

export default function Header() {
  const {
    requestNewSession, toggleVocabLookup, whatIfMode, toggleWhatIfMode,
    analysisResult, isReadOnly, setReadOnly, setShareId, loadSharedSession,
    shareId, sessionId, inputText, selectedUnits, wordModifications,
    sentenceRewrites, wordAlternatives, wordFormatting, setAuthenticated, setSessionId,
    setRemainingUses, setAccessCode,
    isAutoAdapting, setAutoAdapting, applyAutoAdaptResults,
    compareMode, editingCompareId, returnFromEdit, setShowAddTextsDialog,
    setCompareMode, setCompareTexts, setActiveCompareId,
  } = useAnalyzerStore();

  const [sharing, setSharing] = useState(false);
  const [shareSuccess, setShareSuccess] = useState(false);
  const [shareUrl, setShareUrl] = useState(null);
  const [showExportMenu, setShowExportMenu] = useState(false);
  const [exporting, setExporting] = useState(null);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [cloneCode, setCloneCode] = useState('');
  const [cloneError, setCloneError] = useState('');
  const [cloning, setCloning] = useState(false);

  // Share current session — generates URL, then shows dialog for copying
  const handleShare = async () => {
    if (!sessionId || !analysisResult) return;
    setSharing(true);
    try {
      const sessionState = {
        inputText,
        selectedUnits: Array.from(selectedUnits),
        analysisResult,
        wordModifications,
        sentenceRewrites,
        wordAlternatives,
        wordFormatting,
      };
      const res = await fetch('/api/session/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, sessionState }),
      });
      const data = await res.json();
      if (data.shareUrl) {
        // Show dialog with the URL — clipboard write needs a fresh user gesture
        setShareUrl(data.shareUrl);
      } else {
        alert('Share failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Share failed: ' + err.message);
    } finally {
      setSharing(false);
    }
  };

  // Copy share URL to clipboard — called from dialog button (fresh user gesture)
  const handleCopyShareUrl = async () => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
    } catch {
      // Last-resort fallback
      const textarea = document.createElement('textarea');
      textarea.value = shareUrl;
      textarea.style.cssText = 'position:fixed;left:0;top:0;opacity:0;';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
    }
    setShareSuccess(true);
    setShareUrl(null);
    setTimeout(() => setShareSuccess(false), 3000);
  };

  // Export PDF
  const handleExport = async (mode) => {
    setExporting(mode);
    setShowExportMenu(false);
    try {
      const data = buildExportData(mode, { analysisResult, wordModifications, sentenceRewrites, selectedUnits, wordFormatting });
      const res = await fetch('/api/analyzer/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = mode === 'teacher' ? 'text-analysis-teacher-key.pdf' : 'text-analysis-student.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Export failed: ' + err.message);
    } finally {
      setExporting(null);
    }
  };

  // Count unknown words for button label
  const unknownCount = analysisResult?.sentences?.reduce((sum, s) =>
    sum + s.words.filter(w => w.type === 'word' && w.status === 'unknown').length, 0) || 0;
  // Check if any replacements already made
  const hasReplacements = Object.keys(wordModifications).length > 0 || Object.keys(sentenceRewrites).length > 0;

  // Auto-Adapt: replace all unknown words with AI-selected alternatives
  const handleAutoAdapt = async () => {
    if (!analysisResult || unknownCount === 0) return;
    setAutoAdapting(true);
    try {
      const res = await fetch('/api/analyzer/auto-adapt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sentences: analysisResult.sentences.map(s => ({
            text: s.text,
            words: s.words,
          })),
          selectedUnits: Array.from(selectedUnits),
        }),
      });
      const data = await res.json();
      if (data.wordModifications && data.sentenceRewrites) {
        applyAutoAdaptResults(data.wordModifications, data.sentenceRewrites);
      }
      if (data.summary) {
        console.log(`[AUTO-ADAPT] ${data.summary.adapted} adapted, ${data.summary.noAlternative} no alternative`);
      }
    } catch (err) {
      alert('Auto-adapt failed: ' + err.message);
    } finally {
      setAutoAdapting(false);
    }
  };

  // Clone shared session into editable session
  const handleClone = async () => {
    if (!cloneCode.trim()) return;
    setCloning(true);
    setCloneError('');
    try {
      const res = await fetch('/api/session/clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ shareId, code: cloneCode.trim() }),
      });
      const data = await res.json();
      if (data.valid) {
        // Hydrate store with cloned session
        loadSharedSession(data.sessionState);
        setAccessCode(cloneCode.trim());
        setSessionId(data.sessionId);
        setRemainingUses(data.remainingUses);
        setReadOnly(false);
        setShareId(null);
        setShowCloneDialog(false);
        // Clean up URL
        window.history.replaceState({}, '', window.location.pathname);
      } else {
        setCloneError(data.error || 'Invalid access code');
      }
    } catch (err) {
      setCloneError('Connection failed: ' + err.message);
    } finally {
      setCloning(false);
    }
  };

  return (
    <header className="bg-white border-b border-slate-200 px-6 py-3 flex items-center justify-between flex-shrink-0">
      <div className="flex items-center gap-3">
        <h1 className="text-lg font-bold text-slate-800">Impuls Deutsch</h1>
        <span className="text-sm font-medium px-2 py-0.5 rounded" style={{ color: 'var(--brand)', backgroundColor: 'var(--brand-light)' }}>Text Analyzer</span>
        {isReadOnly && (
          <span className="text-xs font-medium px-2 py-0.5 rounded bg-slate-200 text-slate-500">Read-Only</span>
        )}
      </div>

      <div className="flex items-center gap-3">
        {analysisResult && !compareMode && !editingCompareId && (
          <button
            onClick={toggleWhatIfMode}
            className={`px-3 py-1.5 text-sm rounded-lg font-medium transition-colors ${
              whatIfMode
                ? 'bg-amber-100 text-amber-800 border border-amber-300'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {whatIfMode ? 'Exit What If' : 'What If Mode'}
          </button>
        )}

        <button
          onClick={toggleVocabLookup}
          className="px-3 py-1.5 text-sm bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors font-medium"
        >
          Vocabulary Lookup
        </button>

        {/* Compare Texts button — visible when analysis exists, not read-only, not already in compare/edit mode */}
        {analysisResult && !isReadOnly && !compareMode && !editingCompareId && (
          <button
            onClick={() => setShowAddTextsDialog(true)}
            className="px-3 py-1.5 text-sm bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors font-medium"
          >
            Compare Texts
          </button>
        )}

        {/* Exit comparison mode */}
        {compareMode && (
          <button
            onClick={() => { setCompareMode(false); setCompareTexts([]); setActiveCompareId(null); }}
            className="px-3 py-1.5 text-sm bg-slate-100 text-slate-600 rounded-lg hover:bg-slate-200 transition-colors font-medium"
          >
            Exit Comparison
          </button>
        )}

        {/* Auto-Adapt: only when analysis exists, has unknown words, no replacements yet, and not read-only */}
        {!isReadOnly && analysisResult && unknownCount > 0 && !hasReplacements && !compareMode && !editingCompareId && (
          <button
            onClick={handleAutoAdapt}
            disabled={isAutoAdapting}
            className="px-3 py-1.5 text-sm text-white rounded-lg transition-colors font-medium disabled:opacity-50"
            style={{ backgroundColor: 'var(--brand-orange, #ed6c28)' }}
          >
            {isAutoAdapting ? 'Adapting...' : `Auto-Adapt (${unknownCount} words)`}
          </button>
        )}

        {/* Export & Share dropdown — hidden in compare mode */}
        {analysisResult && !compareMode && !editingCompareId && (
          <div className="relative">
            <button
              onClick={() => setShowExportMenu(!showExportMenu)}
              disabled={!!exporting || sharing}
              className="px-3 py-1.5 text-sm text-white rounded-lg transition-colors font-medium disabled:opacity-50 flex items-center gap-1.5"
              style={{ backgroundColor: shareSuccess ? '#22c55e' : 'var(--brand-blau, #00528a)' }}
            >
              {exporting ? `Exporting...` : shareSuccess ? 'Link Copied!' : (
                <>
                  Export & Share
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </>
              )}
            </button>

            {showExportMenu && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setShowExportMenu(false)} />
                <div className="absolute right-0 top-full mt-1 z-50 bg-white rounded-lg shadow-xl border border-slate-200 py-1 w-72">
                  <button
                    onClick={() => { setShowExportMenu(false); handleExport('student'); }}
                    className="w-full text-left px-4 py-2.5 hover:bg-slate-50 transition-colors"
                  >
                    <span className="text-sm font-medium text-slate-700 block">Export Student Version (PDF)</span>
                    <span className="text-xs text-slate-400">Clean text with translations only</span>
                  </button>
                  <div className="border-t border-slate-100" />
                  <button
                    onClick={() => { setShowExportMenu(false); handleExport('teacher'); }}
                    className="w-full text-left px-4 py-2.5 hover:bg-slate-50 transition-colors"
                  >
                    <span className="text-sm font-medium text-slate-700 block">Export Teacher Version (PDF)</span>
                    <span className="text-xs text-slate-400">Color-coded comparison with vocabulary and grammar notes</span>
                  </button>
                  {!isReadOnly && (
                    <>
                      <div className="border-t border-slate-100" />
                      <button
                        onClick={() => { setShowExportMenu(false); handleShare(); }}
                        className="w-full text-left px-4 py-2.5 hover:bg-slate-50 transition-colors"
                      >
                        <span className="text-sm font-medium text-slate-700 block">Share with Colleagues (Link)</span>
                        <span className="text-xs text-slate-400">Interactive link — recipients can explore, adjust, and export</span>
                      </button>
                    </>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* Back to Comparison button when editing a compare text */}
        {editingCompareId ? (
          <button
            onClick={returnFromEdit}
            className="px-3 py-1.5 text-sm text-white rounded-lg transition-colors font-medium"
            style={{ backgroundColor: 'var(--brand-blau, #00528a)' }}
          >
            Back to Comparison
          </button>
        ) : isReadOnly ? (
          <button
            onClick={() => setShowCloneDialog(true)}
            className="px-3 py-1.5 text-sm text-white rounded-lg transition-colors font-medium"
            style={{ backgroundColor: 'var(--brand-blau, #00528a)' }}
          >
            Edit
          </button>
        ) : !compareMode ? (
          <button
            onClick={requestNewSession}
            className="px-3 py-1.5 text-sm text-white rounded-lg transition-colors font-medium"
            style={{ backgroundColor: 'var(--brand)' }}
            onMouseEnter={e => e.target.style.backgroundColor = 'var(--brand-dark)'}
            onMouseLeave={e => e.target.style.backgroundColor = 'var(--brand)'}
          >
            New Session
          </button>
        ) : null}
      </div>

      {/* Share URL dialog — user clicks Copy for a fresh gesture */}
      {shareUrl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-[28rem] space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Share Link Ready</h3>
            <input
              type="text"
              value={shareUrl}
              readOnly
              onClick={(e) => e.target.select()}
              className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm bg-slate-50 font-mono"
            />
            <div className="flex gap-2">
              <button
                onClick={handleCopyShareUrl}
                className="flex-1 py-2 text-white rounded-lg text-sm font-medium"
                style={{ backgroundColor: 'var(--brand-blau, #00528a)' }}
              >
                Copy Link
              </button>
              <button
                onClick={() => setShareUrl(null)}
                className="flex-1 py-2 bg-slate-100 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-200"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Clone dialog */}
      {showCloneDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-96 space-y-4">
            <h3 className="text-lg font-bold text-slate-800">Edit This Session</h3>
            <p className="text-sm text-slate-500">
              Enter an access code to create an editable copy of this session. This will use one credit from your code.
            </p>
            <input
              type="text"
              value={cloneCode}
              onChange={(e) => setCloneCode(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleClone(); }}
              placeholder="Access code"
              className="w-full px-3 py-2 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 text-sm"
              style={{ '--tw-ring-color': 'var(--brand)' }}
              autoFocus
            />
            {cloneError && (
              <p className="text-sm text-red-500">{cloneError}</p>
            )}
            <div className="flex gap-2">
              <button
                onClick={handleClone}
                disabled={cloning || !cloneCode.trim()}
                className="flex-1 py-2 text-white rounded-lg text-sm font-medium disabled:opacity-50"
                style={{ backgroundColor: 'var(--brand-blau, #00528a)' }}
              >
                {cloning ? 'Validating...' : 'Start Editing'}
              </button>
              <button
                onClick={() => { setShowCloneDialog(false); setCloneError(''); setCloneCode(''); }}
                className="flex-1 py-2 bg-slate-100 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
}
