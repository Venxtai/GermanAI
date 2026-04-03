import { useState } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

export default function Header() {
  const {
    requestNewSession, toggleVocabLookup, whatIfMode, toggleWhatIfMode,
    analysisResult, isReadOnly, setReadOnly, setShareId, loadSharedSession,
    shareId, sessionId, inputText, selectedUnits, wordModifications,
    sentenceRewrites, wordAlternatives, setAuthenticated, setSessionId,
    setRemainingUses, setAccessCode,
  } = useAnalyzerStore();

  const [sharing, setSharing] = useState(false);
  const [shareSuccess, setShareSuccess] = useState(false);
  const [showCloneDialog, setShowCloneDialog] = useState(false);
  const [cloneCode, setCloneCode] = useState('');
  const [cloneError, setCloneError] = useState('');
  const [cloning, setCloning] = useState(false);

  // Share current session
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
      };
      const res = await fetch('/api/session/share', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, sessionState }),
      });
      const data = await res.json();
      if (data.shareUrl) {
        await navigator.clipboard.writeText(data.shareUrl);
        setShareSuccess(true);
        setTimeout(() => setShareSuccess(false), 3000);
      } else {
        alert('Share failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Share failed: ' + err.message);
    } finally {
      setSharing(false);
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
        {!isReadOnly && analysisResult && (
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

        {/* Share button: only when authenticated and not in read-only mode */}
        {!isReadOnly && analysisResult && (
          <button
            onClick={handleShare}
            disabled={sharing}
            className="px-3 py-1.5 text-sm text-white rounded-lg transition-colors font-medium disabled:opacity-50"
            style={{ backgroundColor: shareSuccess ? '#22c55e' : 'var(--brand-blau, #00528a)' }}
          >
            {sharing ? 'Sharing...' : shareSuccess ? 'Link Copied!' : 'Share Results'}
          </button>
        )}

        {/* Read-only mode: "Edit This Session" button replaces "New Session" */}
        {isReadOnly ? (
          <button
            onClick={() => setShowCloneDialog(true)}
            className="px-3 py-1.5 text-sm text-white rounded-lg transition-colors font-medium"
            style={{ backgroundColor: 'var(--brand-blau, #00528a)' }}
          >
            Edit This Session
          </button>
        ) : (
          <button
            onClick={requestNewSession}
            className="px-3 py-1.5 text-sm text-white rounded-lg transition-colors font-medium"
            style={{ backgroundColor: 'var(--brand)' }}
            onMouseEnter={e => e.target.style.backgroundColor = 'var(--brand-dark)'}
            onMouseLeave={e => e.target.style.backgroundColor = 'var(--brand)'}
          >
            New Session
          </button>
        )}
      </div>

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
