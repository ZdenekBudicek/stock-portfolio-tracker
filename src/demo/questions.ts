// The public demo's prepared questions, text only: the app's panel lists them without loading the replayed answers
// and the invented data behind them (src/demo/assistantReplay.ts, loaded only in the demo build).
export type DemoQuestionKey = 'today' | 'trades' | 'realized' | 'buy' | 'move' | 'scenarios' | 'analysis' | 'web';

export const DEMO_QUESTION_TEXT: Readonly<Record<DemoQuestionKey, { cs: string; en: string }>> = {
  today: { cs: 'Co se dnes děje s mými akciemi?', en: 'What is happening with my stocks today?' },
  trades: { cs: 'Kolik jsem letos nakoupil a prodal?', en: 'How much did I buy and sell this year?' },
  realized: { cs: 'Jaký zisk jsem realizoval za poslední 2 roky?', en: 'What profit did I realize over the last 2 years?' },
  buy: { cs: 'Vyplatí se teď koupit NVDA?', en: 'Is NVDA worth buying now?' },
  move: { cs: 'Co se děje poslední dny s PLTR?', en: 'What is going on with PLTR lately?' },
  scenarios: { cs: 'Udělej mi analýzu MSFT: čím se zabývá, jak ji vidíš do budoucna a kde bude cena za 2 roky.',
    en: 'Analyse MSFT for me: what it does, how you see its future and where the price will be in 2 years.' },
  analysis: { cs: 'Co dělá ASML a jaké má silné a slabé stránky?', en: 'What does ASML do, and what are its strengths and weaknesses?' },
  web: { cs: 'Co znamená snížení sazeb Fedu pro akcie?', en: 'What does a Fed rate cut mean for stocks?' },
};

/** The questions in the order the panel lists them. */
export const demoQuestions = (lang: 'cs' | 'en') => Object.values(DEMO_QUESTION_TEXT).map(q => q[lang]);
