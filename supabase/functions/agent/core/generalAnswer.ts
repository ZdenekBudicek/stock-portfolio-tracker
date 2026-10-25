import type { Lang } from './protocol.ts';
import { requestedText, tickersIn } from './router.ts';

// Authored explanations describe the shared calculations without personal evidence or an
// unredacted model request when the portfolio cannot be loaded.
const EXPLANATIONS: { topic: RegExp; text: Record<Lang, string> }[] = [
  { topic: /výnos|výkonnos|returns?|performance/iu, text: {
    cs: 'Trackora počítá výnos portfolia z časové řady jeho hodnoty a peněžních toků. Procentní výnos řetězí z denních výnosů s oddělením vkladů a výběrů; peněžní zisk je změna hodnoty po odečtení čistých vkladů. Přijaté dividendy nejsou nový vklad. Výsledek závisí na zvoleném období, měně a úplnosti historie včetně hotovosti. Při chybějících podkladech nemusí být výnos nebo srovnání s indexem dostupné.',
    sk: 'Trackora počíta výnos portfólia z časového radu jeho hodnoty a peňažných tokov. Percentuálny výnos reťazí z denných výnosov s oddelením vkladov a výberov; peňažný zisk je zmena hodnoty po odpočítaní čistých vkladov. Prijaté dividendy nie sú nový vklad. Výsledok závisí od zvoleného obdobia, meny a úplnosti histórie vrátane hotovosti. Pri chýbajúcich podkladoch nemusí byť výnos alebo porovnanie s indexom dostupné.',
    en: 'Trackora calculates portfolio returns from the history of portfolio values and cash flows. It chains daily percentage returns while separating deposits and withdrawals; monetary profit is the change in value minus net deposits. Received dividends are not new deposits. Results depend on the selected period, currency and completeness of the history, including cash. Missing inputs can make returns or index comparisons unavailable.',
  } },
  { topic: /férov\p{L}*\s+hodnot|fair value|valuac|valuation/iu, text: {
    cs: 'Trackora odhaduje férovou hodnotu kombinací dostupných metod podle typu firmy: například diskontovaných budoucích peněžních toků a srovnávacích násobků zisku. Použitelné metody váží podle typu firmy; metody bez potřebných údajů vynechá. Výsledek závisí na předpokladech růstu, diskontní sazbě a kvalitě vstupů. Je to modelový odhad, nikoli zaručená budoucí cena. V ocenění akcie si můžeš prohlédnout jednotlivé metody a citlivost na předpoklady.',
    sk: 'Trackora odhaduje férovú hodnotu kombináciou dostupných metód podľa typu firmy: napríklad diskontovaných budúcich peňažných tokov a porovnávacích násobkov zisku. Použiteľné metódy váži podľa typu firmy; metódy bez potrebných údajov vynechá. Výsledok závisí od predpokladov rastu, diskontnej sadzby a kvality vstupov. Je to modelový odhad, nie zaručená budúca cena. V ocenení akcie si môžeš pozrieť jednotlivé metódy a citlivosť na predpoklady.',
    en: 'Trackora estimates fair value by combining available methods according to the company type, such as discounted future cash flows and earnings multiples. It weights applicable methods by company type and excludes methods with missing inputs. The result depends on growth assumptions, the discount rate and input quality. It is a model estimate, not a guaranteed future price. In the stock valuation view you can inspect the methods and sensitivity to assumptions.',
  } },
  { topic: /diverzifik|diversification|alok[áa]c|allocation/iu, text: {
    cs: 'Diverzifikace znamená rozložení investic mezi různé firmy, sektory a druhy aktiv. Snižuje závislost na jediné investici, ale neodstraňuje riziko ztráty. Trackora ukazuje alokaci podle sektorů, druhů aktiv a měn kotace; sektorové podíly počítá z investované části bez hotovosti. Měna kotace sama neurčuje ekonomickou měnovou expozici firmy.',
    sk: 'Diverzifikácia znamená rozloženie investícií medzi rôzne firmy, sektory a druhy aktív. Znižuje závislosť od jednej investície, ale neodstraňuje riziko straty. Trackora ukazuje alokáciu podľa sektorov, druhov aktív a mien kotácie; sektorové podiely počíta z investovanej časti bez hotovosti. Mena kotácie sama neurčuje ekonomickú menovú expozíciu firmy.',
    en: 'Diversification spreads investments across companies, sectors and asset types. It reduces dependence on a single investment but does not eliminate losses. Trackora shows allocation by sector, asset type and quote currency; sector weights use invested assets excluding cash. Quote currency alone does not establish a company’s economic currency exposure.',
  } },
  { topic: /realizov|reali[sz]ed|FIFO/iu, text: {
    cs: 'Realizovaný výsledek vzniká při prodeji: porovnává příjem z prodeje s pořizovacími náklady prodaných kusů. Trackora páruje prodeje s nejstaršími nákupy. Nerealizovaný výsledek se týká stále držených pozic. Realizovaný zisk sám není daň; daňový výsledek závisí na rezidenci, osvobozeních a dostupných údajích.',
    sk: 'Realizovaný výsledok vzniká pri predaji: porovnáva príjem z predaja s obstarávacími nákladmi predaných kusov. Trackora páruje predaje s najstaršími nákupmi. Nerealizovaný výsledok sa týka stále držaných pozícií. Realizovaný zisk sám nie je daň; daňový výsledok závisí od rezidencie, oslobodení a dostupných údajov.',
    en: 'Realized profit or loss compares sale proceeds with the cost of the units sold. Trackora matches sales to the oldest purchases first. Unrealized profit or loss concerns positions still held. Realized profit is not itself tax; the tax result depends on residence, exemptions and available data.',
  } },
];

