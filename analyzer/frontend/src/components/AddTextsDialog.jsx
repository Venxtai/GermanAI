import { useState, useRef } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';

export default function AddTextsDialog() {
  const {
    showAddTextsDialog, setShowAddTextsDialog,
    analysisResult, inputText, inputHtml,
    wordModifications, sentenceRewrites, wordFormatting,
    selectedUnits, setCompareMode, setCompareTexts, setActiveCompareId,
  } = useAnalyzerStore();

  const [texts, setTexts] = useState(['', '']);
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState('');
  const fileInputRefs = [useRef(null), useRef(null)];

  if (!showAddTextsDialog) return null;

  const handleTextChange = (index, value) => {
    const updated = [...texts];
    updated[index] = value;
    setTexts(updated);
  };

  const handleFileUpload = async (index, e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/api/analyzer/upload', {
        method: 'POST',
        body: formData,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      handleTextChange(index, data.text);
    } catch (err) {
      alert('File upload failed: ' + err.message);
    }

    if (fileInputRefs[index].current) fileInputRefs[index].current.value = '';
  };

  const handleCompare = async () => {
    // Filter to non-empty texts
    const newTexts = texts.filter(t => t.trim());
    if (newTexts.length === 0) return;

    setAnalyzing(true);

    // Build the compare texts array starting with the current analysis
    const compareItems = [{
      id: 'text-1',
      text: inputText,
      html: inputHtml,
      analysisResult,
      wordModifications: { ...wordModifications },
      sentenceRewrites: { ...sentenceRewrites },
      wordFormatting: { ...wordFormatting },
    }];

    try {
      for (let i = 0; i < newTexts.length; i++) {
        setProgress(`Analyzing text ${i + 1} of ${newTexts.length}...`);
        const res = await fetch('/api/analyzer/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: newTexts[i].trim(),
            selectedUnits: Array.from(selectedUnits),
          }),
        });

        if (!res.ok) {
          const errText = await res.text();
          throw new Error(errText || `Server error ${res.status}`);
        }

        // Endpoint streams SSE ("data: {...}\n\n") — read until we get a 'result' event.
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let data = null;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });

          const lines = buffer.split('\n');
          buffer = lines.pop(); // keep incomplete line for next read

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;
            try {
              const event = JSON.parse(jsonStr);
              if (event.type === 'progress') {
                const pct = typeof event.percent === 'number' ? ` ${Math.round(event.percent)}%` : '';
                setProgress(`Analyzing text ${i + 1} of ${newTexts.length}: ${event.step || ''}${pct}`);
              } else if (event.type === 'result') {
                data = event.data;
              } else if (event.type === 'error') {
                throw new Error(event.error || 'Analysis failed on server');
              }
            } catch (parseErr) {
              if (parseErr.message.includes('Analysis failed')) throw parseErr;
              console.warn('SSE parse error:', parseErr, jsonStr.substring(0, 200));
            }
          }
        }

        if (!data) throw new Error('No analysis result received');

        compareItems.push({
          id: `text-${i + 2}`,
          text: newTexts[i].trim(),
          html: '',
          analysisResult: data,
          wordModifications: {},
          sentenceRewrites: {},
          wordFormatting: {},
        });
      }

      setCompareTexts(compareItems);
      setActiveCompareId('text-1');
      setCompareMode(true);
      setShowAddTextsDialog(false);
      setTexts(['', '']);
      setProgress('');
    } catch (err) {
      alert('Analysis failed: ' + err.message);
    } finally {
      setAnalyzing(false);
      setProgress('');
    }
  };

  const handleClose = () => {
    setShowAddTextsDialog(false);
    setTexts(['', '']);
    setProgress('');
  };

  const hasAnyText = texts.some(t => t.trim());

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl p-6 w-[36rem] max-h-[80vh] overflow-y-auto space-y-4">
        <h3 className="text-lg font-bold text-slate-800">Compare Texts</h3>
        <p className="text-sm text-slate-500">
          Add 1-2 additional texts to compare with your current analysis. Each text will be analyzed against the same selected units.
        </p>

        {[0, 1].map(i => (
          <div key={i} className="space-y-2">
            <label className="text-sm font-medium text-slate-700">
              Text {i + 1} {i === 1 && <span className="text-slate-400 font-normal">(optional)</span>}
            </label>
            <textarea
              value={texts[i]}
              onChange={(e) => handleTextChange(i, e.target.value)}
              placeholder={`Paste German text here...`}
              className="w-full h-32 p-3 border border-slate-300 rounded-lg resize-y focus:outline-none focus:ring-2 text-sm"
              style={{ '--tw-ring-color': 'var(--brand)' }}
              disabled={analyzing}
            />
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Or upload:</span>
              <input
                ref={fileInputRefs[i]}
                type="file"
                accept=".txt,.pdf,.docx"
                onChange={(e) => handleFileUpload(i, e)}
                disabled={analyzing}
                className="text-xs text-slate-500 file:mr-2 file:py-1 file:px-2 file:rounded file:border-0 file:text-xs file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 file:cursor-pointer"
              />
            </div>
          </div>
        ))}

        {progress && (
          <div className="flex items-center gap-2 text-sm text-slate-600">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
            </svg>
            {progress}
          </div>
        )}

        <div className="flex gap-2 pt-2">
          <button
            onClick={handleCompare}
            disabled={analyzing || !hasAnyText}
            className="flex-1 py-2 text-white rounded-lg text-sm font-medium disabled:opacity-50 transition-colors"
            style={{ backgroundColor: 'var(--brand)' }}
          >
            {analyzing ? 'Analyzing...' : 'Compare'}
          </button>
          <button
            onClick={handleClose}
            disabled={analyzing}
            className="flex-1 py-2 bg-slate-100 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-200 disabled:opacity-50"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
