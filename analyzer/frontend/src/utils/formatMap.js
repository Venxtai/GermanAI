/**
 * Build a formatting map from HTML and analysis result.
 * Maps each word token to its formatting (bold, italic).
 */
export function buildFormattingMap(html, sentences) {
  if (!html || !sentences) return {};

  // Parse HTML into a flat list of {char, bold, italic} segments
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  // Walk the DOM tree and extract text with formatting context
  const segments = []; // [{char, bold, italic}]
  function walk(node, bold, italic) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const ch of node.textContent) {
        segments.push({ char: ch, bold, italic });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const tag = node.tagName.toLowerCase();
      const isBold = bold || tag === 'b' || tag === 'strong' ||
        (node.style?.fontWeight && parseInt(node.style.fontWeight) >= 700) ||
        node.style?.fontWeight === 'bold';
      const isItalic = italic || tag === 'i' || tag === 'em' ||
        node.style?.fontStyle === 'italic';

      // Line breaks
      if (tag === 'br') segments.push({ char: '\n', bold: false, italic: false });
      if (tag === 'p' || tag === 'div') {
        if (segments.length > 0 && segments[segments.length - 1]?.char !== '\n') {
          segments.push({ char: '\n', bold: false, italic: false });
        }
      }

      for (const child of node.childNodes) {
        walk(child, isBold, isItalic);
      }

      if (tag === 'p' || tag === 'div') {
        if (segments.length > 0 && segments[segments.length - 1]?.char !== '\n') {
          segments.push({ char: '\n', bold: false, italic: false });
        }
      }
    }
  }
  walk(doc.body, false, false);

  // Build plain text from segments
  const plainFromHtml = segments.map(s => s.char).join('');

  // Now match words from analysis to segments by position
  const map = {};
  let htmlPos = 0;

  for (let si = 0; si < sentences.length; si++) {
    const sentence = sentences[si];
    for (let wi = 0; wi < sentence.words.length; wi++) {
      const word = sentence.words[wi];
      const searchText = word.text;

      if (word.type !== 'word') {
        // Skip whitespace/punctuation but advance htmlPos
        const foundAt = plainFromHtml.indexOf(searchText, htmlPos);
        if (foundAt >= 0 && foundAt < htmlPos + 20) {
          htmlPos = foundAt + searchText.length;
        }
        continue;
      }

      // Find this word in the HTML text
      const wordText = word.text;
      const foundAt = plainFromHtml.indexOf(wordText, htmlPos);
      if (foundAt >= 0 && foundAt < htmlPos + 50) {
        // Check formatting of characters in this word
        const wordSegments = segments.slice(foundAt, foundAt + wordText.length);
        const hasBold = wordSegments.some(s => s.bold);
        const hasItalic = wordSegments.some(s => s.italic);
        // Only store if there IS formatting (save space)
        if (hasBold || hasItalic) {
          map[`${si}_${wi}`] = { bold: hasBold, italic: hasItalic };
        }
        htmlPos = foundAt + wordText.length;
      }
    }
  }

  return map;
}

/**
 * Build formattedRanges array from wordFormatting + analysis sentences.
 * Each range: { start, end, bold, italic }
 * Used for PDF export where we need character offsets in the plain text.
 */
export function buildFormattedRanges(wordFormatting, sentences) {
  if (!wordFormatting || !sentences || Object.keys(wordFormatting).length === 0) return [];

  const ranges = [];
  let charOffset = 0;

  for (let si = 0; si < sentences.length; si++) {
    const sentence = sentences[si];
    if (sentence.paragraphBreak) charOffset++; // \n

    for (let wi = 0; wi < sentence.words.length; wi++) {
      const word = sentence.words[wi];
      const key = `${si}_${wi}`;
      const fmt = wordFormatting[key];

      if (fmt && word.type === 'word') {
        ranges.push({
          start: charOffset,
          end: charOffset + word.text.length,
          bold: fmt.bold || false,
          italic: fmt.italic || false,
        });
      }

      charOffset += word.text.length;
    }
    charOffset++; // space between sentences
  }

  return ranges;
}
