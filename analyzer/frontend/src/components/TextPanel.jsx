import { useState, useRef, useEffect, useCallback } from 'react';
import useAnalyzerStore from '../store/useAnalyzerStore';
import AnalyzedText from './AnalyzedText';
import BatchComparisonPanel from './BatchComparisonPanel';

// Sanitize HTML: keep only structural formatting, strip colors/fonts
function sanitizeHtml(html) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Remove images, scripts, etc.
  doc.querySelectorAll('img, script, link, style, meta, svg, canvas, video, audio, iframe, object, embed').forEach(el => el.remove());

  // Use computed styles to determine actual formatting per text node
  // This handles inheritance correctly (parent bold + child normal = child is NOT bold)
  // We need to temporarily insert into DOM to compute styles
  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
  container.innerHTML = doc.body.innerHTML;
  document.body.appendChild(container);

  // Collect actual computed formatting per text node
  const textNodes = [];
  let boldCount = 0, totalCount = 0;
  let italicCount = 0;
  function collectText(node) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent.trim()) {
      const computed = window.getComputedStyle(node.parentElement);
      const isBold = parseInt(computed.fontWeight) >= 700;
      const isItalic = computed.fontStyle === 'italic';
      textNodes.push({ node, isBold, isItalic });
      totalCount++;
      if (isBold) boldCount++;
      if (isItalic) italicCount++;
    } else if (node.childNodes) {
      node.childNodes.forEach(collectText);
    }
  }
  collectText(container);
  document.body.removeChild(container);

  // Determine if ALL text is bold/italic (base style, not selective)
  const allBold = totalCount > 0 && boldCount === totalCount;
  const allItalic = totalCount > 0 && italicCount === totalCount;

  // Strip all attributes, then re-apply only selective formatting
  doc.querySelectorAll('*').forEach(el => {
    const tag = el.tagName.toLowerCase();
    const wasBoldTag = tag === 'b' || tag === 'strong';
    const wasItalicTag = tag === 'i' || tag === 'em';
    const wasBoldStyle = el.style?.fontWeight === 'bold' || parseInt(el.style?.fontWeight) >= 700;
    const wasItalicStyle = el.style?.fontStyle === 'italic';
    // Check if this element explicitly sets normal weight (overrides parent)
    const wasNormalWeight = el.style?.fontWeight === 'normal' || el.style?.fontWeight === '400';
    const wasNormalStyle = el.style?.fontStyle === 'normal';

    el.removeAttribute('style');
    el.removeAttribute('class');
    el.removeAttribute('color');
    el.removeAttribute('bgcolor');
    el.removeAttribute('face');
    el.removeAttribute('size');

    // Re-apply formatting: keep bold/italic tags, re-apply styles if selective
    if ((wasBoldStyle || wasBoldTag) && !allBold) el.style.fontWeight = 'bold';
    if (wasNormalWeight && !allBold) el.style.fontWeight = 'normal'; // preserve explicit overrides
    if ((wasItalicStyle || wasItalicTag) && !allItalic) el.style.fontStyle = 'italic';
    if (wasNormalStyle && !allItalic) el.style.fontStyle = 'normal';
  });

  // Unwrap <b>/<strong> or <i>/<em> tags if ALL text has that formatting
  if (allBold) {
    doc.querySelectorAll('b, strong').forEach(el => el.replaceWith(...el.childNodes));
  }
  if (allItalic) {
    doc.querySelectorAll('i, em').forEach(el => el.replaceWith(...el.childNodes));
  }

  return doc.body.innerHTML;
}

