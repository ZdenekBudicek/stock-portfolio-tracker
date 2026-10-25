// Replay transport of the public demo: fixed, clearly synthetic answers to the demo questions, produced in the browser.
// No fetch, no Supabase project, no model, market or search API; each answer shows one capability of the real assistant
// in its real format (portfolio facts, a buy verdict, an article analysis, an outlook with scenarios, a web answer).
// Every figure and source here is invented; anything else is answered with an explanation of the demo mode.
import type { AgentEvent, ChatMessage, ChatRequest, Lang } from '../../supabase/functions/agent/core/protocol.ts';
import type { Thread, ThreadHistory } from '../../supabase/functions/agent/core/dataTypes.ts';
import type { AssistantTransport } from '@/lib/assistantTransport';
import { demoFacts, type DemoFacts, num, pct, usd } from './assistantFacts';
import { demoDb } from './mockBackend';

type UiLang = 'cs' | 'en';
/** One demo question; `text` writes the fixed answer, with the portfolio's figures read from the demo data. */
type Demo = { key: string; question: Record<UiLang, string>; trace: Record<UiLang, string[]>; text: (lang: UiLang, f: DemoFacts) => string };

/** The MSFT outlook's one valuation section: today's price, P/E against its history, analysts, the model, the scenarios —
 * every price once, as the real assistant writes it (owner, 2026-10-24). All figures are invented from the demo price. */
function msftValuation(l: UiLang, f: DemoFacts): string {
  const p = f.price('MSFT');
  const scen = [['Pesimistický', 'Bear', 0.78, 8, 34, 24], ['Základní', 'Base', 1.24, 14, 37, 30], ['Optimistický', 'Bull', 1.52, 18, 39, 34]] as const;
  const rows = scen.map(([c, e, k, g, m, pe]) => {
    const yearly = ((k) ** (1 / 2) - 1) * 100;
    return cs(l, `• **${c}:** ${usd(p * k, l)}, ročně ${pct(yearly, l)} (tržby ${pct(g, l, 0)} ročně, marže ${m}\u00a0%, P/E ${pe})`,
      `• **${e}:** ${usd(p * k, l)}, ${pct(yearly, l)} a year (revenue ${pct(g, l, 0)} a year, margin ${m}%, P/E ${pe})`);
  });
  return [cs(l, 'Ocenění a kde může být cena za 2 roky', 'Valuation and where the price could be in 2 years'),
    cs(l, `Akcie dnes stojí ${usd(p, l)}.`, `The share trades at ${usd(p, l)}.`),
    cs(l, 'P/E je 33 (pětiletý medián 32), tedy zhruba průměrně vůči vlastní historii.', 'The P/E is 33 (5-year median 32), about average against its own history.'),
    cs(l, `Analytici: 52 z 58 doporučuje koupit, 6 držet, 0 prodat; průměrný cíl na 12 měsíců je ${usd(p * 1.13, l)} (${usd(p * 0.85, l)} – ${usd(p * 1.4, l)}), tedy ${pct(13, l)}.`,
      `Analysts: 52 of 58 rate it buy, 6 hold, 0 sell; the mean 12-month target is ${usd(p * 1.13, l)} (${usd(p * 0.85, l)} – ${usd(p * 1.4, l)}), ${pct(13, l)}.`),
    cs(l, `Model férové hodnoty Trackory vychází na ${usd(p * 1.06, l)} (${pct(6, l)}), opatrněji než analytici.`,
      `The Trackora fair value model gives ${usd(p * 1.06, l)} (${pct(6, l)}), more cautious than analysts.`),
    cs(l, 'Dnešní cena počítá s růstem tržeb zhruba 15\u00a0% ročně v prvních dvou letech.', 'Today\'s price assumes revenue growth of about 15% a year for two years.'),
    cs(l, 'Scénáře vycházejí z tržeb a marže podle analytiků a z P/E odpovídajícího růstu, který firmě ještě zbývá:',
      'The scenarios use analysts\' revenue and margin and a P/E matching the growth still ahead:'),
    ...rows,
    cs(l, 'Jsou to modelové scénáře, ne předpověď ani doporučení.', 'These are model scenarios, not a forecast or advice.')].join('\n');
}

