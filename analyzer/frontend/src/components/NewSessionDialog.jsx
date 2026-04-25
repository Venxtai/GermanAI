import useAnalyzerStore from '../store/useAnalyzerStore';

export default function NewSessionDialog() {
  const {
    showNewSessionDialog, cancelNewSession,
    confirmNewSessionSameCode, confirmNewSessionDifferentCode,
    remainingUses,
  } = useAnalyzerStore();

  if (!showNewSessionDialog) return null;

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={cancelNewSession}>
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-bold text-slate-800">Start a New Session?</h2>

        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3">
          <p className="text-sm text-amber-700">
            Starting a new session will use an additional credit from your access code.
            {remainingUses !== null && remainingUses >= 0 && (
              <span className="font-semibold"> You have {remainingUses} credit{remainingUses !== 1 ? 's' : ''} left.</span>
            )}
          </p>
        </div>

        <div className="space-y-2">
          <button
            onClick={cancelNewSession}
            className="w-full py-2.5 px-4 rounded-lg text-sm font-medium transition-colors text-white"
            style={{ backgroundColor: 'var(--brand)' }}
            onMouseEnter={e => e.target.style.backgroundColor = 'var(--brand-dark)'}
            onMouseLeave={e => e.target.style.backgroundColor = 'var(--brand)'}
          >
            Go Back to Active Session
          </button>

          <button
            onClick={confirmNewSessionSameCode}
            className="w-full py-2.5 px-4 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors text-sm font-medium"
          >
            New Session (Same Access Code)
          </button>

          <button
            onClick={confirmNewSessionDifferentCode}
            className="w-full py-2.5 px-4 bg-slate-50 text-slate-500 rounded-lg hover:bg-slate-100 transition-colors text-sm font-medium border border-slate-200"
          >
            New Session (Different Access Code)
          </button>
        </div>
      </div>
    </div>
  );
}
