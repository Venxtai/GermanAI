import useAnalyzerStore from '../store/useAnalyzerStore';

export default function Legend() {
  const { analysisResult, sessionId } = useAnalyzerStore();

  if (!analysisResult) return null;

  return (
    <div className="bg-white border-t border-slate-200 px-6 py-2 flex items-center justify-between flex-shrink-0">
      <div className="flex items-center gap-4 text-xs">
        <LegendItem color="bg-[var(--brand)]" label="Known" />
        <LegendItem color="bg-[var(--color-unknown)]" label="Unknown" />
        <LegendItem color="bg-[var(--color-replaced)]" label="Replaced" />
        <LegendItem color="bg-[var(--color-glossed)]" label="Translated" />
        <LegendItem color="bg-[var(--color-cognate)]" label="Cognate" />
      </div>

      {sessionId && (
        <span className="text-xs text-slate-300 font-mono">{sessionId}</span>
      )}
    </div>
  );
}

function LegendItem({ color, label }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={`w-2.5 h-2.5 rounded-full ${color}`} />
      <span className="text-slate-500">{label}</span>
    </div>
  );
}
