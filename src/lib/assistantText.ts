// Chat text helpers shared by the assistant panel.

// The answer's closing block (the sources line, the "built from N articles" note, the demo note) is left out of the chat:
// each point already names its source, and the block made answers harder to read (user feedback, Běh 32).
const FOOTER = /^(?:Zdroje|Zdroj|Sources|Source)\s*:|^(?:Odpověď jsem složil z|Odpoveď som zložil z|This answer is built from|Ukázková odpověď:|Demo answer:)/i;
export function chatText(content: string): string {
  const parts = content.split(/\n{2,}/);
  while (parts.length > 1 && FOOTER.test(parts[parts.length - 1].trim())) parts.pop();
  return parts.join('\n\n');
}


/**
 * A section heading the server writes as a plain first line ("O firmě", "Ocenění a kde může být cena za 2 roky") is
 * shown bold, so a long answer reads as sections. A first line counts as a heading when more lines follow and it is
 * short, not a bullet, not already bold and not a sentence (no closing punctuation, no colon).
 */
export function withHeadings(text: string): string {
  return text.split(/\n{2,}/).map(block => {
    const [first, ...rest] = block.split('\n');
    const heading = rest.length > 0 && first.length <= 70 && !/^[•*\-\d]/.test(first.trim()) && !/[.:!?…)]$/.test(first.trim()) && !first.includes(':');
    return heading ? [`**${first.trim()}**`, ...rest].join('\n') : block;
  }).join('\n\n');
}
