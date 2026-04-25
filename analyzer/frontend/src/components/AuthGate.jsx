import { useState } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

export default function AuthGate() {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const { setAccessCode, setAuthenticated, setSessionId, setRemainingUses, authError, setAuthError } = useAnalyzerStore();

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!code.trim()) return;

    setLoading(true);
    setAuthError(null);

    try {
      const res = await fetch('/api/auth/validate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim() }),
      });
      const data = await res.json();

      if (data.valid) {
        setAccessCode(code.trim());
        setSessionId(data.sessionId);
        if (data.remainingUses !== undefined) setRemainingUses(data.remainingUses);
        setAuthenticated(true);
      } else {
        setAuthError(data.error || 'Invalid access code');
      }
    } catch (err) {
      setAuthError('Could not connect to server');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(135deg, #f8fafc 0%, #e6f4f6 50%, #f0f9ff 100%)' }}>
      <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-md">
        <div className="text-center mb-6">
          <h1 className="text-2xl font-bold text-slate-800">Impuls Deutsch</h1>
          <h2 className="text-lg font-medium mt-1" style={{ color: 'var(--brand)' }}>Text Analyzer</h2>
          <p className="text-sm text-slate-500 mt-3">
            Enter your access code to get started.
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="Enter access code"
            className="w-full px-4 py-3 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:border-transparent text-center text-lg tracking-wider"
            style={{ '--tw-ring-color': 'var(--brand)' }}
            autoFocus
          />

          {authError && (
            <p className="text-red-500 text-sm text-center">{authError}</p>
          )}

          <button
            type="submit"
            disabled={loading || !code.trim()}
            className="w-full py-3 text-white rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            style={{ backgroundColor: 'var(--brand)' }}
            onMouseEnter={e => { if (!e.target.disabled) e.target.style.backgroundColor = 'var(--brand-dark)'; }}
            onMouseLeave={e => e.target.style.backgroundColor = 'var(--brand)'}
          >
            {loading ? 'Verifying...' : 'Enter'}
          </button>
        </form>
      </div>
    </div>
  );
}
