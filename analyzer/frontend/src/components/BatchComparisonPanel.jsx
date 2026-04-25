import useAnalyzerStore from '../store/useAnalyzerStore';
import ComparisonColumn from './ComparisonColumn';

export default function BatchComparisonPanel() {
  const { compareTexts } = useAnalyzerStore();

  if (!compareTexts || compareTexts.length === 0) return null;

  return (
    <div className="flex gap-4 p-4 h-full">
      {compareTexts.map(ct => (
        <ComparisonColumn key={ct.id} compareText={ct} />
      ))}
    </div>
  );
}