const NOTE: Record<UiLang, string> = {
  cs: 'Ukázková odpověď: data i zprávy jsou v demu smyšlené.',
  en: 'Demo answer: data and news are invented in the demo.',
};
const cs = (lang: UiLang, czech: string, english: string) => lang === 'en' ? english : czech;

/** The demo questions in the order the panel lists them, each with its fixed answer. */
export const DEMO_QUESTIONS: readonly Demo[] = [
  { key: 'today',
    question: { cs: 'Co se dnes děje s mými akciemi?', en: 'What is happening with my stocks today?' },
    trace: { cs: ['Pozice', 'Souhrn portfolia', 'Zprávy'], en: ['Holdings', 'Portfolio summary', 'News'] },
    text: (l, f) => {
      const { changePct, up, down } = f.today;
      const lines = [cs(l, `**Shrnutí:** Portfolio je dnes ${Math.abs(changePct) < 0.3 ? 'zhruba beze změny' : changePct > 0 ? 'v plusu' : 'v minusu'}, ${pct(changePct, l, 2)}.`,
        `**Summary:** The portfolio is ${Math.abs(changePct) < 0.3 ? 'roughly flat' : changePct > 0 ? 'up' : 'down'} today, ${pct(changePct, l, 2)}.`)];
      if (up) lines.push(cs(l, `• **Nejvíc roste ${up.ticker}, ${pct(up.pct, l, 2)}:** k pohybu najdeš ukázkové zprávy v detailu akcie.`,
        `• **${up.ticker} rises the most, ${pct(up.pct, l, 2)}:** sample news is in the stock detail.`));
      if (down && down.ticker !== up?.ticker) lines.push(cs(l, `• **Nejvíc klesá ${down.ticker}, ${pct(down.pct, l, 2)}:** pohyb je v rámci běžného kolísání posledních týdnů.`,
        `• **${down.ticker} falls the most, ${pct(down.pct, l, 2)}:** the move is within its usual swings of recent weeks.`));
      lines.push(cs(l, 'Zdroje: Trackora – pozice a dnešní ceny.', 'Sources: Trackora – holdings and today\'s prices.'));
      return lines.join('\n\n');
    } },
  { key: 'trades',
    question: { cs: 'Kolik jsem letos nakoupil a prodal?', en: 'How much did I buy and sell this year?' },
    trace: { cs: ['Obchody'], en: ['Trades'] },
    text: (l, f) => {
      const t = f.trades;
      return [cs(l, `Letos jsi nakoupil za **${usd(t.buyUsd, l)}** v ${t.buys} obchodech a prodal za **${usd(t.sellUsd, l)}** v ${t.sells} obchodech.`,
        `This year you bought **${usd(t.buyUsd, l)}** in ${t.buys} trades and sold **${usd(t.sellUsd, l)}** in ${t.sells} trades.`),
        ...(t.largest ? [cs(l, `Největší nákup: ${t.largest.ticker}, ${usd(t.largest.usd, l)}.`, `Largest purchase: ${t.largest.ticker}, ${usd(t.largest.usd, l)}.`)] : []),
        cs(l, 'Zdroje: Trackora – obchody.', 'Sources: Trackora – trades.')].join('\n\n');
    } },
  { key: 'realized',
    question: { cs: 'Jaký zisk jsem realizoval za poslední 2 roky?', en: 'What profit did I realize over the last 2 years?' },
    trace: { cs: ['Realizované výsledky'], en: ['Realized results'] },
    text: (l, f) => {
      const r = f.realized;
      return [cs(l, `Za posledních 24 měsíců jsi realizoval ${r.total >= 0 ? 'zisk' : 'ztrátu'} **${usd(Math.abs(r.total), l)}**.`,
        `Over the last 24 months you realized a ${r.total >= 0 ? 'profit' : 'loss'} of **${usd(Math.abs(r.total), l)}**.`),
        cs(l, `• letos: ${usd(r.thisYear, l)}\n• předtím: ${usd(r.lastYear, l)}`, `• this year: ${usd(r.thisYear, l)}\n• before: ${usd(r.lastYear, l)}`),
        cs(l, 'Prodeje se párují s nejstaršími nákupy (FIFO); je to před daní – daňový pohled je na stránce Daně.',
          'Sales are matched with the oldest purchases (FIFO); this is before tax – the Taxes page shows the tax view.'),
        cs(l, 'Zdroje: Trackora – realizované výsledky.', 'Sources: Trackora – realized results.')].join('\n\n');
    } },
  { key: 'buy',
    question: { cs: 'Vyplatí se teď koupit NVDA?', en: 'Is NVDA worth buying now?' },
    trace: { cs: ['Cena', 'Názor analytiků', 'Férová hodnota', 'Historie ocenění', 'Zprávy', 'Pozice'], en: ['Price', 'Analyst view', 'Fair value', 'Valuation history', 'News', 'Holdings'] },
    text: (l, f) => {
      const p = f.price('NVDA'), w = f.weight('NVDA');
      return [cs(l, `**Analytici**\nPrůměrná cílová cena je ${usd(p * 1.12, l)} (rozpětí ${usd(p * 0.82, l)} – ${usd(p * 1.42, l)}), 38 ze 44 analytiků doporučuje koupit.`,
        `**Analysts**\nThe average target is ${usd(p * 1.12, l)} (range ${usd(p * 0.82, l)} – ${usd(p * 1.42, l)}); 38 of 44 analysts rate it buy.`),
        cs(l, `**Ocenění**\nFérová hodnota z modelů Trackory je ${usd(p * 0.97, l)} při ceně ${usd(p, l)}. P/E je nad svým pětiletým mediánem.`,
          `**Valuation**\nTrackora's model fair value is ${usd(p * 0.97, l)} against a price of ${usd(p, l)}. The P/E is above its five-year median.`),
        cs(l, `**Rizika**\nNVDA tvoří ${pct(w, l, 1, false)} tvého portfolia; model je citlivý na předpoklad růstu.`,
          `**Risks**\nNVDA is ${pct(w, l, 1, false)} of your portfolio; the model is sensitive to the growth assumption.`),
        // The real assistant's own view (owner, 2026-10-25): a clear stance from the data, then the business, labelled as opinion.
        cs(l, `**Můj názor**\nZa současnou cenu to podle mě není výhodný nákup ani přepálená cena – je zhruba férová. Ve velkém bych nepřikupoval; dává smysl počkat na lepší cenu nebo přikupovat po menších částech. Byznys vypadá zdravě: v posledním vykázaném roce je ziskový (73 mld. USD) a vydělává hotovost (volný cash flow 61 mld. USD).${w >= 15 ? ' Pozice už je velká část tvého portfolia, takže bych další nákup zvažoval hlavně z pohledu rizika.' : ''}\nCena vůči ocenění: zhruba férová, bez výrazné slevy. Jistota: střední.\nCo by závěr změnilo: cena pod ${usd(p * 0.82, l)} nebo výrazně lepší výsledky.\nJe to můj názor z dostupných dat, ne investiční doporučení – rozhodnutí je na tobě.`,
          `**My view**\nAt the current price this is neither a bargain nor overpriced – it is about fair. I would not add a lot; waiting for a better price or adding in small steps makes sense. The business looks healthy: profitable in the latest reported year (USD 73B) and generating cash (free cash flow USD 61B).${w >= 15 ? ' The position is already a large part of your portfolio, so I would weigh another purchase mainly on risk.' : ''}\nPrice vs valuation: about fair, no real discount. Confidence: medium.\nWhat would change it: a price below ${usd(p * 0.82, l)} or clearly better results.\nThis is my view from the available data, not investment advice – the decision is yours.`)].join('\n\n');
    } },
  { key: 'move',
    question: { cs: 'Co se děje poslední dny s PLTR?', en: 'What is going on with PLTR lately?' },
    trace: { cs: ['Historie ceny', 'Podobné firmy', 'Zprávy', 'Výsledky hospodaření'], en: ['Price history', 'Peers', 'News', 'Earnings'] },
    text: (l, f) => {
      const m = f.move('PLTR', 5), up = (m?.pct ?? 0) >= 0;
      const happened = m ? cs(l, `**Co se stalo**\nZa posledních 5 obchodních dní se cena PLTR změnila o ${pct(m.pct, l)}, index S&P 500 o ${pct(m.spx, l)}.`,
        `**What happened**\nOver the last 5 trading days PLTR changed ${pct(m.pct, l)}, the S&P 500 ${pct(m.spx, l)}.`) : '';
      const reasons = up
        ? cs(l, '• **Nová vládní zakázka:** Firma získala víceletou zakázku na analýzu dat; investoři čekají stabilní příjmy.\n• **Vyšší výhled tržeb:** Vedení zvedlo celoroční výhled díky poptávce po AI platformě.',
          '• **New government contract:** The company won a multi-year data-analytics contract; investors expect steady revenue.\n• **Higher revenue outlook:** Management raised its full-year outlook on demand for its AI platform.')
        : cs(l, '• **Vybírání zisků:** Investoři po silném růstu prodávali dražší technologické akcie.\n• **Obavy z ocenění:** Analytici upozorňují, že akcie je drahá vůči tržbám.',
          '• **Profit-taking:** Investors sold pricier tech stocks after a strong run.\n• **Valuation worries:** Analysts point out the stock is expensive relative to sales.');
      return [cs(l, `**Shrnutí:** ${up ? 'Růst táhnou hlavně zprávy přímo o firmě.' : 'Pokles je spíš vybírání zisků po předchozím růstu.'}`,
        `**Summary:** ${up ? 'The rise is driven mainly by company news.' : 'The fall looks like profit-taking after an earlier run.'}`),
        happened, `${cs(l, '**Proč se to pravděpodobně děje**', '**Why it is likely happening**')}\n${reasons}`,
        cs(l, 'Jde o pravděpodobné důvody podle zpráv, ne o prokázané příčiny.', 'These are likely drivers based on the news, not proven causes.')].filter(Boolean).join('\n\n');
    } },
  { key: 'scenarios',
    question: { cs: 'Udělej mi analýzu MSFT: čím se zabývá, jak ji vidíš do budoucna a kde bude cena za 2 roky.',
      en: 'Analyse MSFT for me: what it does, how you see its future and where the price will be in 2 years.' },
    trace: { cs: ['Výkazy', 'Férová hodnota', 'Názor analytiků', 'Informace o firmě z webu', 'Zprávy'], en: ['Financials', 'Fair value', 'Analyst view', 'Company research', 'News'] },
    text: (l, f) => [
      cs(l, '**Shrnutí:** Microsoft roste hlavně díky cloudu Azure a AI v kancelářském softwaru. Ocenění je slušné, ne levné: další růst ceny stojí na tom, jestli se investice do AI promítnou do tržeb.',
        '**Summary:** Microsoft grows mainly on Azure cloud and AI in its office software. The valuation is fair, not cheap: further gains depend on AI spending turning into revenue.'),
      cs(l, 'O firmě\n• **Software a cloud:** Microsoft prodává Office, Windows a hlavně cloud Azure, ze kterého dnes plyne největší část růstu. Většina tržeb se opakuje každý rok.',
        'About the company\n• **Software and cloud:** Microsoft sells Office, Windows and above all the Azure cloud, which now brings most of the growth. Most revenue recurs every year.'),
      cs(l, 'Co může táhnout růst\n• **AI v Azure a Office:** Firmy platí za AI nástroje navíc, takže roste tržba na zákazníka.\n• **Výdaje firem na cloud:** Přesun firemních systémů do cloudu ještě zdaleka neskončil.',
        'What could drive growth\n• **AI in Azure and Office:** Companies pay extra for AI tools, lifting revenue per customer.\n• **Cloud spending:** Moving business systems to the cloud is far from over.'),
      cs(l, 'Slabiny a rizika\n• **Drahé investice do AI:** Datová centra stojí desítky miliard ročně; pokud se nevrátí, tlačí na marže.\n• **Regulace:** Úřady v USA i EU hlídají sílu firmy v cloudu a softwaru.',
        'Weaknesses and risks\n• **Costly AI investment:** Data centres cost tens of billions a year; if they do not pay back, margins suffer.\n• **Regulation:** US and EU regulators watch its power in cloud and software.'),
      msftValuation(l, f),
      cs(l, 'Jak to vidím\nMicrosoft má jednu z nejsilnějších pozic v technologiích a růst cloudu s AI je reálný. Cena už ale počítá s tím, že investice do AI vyjdou; základní scénář je proto rozumný, dobrý výsledek hlavně závisí na maržích.\nJe to úvaha nad zprávami a čísly výše, ne investiční doporučení.',
        'How I see it\nMicrosoft holds one of the strongest positions in tech and the cloud-plus-AI growth is real. The price already assumes AI spending pays off, so the base case is reasonable; a good outcome mostly depends on margins.\nThis is a reading of the news and figures above, not investment advice.'),
      cs(l, 'Na co se dívat\n• Příští výsledky hospodaření a tempo růstu Azure.\n• Kolik firem platí za AI nástroje v Office.',
        'What to watch\n• Next earnings and Azure growth.\n• How many companies pay for the AI tools in Office.'),
    ].join('\n\n') },
  { key: 'analysis',
    question: { cs: 'Co dělá ASML a jaké má silné a slabé stránky?', en: 'What does ASML do, and what are its strengths and weaknesses?' },
    trace: { cs: ['Informace o firmě z webu', 'Klíčové ukazatele', 'Zprávy'], en: ['Company research', 'Key metrics', 'News'] },
    text: l => cs(l,
      '**Shrnutí:** ASML je jediný výrobce nejpokročilejších litografických strojů na čipy; silná pozice, ale závislost na cyklu polovodičů.\n\nO firmě\n• **Stroje na výrobu čipů:** ASML vyrábí litografické systémy, bez kterých nejde vyrobit nejmodernější čipy.\n\nCo může táhnout růst\n• **Technologický náskok:** V nejpokročilejší litografii nemá ASML konkurenci, a výrobci čipů tak nemají alternativu.\n\nSlabiny a rizika\n• **Exportní omezení:** Vývozní pravidla omezují prodeje do Číny.\n• **Cyklus polovodičů:** Když výrobci čipů škrtají investice, objednávky strojů padají.\n\nJak to vidím\nDlouhodobě má ASML jednu z nejlepších pozic v technologiích. Krátkodobě bude kolísat s investicemi výrobců čipů a s politikou exportu.\nJe to úvaha nad zprávami a čísly výše, ne investiční doporučení.',
      '**Summary:** ASML is the only maker of the most advanced chip lithography machines; a strong position, but tied to the semiconductor cycle.\n\nAbout the company\n• **Chip-making machines:** ASML builds lithography systems without which the most advanced chips cannot be made.\n\nWhat could drive growth\n• **Technology lead:** ASML has no competitor in the most advanced lithography, so chipmakers have no alternative.\n\nWeaknesses and risks\n• **Export limits:** Export rules restrict sales to China.\n• **Chip cycle:** When chipmakers cut investment, machine orders fall.\n\nHow I see it\nLong term, ASML holds one of the best positions in tech. Short term it will swing with chipmakers\' spending and export policy.\nThis is a reading of the news and figures above, not investment advice.') },
  { key: 'web',
    question: { cs: 'Co znamená snížení sazeb Fedu pro akcie?', en: 'What does a Fed rate cut mean for stocks?' },
    trace: { cs: ['Vyhledávání na webu'], en: ['Web search'] },
    text: l => cs(l,
      '**Odpověď:** Nižší sazby akciím obvykle pomáhají, protože budoucí zisky mají dnes vyšší hodnotu a úvěry zlevní. Záleží ale na tom, proč Fed sazby snižuje – kvůli slábnoucí ekonomice mohou zisky firem naopak klesat.\n\nPodrobnosti\n• **Levnější peníze:** Nejvíc pomáhají nižší sazby růstovým a zadluženým firmám.\n• **Proč Fed snižuje:** Trhy rostou hlavně tehdy, když snížení přijde bez recese.',
      '**Answer:** Lower rates usually help stocks: future profits are worth more today and borrowing gets cheaper. It depends on why the Fed cuts, though – a cut for a weakening economy can come with falling profits.\n\nDetails\n• **Cheaper money:** Lower rates help growth and indebted companies most.\n• **Why the Fed cuts:** Markets rise mainly when a cut comes without a recession.') },
];

