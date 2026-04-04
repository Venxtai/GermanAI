import { useRef, useEffect, useCallback } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';
import AnalyzedText from './AnalyzedText';

// Sanitize HTML: keep only structural formatting, strip colors/fonts
function sanitizeHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove images, scripts, etc.
  doc.querySelectorAll('img, script, link, style, meta, svg, canvas, video, audio, iframe, object, embed').forEach(el => el.remove());

  // Remove all style attributes except font-weight and font-style
  doc.querySelectorAll('*').forEach(el => {
    const bold = el.style?.fontWeight === 'bold' || parseInt(el.style?.fontWeight) >= 700;
    const italic = el.style?.fontStyle === 'italic';
    el.removeAttribute('style');
    el.removeAttribute('class');
    el.removeAttribute('color');
    el.removeAttribute('bgcolor');
    el.removeAttribute('face');
    el.removeAttribute('size');
    // Re-apply only formatting styles
    if (bold) el.style.fontWeight = 'bold';
    if (italic) el.style.fontStyle = 'italic';
  });

  return doc.body.innerHTML;
}

export default function TextPanel() {
  const {
    inputText, setInputText, inputHtml, setInputHtml,
    setUploadedFilename, setWordFormatting,
    selectedUnits, isAnalyzing, setAnalyzing, analysisResult, setAnalysisResult,
    whatIfMode, sessionId, isReadOnly,
  } = useAnalyzerStore();

  const fileInputRef = useRef(null);
  const editorRef = useRef(null);

  // Sync editor content when inputText changes externally (e.g., file upload, session restore)
  const lastSyncedText = useRef(inputText);
  useEffect(() => {
    if (editorRef.current && inputText !== lastSyncedText.current) {
      // If we have inputHtml and the text matches, use HTML; otherwise use plain text
      if (inputHtml && extractPlainText(inputHtml) === inputText) {
        editorRef.current.innerHTML = inputHtml;
      } else {
        editorRef.current.innerText = inputText;
      }
      lastSyncedText.current = inputText;
    }
  }, [inputText, inputHtml]);

  // On mount, populate editor with saved content
  useEffect(() => {
    if (editorRef.current && !analysisResult) {
      if (inputHtml) {
        editorRef.current.innerHTML = inputHtml;
      } else if (inputText) {
        editorRef.current.innerText = inputText;
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleInput = useCallback((e) => {
    const text = e.target.innerText;
    const html = e.target.innerHTML;
    lastSyncedText.current = text;
    setInputText(text);
    setInputHtml(html);
  }, [setInputText, setInputHtml]);

  const handlePaste = useCallback((e) => {
    e.preventDefault();
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    if (html) {
      const sanitized = sanitizeHtml(html);
      document.execCommand('insertHTML', false, sanitized);
    } else {
      // Decode HTML entities from plain text paste
      let decoded = text;
      if (/&#?\w+;/.test(text)) {
        const doc = new DOMParser().parseFromString(text, 'text/html');
        decoded = doc.body.textContent || text;
      }
      document.execCommand('insertText', false, decoded);
    }
    if (editorRef.current) {
      const newText = editorRef.current.innerText;
      const newHtml = editorRef.current.innerHTML;
      lastSyncedText.current = newText;
      setInputText(newText);
      setInputHtml(newHtml);
    }
  }, [setInputText, setInputHtml]);

  const handleAnalyze = async () => {
    if (!inputText.trim() || selectedUnits.size === 0) return;

    setAnalyzing(true);
    try {
      const res = await fetch('/api/analyzer/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: inputText.trim(),
          selectedUnits: Array.from(selectedUnits),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setAnalysisResult(data);

      // Build formatting map from HTML
      if (inputHtml) {
        const { buildFormattingMap } = await import('../utils/formatMap');
        const fmtMap = buildFormattingMap(inputHtml, data.sentences);
        setWordFormatting(fmtMap);
      }

      // Auto-upload original text as PDF to Google Drive (fire-and-forget)
      if (sessionId) {
        fetch('/api/analyzer/export', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: inputText.trim(), glossedWords: [], mode: 'student' }),
        })
          .then(r => r.arrayBuffer())
          .then(buf => {
            const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
            return fetch('/api/session/upload-original', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId, pdfBase64: base64, filename: `original_${sessionId}.pdf` }),
            });
          })
          .catch(err => console.warn('Original PDF upload failed:', err));
      }
    } catch (err) {
      console.error('Analysis failed:', err);
      alert('Analysis failed: ' + err.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const handleFileUpload = async (e) => {
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

      setInputText(data.text);
      setUploadedFilename(data.filename);

      // If the server returned HTML (from DOCX), store it
      if (data.html) {
        setInputHtml(data.html);
        if (editorRef.current) {
          editorRef.current.innerHTML = data.html;
          lastSyncedText.current = data.text;
        }
      } else {
        setInputHtml('');
        if (editorRef.current) {
          editorRef.current.innerText = data.text;
          lastSyncedText.current = data.text;
        }
      }
    } catch (err) {
      console.error('Upload failed:', err);
      alert('File upload failed: ' + err.message);
    }

    // Reset input so same file can be re-uploaded
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // Show analysis results if we have them (or in read-only mode)
  if (analysisResult && !whatIfMode) {
    return <AnalyzedText />;
  }

  // What If mode: show analyzed text with re-colored words
  if (analysisResult && whatIfMode) {
    return <AnalyzedText />;
  }

  // Read-only mode without analysis: show a message
  if (isReadOnly) {
    return (
      <div className="max-w-3xl mx-auto text-center py-12">
        <p className="text-slate-400 text-sm">This shared session has no analyzed text.</p>
      </div>
    );
  }

  // Input mode
  return (
    <div className="max-w-3xl mx-auto">
      <h2 className="text-lg font-semibold text-slate-700 mb-4">Enter or Upload Text</h2>

      <div
        ref={editorRef}
        contentEditable={!isReadOnly}
        onInput={handleInput}
        onPaste={handlePaste}
        data-placeholder="Paste your German text here..."
        className="analyzer-editor w-full h-64 p-4 border border-slate-300 rounded-xl resize-y focus:outline-none focus:ring-2 focus:border-transparent text-base leading-relaxed overflow-y-auto"
        style={{ '--tw-ring-color': 'var(--brand)', minHeight: '16rem' }}
        suppressContentEditableWarning
      />

      <div className="flex items-center gap-4 mt-4">
        <div className="flex items-center gap-2">
          <span className="text-sm text-slate-500">Or upload:</span>
          <input
            ref={fileInputRef}
            type="file"
            accept=".txt,.pdf,.docx"
            onChange={handleFileUpload}
            className="text-sm text-slate-500 file:mr-2 file:py-1.5 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-slate-100 file:text-slate-700 hover:file:bg-slate-200 file:cursor-pointer"
          />
        </div>

        <div className="flex-1" />

        <button
          onClick={handleAnalyze}
          disabled={isAnalyzing || !inputText.trim() || selectedUnits.size === 0}
          className="px-6 py-2.5 text-white rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          style={{ backgroundColor: 'var(--brand)' }}
          onMouseEnter={e => { if (!e.target.disabled) e.target.style.backgroundColor = 'var(--brand-dark)'; }}
          onMouseLeave={e => e.target.style.backgroundColor = 'var(--brand)'}
        >
          {isAnalyzing ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              Analyzing...
            </span>
          ) : (
            'Analyze'
          )}
        </button>
      </div>

      {selectedUnits.size === 0 && (
        <p className="mt-3 text-sm text-amber-600">
          Please select at least one unit from the left panel before analyzing.
        </p>
      )}
    </div>
  );
}

/**
 * Extract plain text from HTML string (used for comparison).
 */
function extractPlainText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.innerText || doc.body.textContent || '';
}
