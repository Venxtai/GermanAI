import { useEffect } from 'react';
import useAnalyzerStore from './store/useAnalyzerStore';
import AuthGate from './components/AuthGate';
import Header from './components/Header';
import UnitSelector from './components/UnitSelector';
import TextPanel from './components/TextPanel';
import InfoPanel from './components/InfoPanel';
import VocabLookup from './components/VocabLookup';
import Legend from './components/Legend';
import ReadabilityBanner from './components/ReadabilityBanner';
import useAutoSave from './hooks/useAutoSave';
import NewSessionDialog from './components/NewSessionDialog';

function ChapterWarnings() {
  const { analysisResult } = useAnalyzerStore();
  const warnings = analysisResult?.warnings;
  if (!warnings?.length) return null;

  return (
    <div id="chapter-warnings" className="px-6 py-2 bg-amber-50 border-b border-amber-200 space-y-1">
      {warnings.map((w, i) => (
        <div key={i} className="flex items-start gap-2 text-xs text-amber-800">
          <span className="mt-0.5 flex-shrink-0">&#9888;</span>
          <span><strong>Note:</strong> {w.message}</span>
        </div>
      ))}
    </div>
  );
}

export default function App() {
  const {
    isAuthenticated, chapters, setChapters, showVocabLookup,
    isReadOnly, setReadOnly, setShareId, loadSharedSession, setAuthenticated,
  } = useAnalyzerStore();

  // Auto-save adapted text PDF to Google Drive
  useAutoSave();

  // Check for ?share= parameter on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const shareId = params.get('share');
    if (shareId) {
      setShareId(shareId);
      setReadOnly(true);
      // Fetch shared session data
      fetch(`/api/session/shared/${encodeURIComponent(shareId)}`)
        .then(r => {
          if (!r.ok) throw new Error('Shared session not found');
          return r.json();
        })
        .then(state => {
          loadSharedSession(state);
          // Mark as authenticated so the main UI renders (skip AuthGate)
          setAuthenticated(true);
        })
        .catch(err => {
          console.error('Failed to load shared session:', err);
          alert('Could not load shared session. The link may be invalid or expired.');
          // Clear share state so user sees normal login
          setShareId(null);
          setReadOnly(false);
        });
    }
  }, []);

  // Load chapter data on mount
  useEffect(() => {
    if (!chapters) {
      fetch('/api/chapters')
        .then(r => r.json())
        .then(data => setChapters(data))
        .catch(err => console.error('Failed to load chapters:', err));
    }
  }, [chapters, setChapters]);

  if (!isAuthenticated) {
    return <AuthGate />;
  }

  return (
    <div className="h-screen flex flex-col bg-slate-50 overflow-hidden">
      <Header />
      <ReadabilityBanner />
      <ChapterWarnings />
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Unit selector */}
        <aside className="w-72 border-r border-slate-200 bg-white overflow-y-auto flex-shrink-0">
          <UnitSelector />
        </aside>

        {/* Center: Text panel */}
        <main className="flex-1 overflow-y-auto p-6">
          <TextPanel />
        </main>

        {/* Right: Info/interaction panel */}
        <aside className="w-96 border-l border-slate-200 bg-white overflow-y-auto flex-shrink-0">
          <InfoPanel />
        </aside>
      </div>
      <Legend />
      {showVocabLookup && <VocabLookup />}
      <NewSessionDialog />
    </div>
  );
}
