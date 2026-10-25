import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { SafeMarkdown } from '@/lib/safeMarkdown';

const links = [{ url: 'https://www.reuters.com/markets/a', title: 'Reuters: výsledky' }];

describe('SafeMarkdown', () => {
  it('renders paragraphs, bullets and bold without HTML', () => {
    const { container } = render(<SafeMarkdown text={'Analytici\nCílová cena je **vyšší**.\n\n• první\n• druhá'} links={[]} />);
    expect(container.querySelectorAll('p').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('li')).toHaveLength(2);
    expect(container.querySelector('strong')?.textContent).toBe('vyšší');
  });

  it('never creates network elements from raw HTML, scripts or images', () => {
    const { container } = render(<SafeMarkdown text={'<img src="https://evil.example/x.png"> <script>alert(1)</script> ![a](https://evil.example/y.png) <iframe src="https://evil.example"></iframe>'} links={[]} />);
    expect(container.querySelector('img, script, iframe, video, audio, source, object, embed, link')).toBeNull();
    expect(container.textContent).toContain('<img');
  });

  it('links only verified URLs, with noopener noreferrer', () => {
    const { container } = render(<SafeMarkdown text={'[Zdroj](https://www.reuters.com/markets/a) [zlo](https://evil.example/?d=1) [js](javascript:alert(1)) https://evil.example/raw'} links={links} />);
    const anchors = [...container.querySelectorAll('a')];
    expect(anchors).toHaveLength(1);
    expect(anchors[0].getAttribute('href')).toBe('https://www.reuters.com/markets/a');
    expect(anchors[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(anchors[0].getAttribute('target')).toBe('_blank');
    expect(container.textContent).toContain('zlo');
    expect(container.innerHTML).not.toContain('href="https://evil');
    expect(container.innerHTML).not.toContain('javascript:');
  });

  it('does not trust a verified-looking link object with an unsafe scheme', () => {
    const { container } = render(<SafeMarkdown text={'[x](javascript:alert(1))'} links={[{ url: 'javascript:alert(1)', title: 'x' }]} />);
    expect(container.querySelector('a')).toBeNull();
  });
});