export function generalAnswer(question: string, lang: Lang): string | null {
  const text = requestedText(question);
  const method = /^\s*(?:jak|ako|how)\b.*(?:počít|calculat|estimat|funguj|work)/iu.test(text);
  if (!method && !/^\s*(?:co je|čo je|what is|what does|vysvětli|vysvetli|explain)\b/iu.test(text)) return null;
  // Personal results still need evidence, even when the question starts with "what is".
  if (!method && (tickersIn(text).some(t => t !== 'FIFO') || /(?<![\p{L}])(?:můj|moje|mého|moj|moja|môj|my)(?![\p{L}])/iu.test(text))) return null;
  return EXPLANATIONS.find(entry => entry.topic.test(text))?.text[lang] ?? null;
}

// When the model's explanation of a general investing question fails validation twice, the answer is still honest
// and on topic: a short authored explanation of a common concept (no figures), or a plain statement and a next step.
const GLOSSARY: { topic: RegExp; text: Record<Lang, string> }[] = [
  { topic: /(?<![\p{L}])etf\p{L}*|index\p{L}* fond|indexov\p{L}* fond|index fund/iu, text: {
    cs: 'ETF je fond obchodovaný na burze jako akcie. Většinou sleduje nějaký index nebo skupinu firem, takže jedním nákupem rozložíš peníze mezi mnoho investic. Hodnota ETF kolísá s trhem a výnos není zaručený; liší se i poplatky a to, co fond drží.',
    sk: 'ETF je fond obchodovaný na burze ako akcia. Väčšinou sleduje nejaký index alebo skupinu firiem, takže jedným nákupom rozložíš peniaze medzi veľa investícií. Hodnota ETF kolíše s trhom a výnos nie je zaručený; líšia sa aj poplatky a to, čo fond drží.',
    en: 'An ETF is a fund traded on an exchange like a stock. It usually tracks an index or a group of companies, so one purchase spreads your money across many investments. Its value moves with the market and returns are not guaranteed; fees and holdings differ between funds.',
  } },
  { topic: /stak\p{L}*/iu, text: {
    cs: 'Staking znamená, že své kryptoměny uzamkneš v síti, která je používá k potvrzování transakcí, a za to dostáváš odměny. Riziko nese hlavně cena samotné kryptoměny, uzamčení prostředků na určitou dobu a spolehlivost platformy, přes kterou stakuješ.',
    sk: 'Staking znamená, že svoje kryptomeny uzamkneš v sieti, ktorá ich používa na potvrdzovanie transakcií, a za to dostávaš odmeny. Riziko nesie hlavne cena samotnej kryptomeny, uzamknutie prostriedkov na určitý čas a spoľahlivosť platformy, cez ktorú stakuješ.',
    en: 'Staking means locking your crypto in a network that uses it to confirm transactions, and receiving rewards for it. The main risks are the price of the coin itself, funds being locked for a while and the reliability of the platform you stake through.',
  } },
  { topic: /krypt\p{L}*|crypto\p{L}*|bitcoin\p{L}*|ethereum\p{L}*|blockchain/iu, text: {
    cs: 'Kryptoměny jsou digitální aktiva vedená na blockchainu, bez centrální banky. Jejich cena hodně kolísá a stojí hlavně na poptávce, takže se hodí jen pro část portfolia, jejíž ztrátu uneseš.',
    sk: 'Kryptomeny sú digitálne aktíva vedené na blockchaine, bez centrálnej banky. Ich cena veľmi kolíše a stojí hlavne na dopyte, takže sa hodia len pre časť portfólia, ktorej stratu unesieš.',
    en: 'Cryptocurrencies are digital assets recorded on a blockchain, without a central bank. Their prices swing a lot and rest mainly on demand, so they suit only a part of a portfolio whose loss you could bear.',
  } },
  { topic: /dividend\p{L}*/iu, text: {
    cs: 'Dividenda je část zisku, kterou firma vyplácí akcionářům. Není zaručená, firma ji může snížit nebo zrušit, a obvykle se z ní platí daň.',
    sk: 'Dividenda je časť zisku, ktorú firma vypláca akcionárom. Nie je zaručená, firma ju môže znížiť alebo zrušiť, a zvyčajne sa z nej platí daň.',
    en: 'A dividend is a share of profit a company pays to its shareholders. It is not guaranteed, the company can cut or stop it, and it is usually taxed.',
  } },
  { topic: /dobr\p{L}* (?:doba|čas|chvíle|moment)|kdy investovat|kedy investovať|good time to invest|right time to invest|time the market/iu, text: {
    cs: 'Správný okamžik pro investici nikdo spolehlivě nepředpoví. Mnoho lidí proto investuje pravidelně menší částky a dlouhodobě, aby rozložili riziko nevhodného načasování. Důležité je investovat jen peníze, které nebudeš brzy potřebovat, a mít portfolio rozložené.',
    sk: 'Správny okamih na investíciu nikto spoľahlivo nepredpovie. Veľa ľudí preto investuje pravidelne menšie sumy a dlhodobo, aby rozložili riziko nevhodného načasovania. Dôležité je investovať len peniaze, ktoré nebudeš čoskoro potrebovať, a mať portfólio rozložené.',
    en: 'Nobody can reliably predict the right moment to invest. Many people invest smaller amounts regularly over the long term to spread the risk of bad timing. It matters to invest only money you will not need soon and to keep the portfolio diversified.',
  } },
  { topic: /(?<![\p{L}])akci[eíi]?\p{L}*|(?<![\p{L}])stocks?(?![\p{L}])|shares/iu, text: {
    cs: 'Akcie je podíl ve firmě. Její cena se mění podle výsledků firmy a nálady na trhu; vydělat můžeš na růstu ceny nebo na dividendách, ale můžeš o peníze i přijít.',
    sk: 'Akcia je podiel vo firme. Jej cena sa mení podľa výsledkov firmy a nálady na trhu; zarobiť môžeš na zvýšení ceny alebo na dividendách, ale môžeš o peniaze aj prísť.',
    en: 'A stock is a share in a company. Its price moves with the company\'s results and market sentiment; you can earn from price gains or dividends, but you can also lose money.',
  } },
];
const HONEST: Record<Lang, string> = {
  cs: 'Na tuhle obecnou otázku o investování ti teď nedokážu připravit spolehlivou odpověď. Zkus ji prosím položit znovu nebo konkrétněji – třeba s tickerem akcie či kryptoměny, a ukážu ti aktuální data z Trackory.',
  sk: 'Na túto všeobecnú otázku o investovaní ti teraz neviem pripraviť spoľahlivú odpoveď. Skús ju prosím položiť znova alebo konkrétnejšie – napríklad s tickerom akcie či kryptomeny, a ukážem ti aktuálne údaje z Trackory.',
  en: 'I cannot prepare a reliable answer to this general investing question right now. Please ask again or more specifically – for example with a stock or crypto ticker – and I will show you current Trackora data.',
};
/** The verified answer of a general question after two rejected explanations: authored, on topic, without figures. */
export function generalFallback(question: string, lang: Lang): string {
  return GLOSSARY.find(entry => entry.topic.test(question))?.text[lang] ?? HONEST[lang];
}