export default function TextPanel() {
  const {
    inputText, setInputText, inputHtml, setInputHtml,
    setUploadedFilename, setWordFormatting,
    selectedUnits, isAnalyzing, setAnalyzing, analysisResult, setAnalysisResult,
    analysisProgress, setAnalysisProgress,
    whatIfMode, sessionId, isReadOnly,
    compareMode, editingCompareId, compareTexts,
  } = useAnalyzerStore();

  const fileInputRef = useRef(null);
  const editorRef = useRef(null);
  const [showPdfWarning, setShowPdfWarning] = useState(false);
  const [pendingPdfFile, setPendingPdfFile] = useState(null);

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
    console.log('[PASTE] HTML:', html?.substring(0, 500));
    console.log('[PASTE] Text:', text?.substring(0, 200));
    if (html) {
      const sanitized = sanitizeHtml(html);
      console.log('[PASTE] Sanitized:', sanitized?.substring(0, 500));
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
      // innerText preserves line breaks from <br>, <p>, <div> as \n
      const newText = editorRef.current.innerText;
      const newHtml = editorRef.current.innerHTML;
      console.log('[PASTE] innerText has newlines:', newText.includes('\n'), 'length:', newText.length);
      lastSyncedText.current = newText;
      setInputText(newText);
      setInputHtml(newHtml);
    }
  }, [setInputText, setInputHtml]);

  const handleAnalyze = async () => {
    if (!inputText.trim() || selectedUnits.size === 0) return;

    setAnalyzing(true);
    setAnalysisProgress({ step: 'Starting', detail: 'Connecting...', percent: 0 });
    try {
      const res = await fetch('/api/analyzer/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: inputText.trim(),
          selectedUnits: Array.from(selectedUnits),
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(errText || `Server error ${res.status}`);
      }

      // Read SSE stream
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let resultData = null;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = buffer.split('\n');
        buffer = lines.pop(); // keep incomplete line in buffer

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const jsonStr = line.slice(6).trim();
          if (!jsonStr) continue;

          try {
            const event = JSON.parse(jsonStr);
            if (event.type === 'progress') {
              setAnalysisProgress({
                step: event.step,
                detail: event.detail,
                percent: event.percent,
              });
            } else if (event.type === 'result') {
              resultData = event.data;
            } else if (event.type === 'error') {
              throw new Error(event.error || 'Analysis failed on server');
            }
          } catch (parseErr) {
            if (parseErr.message.includes('Analysis failed')) throw parseErr;
            console.warn('SSE parse error:', parseErr, jsonStr.substring(0, 200));
          }
        }
      }

      if (!resultData) throw new Error('No analysis result received');

      setAnalysisResult(resultData);

      // Build formatting map from HTML
      if (inputHtml) {
        const { buildFormattingMap } = await import('../utils/formatMap');
        const fmtMap = buildFormattingMap(inputHtml, resultData.sentences);
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

    // Check if PDF — show formatting warning
    if (file.name.toLowerCase().endsWith('.pdf')) {
      setPendingPdfFile(file);
      setShowPdfWarning(true);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }

    await processFileUpload(file);
  };

  const processFileUpload = async (file) => {
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

  // Compare mode: show side-by-side columns
  if (compareMode) {
    return <BatchComparisonPanel />;
  }

  // Editing a compare text: show normal editor with banner
  if (editingCompareId) {
    const editIndex = compareTexts.findIndex(ct => ct.id === editingCompareId);
    const editLabel = editingCompareId === 'original' ? 'Current Text' : `Text ${editingCompareId.replace('compare-', '')}`;
    return (
      <div>
        <div className="mb-3 px-4 py-2 bg-blue-50 border border-blue-200 rounded-lg text-sm text-blue-800">
          Editing <strong>{editLabel}</strong> — changes will be saved when you return to comparison
        </div>
        <AnalyzedText />
      </div>
    );
  }

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
          className={`${isAnalyzing ? 'px-4 min-w-[220px]' : 'px-6'} py-2.5 text-white rounded-lg font-medium disabled:opacity-50 disabled:cursor-not-allowed transition-colors`}
          style={{ backgroundColor: 'var(--brand)' }}
          onMouseEnter={e => { if (!e.target.disabled) e.target.style.backgroundColor = 'var(--brand-dark)'; }}
          onMouseLeave={e => e.target.style.backgroundColor = 'var(--brand)'}
        >
          {isAnalyzing ? (
            <span className="flex items-center gap-2">
              <svg className="animate-spin h-4 w-4 flex-shrink-0" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="truncate max-w-[200px]">
                {analysisProgress
                  ? `${analysisProgress.detail || analysisProgress.step}${analysisProgress.percent ? ` (${analysisProgress.percent}%)` : ''}`
                  : 'Analyzing...'}
              </span>
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

      {/* PDF formatting warning dialog */}
      {showPdfWarning && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="bg-white rounded-xl shadow-2xl p-6 w-[28rem] space-y-4">
            <h3 className="text-lg font-bold text-slate-800">PDF Upload</h3>
            <p className="text-sm text-slate-600">
              PDF files do not preserve formatting (bold, italic). The text will be extracted as plain text only.
            </p>
            <p className="text-sm text-slate-500">
              If formatting is important, you can:
            </p>
            <ul className="text-sm text-slate-500 list-disc pl-5 space-y-1">
              <li>Upload a <strong>.docx</strong> file instead (preserves bold and italic)</li>
              <li><strong>Copy and paste</strong> directly from the PDF — your browser preserves formatting on paste</li>
            </ul>
            <div className="flex gap-2 pt-2">
              <button
                onClick={() => {
                  setShowPdfWarning(false);
                  if (pendingPdfFile) processFileUpload(pendingPdfFile);
                  setPendingPdfFile(null);
                }}
                className="flex-1 py-2 text-white rounded-lg text-sm font-medium"
                style={{ backgroundColor: 'var(--brand)' }}
              >
                Upload Anyway
              </button>
              <button
                onClick={() => {
                  setShowPdfWarning(false);
                  setPendingPdfFile(null);
                }}
                className="flex-1 py-2 bg-slate-100 text-slate-600 rounded-lg text-sm font-medium hover:bg-slate-200"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
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