const UNKNOWN: Record<UiLang, string> = {
  cs: 'V demo verzi je chat vypnutý – asistent tu jen ukazuje, co umí, na předpřipravených otázkách. Vyber si některou z nabídky. S vlastním účtem odpovídá na cokoli o tvém portfoliu, akciích a investicích.',
  en: 'In the demo the chat is switched off – the assistant only shows what it can do on prepared questions. Pick one from the list. With your own account it answers anything about your portfolio, stocks and investing.',
};

const norm = (q: string) => q.normalize('NFC').trim().toLowerCase();
/** The demo answer for a question, matched exactly in either language. */
export function demoAnswer(question: string): Demo | undefined {
  const q = norm(question);
  return DEMO_QUESTIONS.find(d => norm(d.question.cs) === q || norm(d.question.en) === q);
}

const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const cancelled = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
  if (signal.aborted) return cancelled();
  const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); cancelled(); };
  signal.addEventListener('abort', onAbort, { once: true });
});

export function createReplayTransport(options: { delayMs?: number } = {}): AssistantTransport {
  const delay = options.delayMs ?? 350;
  const threads: (Thread & { messages: ChatMessage[] })[] = [];
  const answered = new Map<string, string>();
  let ids = 0;
  const id = () => `dddddddd-dddd-4ddd-8ddd-${String(++ids).padStart(12, '0')}`;
  const now = () => new Date().toISOString();
  let facts: DemoFacts | null = null;
  const factsOf = () => (facts ??= demoFacts(demoDb()));

  return {
    async *stream(input: ChatRequest, signal: AbortSignal): AsyncGenerator<AgentEvent> {
      const lang: UiLang = input.lang === 'en' ? 'en' : 'cs';
      const reply = demoAnswer(input.question);
      let thread = threads.find(t => t.id === input.threadId);
      if (!thread) { thread = { id: id(), title: input.question.slice(0, 120), updatedAt: now(), messages: [] }; threads.unshift(thread); }
      yield { type: 'meta', requestId: input.requestId, threadId: thread.id, remainingToday: null };
      yield { type: 'status', text: lang === 'en' ? 'Reading the sample data…' : 'Čtu ukázková data…' };
      await sleep(delay, signal);
      if (reply) yield { type: 'trace', items: reply.trace[lang].map(label => ({ label, state: 'ok' as const })) };
      await sleep(delay, signal);
      // A longer analysis takes the real assistant a moment longer to write.
      if (reply?.key === 'scenarios' && !answered.has(input.requestId)) {
        yield { type: 'status', text: lang === 'en' ? 'Writing the company analysis…' : 'Píšu rozbor firmy…' };
        await sleep(delay * 3, signal);
      }
      // A retry of the same request replays the same text, like the real service.
      const text = answered.get(input.requestId) ?? (reply ? `${reply.text(lang, factsOf())}\n\n${NOTE[lang]}` : UNKNOWN[lang]);
      if (!answered.has(input.requestId)) {
        answered.set(input.requestId, text);
        const seq = thread.messages.length;
        const msgLang: Lang = lang;
        thread.messages.push({ id: id(), requestId: input.requestId, seq: seq + 1, role: 'user', content: input.question, lang: msgLang, createdAt: now() },
          { id: id(), requestId: input.requestId, seq: seq + 2, role: 'assistant', content: text, lang: msgLang, createdAt: now() });
        thread.updatedAt = now();
      }
      yield { type: 'answer', text, links: [], verified: true };
      yield { type: 'done', requestId: input.requestId, persisted: true, outcome: 'ok' };
    },
    async threads() { return threads.map(({ id: tid, title, updatedAt }) => ({ id: tid, title, updatedAt })); },
    async history(threadId): Promise<ThreadHistory> {
      const thread = threads.find(t => t.id === threadId);
      if (!thread) throw new Error('Not found');
      return { thread: { id: thread.id, title: thread.title, updatedAt: thread.updatedAt }, messages: thread.messages.map(m => ({ ...m })) };
    },
    async remove(threadId) {
      const index = threads.findIndex(t => t.id === threadId);
      if (index >= 0) threads.splice(index, 1);
    },
  };
}
