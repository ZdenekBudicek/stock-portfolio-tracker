# Daně investora: USA, Slovensko, Německo, Velká Británie a Polsko

Rešerše ověřena 19. 10. 2026. Rozsah: fyzická osoba, celoroční daňový rezident, soukromé portfolio skutečných akcií, běžných ETF a spotových kryptoměn. Nejde o obchodní majetek ani CFD. Roky v API jsou **2024–2026**, v Británii označují **počáteční rok** období 6. dubna až 5. dubna dalšího roku.

Implementace je v `src/lib/tax/`. České moduly, jejich kurzy, FIFO a číselné výsledky se nemění. Nové země mají společné rozhraní `TaxEngine.report` / `TaxEngine.simulate`. Nejde o generátor celého osobního přiznání: mimoportfolio­vé příjmy, daňové volby, kvalifikaci instrumentů a doložené zápočty dodává volající. Výslovná omezení jsou níže; výstup je vždy **odhad**, nikoliv potvrzení způsobilosti k podání.

## Společná pravidla a měny

| Země | Období / měna | Identifikace nákladů | Přepočet pro přiznání |
|---|---|---|---|
| USA | Kalendářní rok / USD | FIFO po účtech, nebo doložená specific identification; wash sale napříč účty | V tomto API jsou již nákup, prodej i poplatky v USD |
| SK | Kalendářní rok / EUR | Prokazatelná pořizovací cena; engine volí FIFO po účtech | ECB/NBS, možnosti podle §31 pro neúčtující fyzickou osobu |
| DE | Kalendářní rok / EUR | Cenné papíry FIFO po depotu; krypto identifikace, přípustná zjednodušení po peněženkách | Náklady kurzem při pořízení, výnos kurzem při prodeji |
| GB | 6. 4.–5. 4. / GBP | Stejný den → následujících 30 dní → Section 104 pool | Historický kurz každé jednotlivé operace do GBP |
| PL | Kalendářní rok / PLN | Cenné papíry FIFO, nelze-li identifikovat, po účtu; krypto roční souhrn nákladů | Průměrný kurz NBP posledního pracovního dne **před** příslušnou operací |

Nesmí se přepočíst jen dolarový zisk kurzem v den prodeje. Například nákup 100 USD při 4 PLN/USD a prodej 100 USD při 5 PLN/USD znamená zisk 100 PLN, přestože USD zisk je nula. Německý [§20 odst. 4 EStG](https://www.gesetze-im-internet.de/estg/__20.html) výslovně rozlišuje okamžiky přepočtu. Britský [HMRC CG78310](https://www.gov.uk/hmrc-internal-manuals/capital-gains-manual/cg78310) požaduje samostatné sterlingové částky; konkrétní poskytovatel kurzů není předepsán, zdroj musí přiměřeně vystihovat kurz operace.

USA obecně nepředepisují jediný kurzový zdroj, požadují přiměřený kurz a konzistentní postup; roční průměr nenahrazuje automaticky kurz jednotlivého obchodu. Zde další převod nevzniká, protože vstup je USD. [IRS – směnné kurzy](https://www.irs.gov/individuals/international-taxpayers/yearly-average-currency-exchange-rates).

SK neúčtující poplatník může podle §31 použít kurz ECB/NBS při přijetí příjmu, měsíční průměr, roční průměr nebo průměr příslušných měsíčních průměrů. U výdajů se postup přiměřeně vztahuje na období vynaložení výdaje. [Finanční správa SR – přepočítací kurz](https://podpora.financnasprava.sk/682637-Prepo%C4%8D%C3%ADtac%C3%AD-kurz-da%C5%88ovn%C3%ADka-ktor%C3%BD-nie-je-%C3%BA%C4%8Dtovnou-jednotkou-).

Polské příjmy i náklady vyjádřené v cizí měně převádí čl. 11a zákona o PIT podle NBP předchozího pracovního dne. [Oficiální výklad čl. 11a](https://eureka.mf.gov.pl/informacje/podglad/574335), [NBP API a tabulky kurzů](https://api.nbp.pl/).

### ČNB v implementaci

Na výslovný požadavek zadání je výchozím evropským poskytovatelem ČNB: `USD/EUR = USD/CZK ÷ EUR/CZK`, obdobně GBP a PLN. Všechny části křížového kurzu pocházejí ze **stejného publikovaného dne**. Víkend/svátek uvnitř dat použije poslední publikaci, mezera přes šest dnů je odmítnuta. Za posledním záznamem se připustí pouze bezprostřední víkend; další pracovní den vrací chybějící kurz.

**ČNB není automaticky zákonný zdroj pro cizí daňové přiznání**, zejména SK a PL. Proto `fxMode: "cnb-estimate"` a varování `fx-estimate`. Pro místní výpočet lze dodat `FxProvider`, jenž již aplikuje zákonný den/metodu a vrací `statutory: true`. Samotné nastavení tohoto příznaku zákonnost neověřuje. FX metadata jsou auditní tvrzení poskytovatele.

`src/data/cnbRates.json` je připravený soubor pro USD/EUR/GBP/PLN. Stažení 19. 10. 2026 skončilo v sandboxu `fetch failed`, `connect EACCES 193.85.3.250:443`. Soubor proto obsahuje **prázdná data**, žádné vymyšlené kurzy. Původní `cnbUsdCzk.json` a API `usdCzkFor` nebyly změněny. Doplnění:

```sh
node scripts/update-cnb-rates.mjs --cross-only
# nebo pouze aktualizace od roku 2024, historie se zachová:
node scripts/update-cnb-rates.mjs 2024 --cross-only
```

Bez `--cross-only` skript aktualizuje také původní USD/CZK soubor. Stahování všech let a úplnost čtyř měn kontroluje před zápisem. Samostatný `parseCnbYear` stále vrací původní slovník USD sazeb. Nový parser umí opakované hlavičky a jiné množství měnových jednotek. Není-li stažen kurz nebo dodán vlastní poskytovatel, evropský report vrátí `estimatedTax: null`, nikoli nulu.

## USA – federální daň

### Zisky, ztráty a identifikace

Při držbě **déle než jeden rok** jde o long-term, při jednom roce a méně o short-term; pro běžný lot začíná držba dnem následujícím po pořízení. Přesné výročí není long-term. Neexistuje obecné osvobození dlouho držených akcií. ST a LT výsledky se nejprve sečtou zvlášť, potom vzájemně započtou. Čistou kapitálovou ztrátu lze uplatnit do běžného příjmu nejvýše 3 000 USD ročně, u married filing separately 1 500 USD; zbývající ztráta se přenáší s původním ST/LT charakterem. [IRS Topic 409](https://www.irs.gov/taxtopics/tc409).

Carryforward není jednoduše „ztráta minus 3 000“ u poplatníka bez dostatečného příjmu. Engine zachovává nevyužitý odpočet a spotřebovává nejprve ST ztrátu podle principu worksheetu Schedule D. Preferenční zisky se pokládají nad běžný zdanitelný příjem, včetně kvalifikovaných dividend; výsledná regular tax nepřekročí výpočet všeho běžnými sazbami. [Pokyny Schedule D, carryover a tax worksheets](https://www.irs.gov/instructions/i1040sd).

FIFO je fallback při nedoložené identifikaci. Specific ID vyžaduje včasný pokyn a potvrzení brokera; v API jej reprezentuje `lots` na prodeji. Wash sale u akcií/ETF: ztrátový prodej a nabytí podstatně totožného instrumentu včetně hranic **30 dní před / 30 dní po**. Zakázaná část ztráty navyšuje basis náhradních akcií a přenáší se doba držby. Párování je množstevní, v pořadí nákupů, přes všechny importované účty. Qualified dividend vyžaduje vhodného emitenta a zpravidla více než 60 dní držby v příslušném 121denním okně; u určitých preferenčních akcií platí delší test. [IRS Publication 550](https://www.irs.gov/publications/p550).

Engine rozděluje náhradní lot při částečném wash sale, přenáší basis i do následného prodeje a umí řetězení. Nákup v IRA může způsobit **trvalé** neuznání ztráty bez navýšení basis IRA; podporuje jej `accountType: "ira"`. [IRS Revenue Ruling 2008-5](https://www.irs.gov/pub/irs-drop/rr-08-05.pdf).

Spotové krypto má kapitálové ST/LT zacházení, výměna za jiný token může být realizací; nejde o obecně osvobozenou směnu. Engine na kategorii `crypto` neaplikuje §1091 určený pro stock/securities. Token s charakterem cenného papíru nesmí být automaticky zařazen jako běžné spotové krypto. Od roku 2025 je zvlášť důležitá evidence podle peněženek/účtů; historický přechod basis musí dodat import. [IRS – virtuální měny, basis a identifikace](https://www.irs.gov/individuals/international-taxpayers/frequently-asked-questions-on-virtual-currency-transactions).

### Sazby 2024–2026

LT sazby jsou 0 % do první hranice, 15 % do druhé, 20 % nad druhou. Jde o **celkový zdanitelný příjem se stackingem**, nikoli o velikost samotného prodeje. Kvalifikovaný surviving spouse používá společné sazby.

| Rok | Single: 0 / 15 % horní hranice | Married joint / surviving spouse | Married separate | Head of household |
|---|---:|---:|---:|---:|
| 2024 | 47 025 / 518 900 | 94 050 / 583 750 | 47 025 / 291 850 | 63 000 / 551 350 |
| 2025 | 48 350 / 533 400 | 96 700 / 600 050 | 48 350 / 300 000 | 64 750 / 566 700 |
| 2026 | 49 450 / 545 500 | 98 900 / 613 700 | 49 450 / 306 850 | 66 200 / 579 600 |

Běžné sazby ST a ordinary dividends: 10 / 12 / 22 / 24 / 32 / 35 / 37 %. Pole horních mezí pro prvních šest pásem, nad poslední mezí 37 %:

| Rok / status | Horní meze běžných pásem v USD |
|---|---|
| 2024 single | 11 600; 47 150; 100 525; 191 950; 243 725; 609 350 |
| 2024 joint | 23 200; 94 300; 201 050; 383 900; 487 450; 731 200 |
| 2024 separate | 11 600; 47 150; 100 525; 191 950; 243 725; 365 600 |
| 2024 head | 16 550; 63 100; 100 500; 191 950; 243 700; 609 350 |
| 2025 single | 11 925; 48 475; 103 350; 197 300; 250 525; 626 350 |
| 2025 joint | 23 850; 96 950; 206 700; 394 600; 501 050; 751 600 |
| 2025 separate | 11 925; 48 475; 103 350; 197 300; 250 525; 375 800 |
| 2025 head | 17 000; 64 850; 103 350; 197 300; 250 500; 626 350 |
| 2026 single | 12 400; 50 400; 105 700; 201 775; 256 225; 640 600 |
| 2026 joint | 24 800; 100 800; 211 400; 403 550; 512 450; 768 700 |
| 2026 separate | 12 400; 50 400; 105 700; 201 775; 256 225; 384 350 |
| 2026 head | 17 700; 67 450; 105 700; 201 750; 256 200; 640 600 |

Zdroje tabulek: [Rev. Proc. 2023-34, §3.01 a §3.03](https://www.irs.gov/pub/irs-drop/rp-23-34.pdf), [Rev. Proc. 2024-40, §2.01 a §2.03](https://www.irs.gov/pub/irs-drop/rp-24-40.pdf), [Rev. Proc. 2025-32, §4.01 a §4.03](https://www.irs.gov/pub/irs-drop/rp-25-32.pdf). Stejné tabulky jsou přímo v `usRates.ts` s odkazy. Engine nepoužívá sazby posledního známého roku pro neznámý rok.

NIIT je 3,8 % z menší z hodnot čistého investičního příjmu a přebytku MAGI nad 200 000 USD (single/head), 250 000 (joint/surviving spouse), 125 000 (separate). MAGI je samostatný vstup, **není** to taxable income po standard deduction. Report uvádí přírůstek NIIT oproti vstupnímu mimoportfolio­vému stavu. [IRS Topic 559](https://www.irs.gov/taxtopics/tc559).

### Dividendy, zápočet a potřebné vstupy

`qualified: true` znamená již ověřenou kvalifikaci, nikoli odhad podle tickeru. `false` znamená ordinary. Nezadaná kvalifikace blokuje výsledek. Zahraniční daň nelze mechanicky považovat za americký 15% kredit: formulář 1116 pracuje se zdrojem, kategoriemi, limitem a případnými přenosy. API přijímá ověřené `creditLimit` každé platby a celkové `foreignTaxCreditLimit` pro toto portfolio; kredit neodečítá od NIIT. Samo neřeší celý formulář 1116. [IRS Foreign Tax Credit](https://www.irs.gov/individuals/international-taxpayers/foreign-tax-credit).

Povinné vstupy profilu: filing status, běžný zdanitelný příjem mimo portfolio **po odpočtech**, mimoportfolio­vé MAGI a NII, ST/LT loss carry a kreditový limit. Záporný `otherOrdinaryTaxableIncome` vyjadřuje nevyužité odpočty. Vstupy nesmí obsahovat znovu dividendy/prodeje předané v reportu. Všechny ostatní kapitálové transakce musí být součástí ledgeru; samotný příjem ze zaměstnání je nenahrazuje.

Nepodporované: státní/místní daně, AMT, PFIC a zvláštní režimy zahraničních ETF, collectibles, §1256, opce/shorty/straddles, zaměstnanecké akcie, gifts/inheritance bez normalizované basis, automatické rozpoznání podstatné totožnosti a automatický výpočet FTC. Nutná je úplná evidence vlastních a relevantních manželských/IRA náhradních nákupů. Instrumenty těchto režimů se nesmějí vydávat za běžné `stock`/`etf` jen proto, že mají ticker.

## Slovensko

U cenného papíru přijatého na regulovaný nebo obdobný zahraniční regulovaný trh musí být **obě** doby, od nabytí i od přijetí na trh do prodeje, delší než rok. Podmínkou je soukromý majetek; ETF splňuje osvobození jen jako odpovídající cenný papír, nikoli automaticky označením ETF. U neosvobozených prodejů existuje osvobození čistého rozdílu příjmů a výdajů do 500 EUR, sdílené s příslušnými dalšími příjmy. Proto profil vyžaduje zbývající část, maximálně 500. Před rokem 2011 jsou přechodné režimy, které engine blokuje. [FS SR – osvobození prodeje cenných papírů](https://podpora.financnasprava.sk/798719-Oslobodenie-pr%C3%ADjmov-z-predaja-cenn%C3%BDch-papierov), [příklady příjmů](https://podpora.financnasprava.sk/575795-Pr%C3%ADjmy-fyzickej-osoby-z-predaja-cenn%C3%BDch-papierov).

Krypto se v běžném soukromém režimu zdaňuje podle §8, včetně výměny za jiné krypto, zboží nebo služby. Nemá zde roční časový test ani osvobození 500 EUR určené jiným kategoriím. Výdaje jsou uznatelné maximálně do příjmů příslušného druhu, daňová ztráta z §8 se nepřenáší do zaměstnání. Engine odděluje cenné papíry a krypto. Původně navrženou 7% sazbu po roce nelze přebírat do výpočtu roku 2024: rozhoduje skutečné znění po změnách. [ZDP ve znění pro rok 2024](https://www.financnasprava.sk/_img/pfsedit/Dokumenty_PFS/Zverejnovanie_dok/Sprievodca/Sprievodca_danami/2024/2024.01.10_DzP_595_2003.pdf), [FS SR – krypto u nepodnikatele](https://podpora.financnasprava.sk/293880-Pr%C3%ADjmy-z-predaja-kryproakt%C3%ADv--u-nepodnikate%C4%BEa-).

| Rok | Pásma §8 spolu s příslušným ostatním základem | Zdravotní pojistné, standardní sazba |
|---|---|---:|
| 2024 | 19 % do 47 537,98 EUR; dále 25 % | 15 % |
| 2025 | 19 % do 48 441,43 EUR; dále 25 % | 15 % |
| 2026 | 19 % do 43 983,32; 25 % do 60 349,21; 30 % do 75 010,32; dále 35 % | 16 % |

Zdroje: [údaje FS pro rok 2024](https://www.financnasprava.sk/_img/pfsedit/Dokumenty_PFS/Zverejnovanie_dok/Aktualne/DP/DPFO/2024/2024.08.14_016_FO_2024_IM.pdf), [sazby 2025](https://podpora.financnasprava.sk/353281-Sadzba-dane-z-pr%C3%ADjmov-fyzickej-osoby-za-rok-2025), [sazby 2026](https://podpora.financnasprava.sk/081400-Sadzba-dane-z-pr%C3%ADjmov-fyzickej-osoby-za-rok-2026), [VšZP – změna pojistného 2026](https://cms.vszp.sk/showdoc.do?docid=168&forceBrowserDetector=blind). Pojistné závisí na účasti v systému; u zdravotního postižení je poloviční. Osvobozené prodeje nejsou v tomto základu. `healthContributions` je samostatný odhad mimo `estimatedTax`. Skutečně zaplacené uznatelné pojistné lze předat jako `deductibleHealthContributions`; engine automaticky nevytváří dodatečné přiznání ani kruhový odpočet dosud nezaplaceného pojistného.

Korporátní dividendy ze zisků 2017–2023 mají 7 %, ze zisku 2024 10 %, ze zisků od 2025 opět 7 %. Rozhoduje období **vzniku zisku**, nikoliv datum výplaty. Pro nesmluvní stát existuje 35% režim; období 2004–2016 a starší mají jiná pravidla, mimo podporovaný vstup. [FS SR – dividendy od 2017](https://podpora.financnasprava.sk/476613-Podiely-na-zisku---zo-zisku-vyk%C3%A1zan%C3%A9ho-za-zda%C5%88ovacie-obdobie-za%C4%8D%C3%ADnaj%C3%BAce-najsk%C3%B4r-112017).

Distribuce fondu může patřit do kapitálového majetku §7 se samostatnou 19% sazbou a pojistným, nikoli do 7/10% dividendové kategorie. Volající musí určit `skCategory: corporate | fund | non-treaty` podle právní povahy plnění. Zápočet se omezuje skutečnou srážkou, dodaným smluvním limitem a slovenskou daní z dané položky. `creditLimit` musí reflektovat konkrétní smlouvu a stát, nikoli předpoklad 15 % pro všechny země.

Engine potřebuje ostatní zdanitelný základ, zbývající osvobození 500 EUR, zdravotní status a metadata trhu/dividend. FIFO je zvolená konvence pro doložitelnou evidenci, nikoli tvrzení, že zákon každému neúčtujícímu investorovi přikazuje právě FIFO. DIS, obchodní majetek, zvláštní odkupy podílových listů a staré akvizice nejsou automatizované.

## Německo

Akcie a běžné investiční fondy: samostatná kapitálová daň 25 %, Solidaritätszuschlag 5,5 % **z daně**, případně Kirchensteuer 8/9 %. Bez církevní daně tedy 26,375 %. S ní má základní kapitálová daň vzorec `(e − 4q) / (4 + k)`, kde `q` je uznatelný zahraniční kredit, `k` sazba církevní daně. Teprve k výsledku se přičte Soli a Kirchensteuer. Možnost Günstigerprüfung může vést k nižší osobní dani, engine ji neprovádí. [§32d EStG](https://www.gesetze-im-internet.de/estg/__32d.html).

Sparer-Pauschbetrag činí 1 000 EUR, při společném zdanění 2 000 EUR, ve všech třech letech. Freistellungsauftrag určuje uplatnění u banky, nevytváří další allowance. Profil uvádí část již spotřebovanou mimo toto portfolio. Ztráty z akcií lze započíst pouze proti ziskům z akcií, obecná kapitálová ztráta může snížit i další kapitálové příjmy; vznikají oddělené loss pots a přenosy. Křížové vyrovnání bank vyžaduje správné výpisy/certifikáty. [§20 odst. 6 a 9 EStG](https://www.gesetze-im-internet.de/estg/__20.html).

U soukromého držitele fondu se uplatní Teilfreistellung: akciový fond 30 %, smíšený 15 %, realitní 60 %, zahraniční realitní 80 %; jiný fond 0 %. Platí i pro příslušné ztráty a distribuce. Nestačí název ETF; rozhodují zákonné podmínky, například akciová kvóta. Při prodeji se před částečným osvobozením odečtou již zohledněné Vorabpauschalen, aby nebyly zdaněny znovu. [InvStG, zejména §§19–20](https://www.gesetze-im-internet.de/invstg_2018/BJNR173010016.html).

Vorabpauschale je roční domnělý výnos i bez prodeje: zjednodušeně kladná část omezeného Basisertrag po odečtení distribucí, s úpravou při pořízení během roku. Basisertrag vychází z počáteční hodnoty × 70 % základní sazby a je omezen skutečným přírůstkem hodnoty s distribucemi. Příjem nastává první pracovní den následujícího roku. [§18 InvStG](https://www.gesetze-im-internet.de/invstg_2018/__18.html). Například sazba pro výnos roku 2025 je 2,53 %, ale odpovídající příjem spadá až do 2. 1. 2026. [BMF – sazba 2025](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Investmentsteuer/2025-01-10-basiszins-vorabpauschale-zum-2-1-2025.pdf?__blob=publicationFile&v=2).

Z obchodního ledgeru nelze domnělé výnosy spolehlivě dopočítat bez NAV, distribucí, klasifikace fondu a historie. Proto se dodává `fundIncome` (již zjištěná hrubá částka, lokální měna, správný daňový den), `priorFundIncome` na nákupních lotech a potvrzení `fundDataComplete`. Chybějící potvrzení blokuje odhad, včetně pouhého držení ETF. Akcie před 2009 a fondy před 2018 vyžadují přechodnou basis/režim a jsou blokovány.

Soukromé spotové krypto patří typicky do §23. Držba nad rok je osvobozená. Při kratší držbě je celkový roční čistý zisk ze všech příslušných soukromých prodejů osvobozen, jen je-li **menší než 1 000 EUR** (od 2024). Přesně 1 000 EUR již podléhá osobnímu tarifu v celé výši; nejde o odpočet 1 000 EUR. Ztráty z této kategorie nelze odečítat od akciových dividend; mají vlastní přenos, zákon umožňuje i omezený carryback. [§23 EStG](https://www.gesetze-im-internet.de/estg/__23.html). FIFO je podporované zjednodušení s oddělením peněženek; směny mezi tokeny jsou realizacemi a následným nabytím. Staking/mining a zvláštní tokeny potřebují jinou analýzu. [BMF – krypto, pokyn 6. 3. 2025](https://www.bundesfinanzministerium.de/Content/DE/Downloads/BMF_Schreiben/Steuerarten/Einkommensteuer/2025-03-06-einzelfragen-kryptowerte.html).

Osobní tarif v kódu zahrnuje konečná pásma 2024, 2025 a 2026, německé zaokrouhlení základu/daně na celá EUR a splitting při společném zdanění. Základní nezdanitelné minimum je 11 784 / 12 096 / 12 348 EUR, sazby postupně rostou do 42 %, nad horní hranicí 45 %. [BMF – historie tarifů](https://www.bmf-steuerrechner.de/javax.faces.resource/2025_10_14_Tarifhistorie_Steuerrechner.pdf.xhtml), [§32a pro 2026](https://www.gesetze-im-internet.de/estg/__32a.html).

Soli pro osobní tarif má odlišnou nulovou zónu a náběh než daň z kapitálu. Implementace používá limity daně 18 130 / 19 950 / 20 350 EUR (dvojnásobek pro společné zdanění), sazbu 5,5 % s limitem náběhu 11,9 %. [§3 SolzG](https://www.gesetze-im-internet.de/solzg_1995/__3.html), [§4 SolzG](https://www.gesetze-im-internet.de/solzg_1995/__4.html). Dětské úlevy a zpětný dopad odpočtu církevní daně modelovány nejsou.

Potřebné vstupy: ostatní osobní základ, společné zdanění, církevní sazba, spotřebovaný Pauschbetrag, tři loss pots, ostatní čistý výsledek §23, klasifikace fondů a domnělé výnosy. Report zahrnuje `otherPrivateDisposalNet` do celého souhrnu §23 (včetně jeho daňového dopadu), aby hranice 1 000 EUR nebyla testována pouze nad jedním brokerem. Není to samostatný druhý odpočet.

## Velká Británie

S104 pool se vede za osobu pro stejnou třídu cenného papíru **napříč běžnými účty**. Nejprve se agregují všechny nákupy/prodeje téhož dne a použije se průměrná cena. Pak se prodej páruje s nákupy následujících 30 dní, při splnění rezidenčních podmínek; zbytek se bere z průměrného poolu. Předchozích 30 dní není americké wash-sale okno. Nejdříve se rezervují same-day nákupy všech dnů, aby je předchozí prodej nespotřeboval nesprávně. [HMRC HS284 (2026)](https://www.gov.uk/government/publications/shares-and-capital-gains-tax-hs284-self-assessment-helpsheet/hs284-shares-and-capital-gains-tax-2026). Stejná pravidla se vztahují na fungibilní tokeny, oddělený pool pro každý typ. [HMRC crypto pooling examples](https://www.gov.uk/hmrc-internal-manuals/cryptoassets-manual/crypto22250).

| Daňový rok | Annual Exempt Amount | Sazby běžného CGT akcie/krypto |
|---|---:|---|
| 2024/25 | 3 000 GBP | Do 29. 10. 2024: 10/20 %; od 30. 10.: 18/24 % |
| 2025/26 | 3 000 GBP | 18/24 % |
| 2026/27 | 3 000 GBP | 18/24 % |

Nižší sazba využívá zbytek basic-rate band po příslušném zdanitelném příjmu. U změny sazeb uprostřed 2024/25 lze úlevy rozdělit nejvýhodněji; engine alokuje ztráty/AEA nejprve na pozdější dražší zisky a nižší pásmo přednostně na staré 20→10% zisky. [HMRC – změna sazeb 30. 10. 2024](https://www.gov.uk/government/publications/changes-to-the-rates-of-capital-gains-tax/capital-gains-tax-rates-of-tax), [sazby a allowances](https://www.gov.uk/guidance/capital-gains-tax-rates-and-allowances).

Ztráty běžného roku se započtou před AEA. Dřívější uznané ztráty se čerpají pouze do zisku nad AEA; nevyužité zůstávají. Uznání ztráty je nutno oznámit v příslušné lhůtě, běžně čtyři roky od konce období. [HMRC – kapitálové ztráty](https://www.gov.uk/capital-gains-tax/losses).

Dividend allowance je 500 GBP ve všech třech letech, ale spotřebovává pásmo příjmu. Dividendové sazby 2024/25 a 2025/26 jsou 8,75 / 33,75 / 39,35 %; **od 2026/27 10,75 / 35,75 / 39,35 %**. Standardní basic-rate band je 37 700 GBP, personal allowance 12 570 GBP se u vyšších příjmů krátí. API přijímá již upravená pásma a nevyužitou personal allowance, aby neodhadovalo zaměstnání, pension/Gift Aid a taper. [HMRC – dividendové sazby](https://www.gov.uk/tax-on-dividends), [změna od dubna 2026](https://www.gov.uk/government/publications/changes-to-tax-rates-for-property-savings-dividend-income/changes-to-tax-rates-for-property-savings-dividend-income).

U offshore ETF je zásadní reporting status po celou dobu držby. Reporting fond může mít CGT při prodeji, ale i nevyplacený excess reportable income; ten se zdaní a upraví budoucí náklad. Non-reporting fond může mít offshore income gain zdaňovaný příjmovou daní, nikoliv běžným CGT. Dluhopisové fondy mohou distribuovat úrok. [HMRC HS265](https://www.gov.uk/government/publications/offshore-funds-self-assessment-helpsheet-hs265/hs265-offshore-funds). API podporuje CGT variantu, `fundIncome` pro dividendový ERI a již doložené úpravy basis; neznámý/non-reporting ETF blokuje odhad. Domácí fond lze označit jako `ukReportingFund: true` pouze pokud odpovídá podporovanému CGT/distribučnímu zacházení.

Kredit zahraniční srážky nemůže převýšit britskou daň z konkrétního zahraničního příjmu. Výpočet může vyžadovat alokaci úlev a pásem po příjmech. Engine používá poměrný odhad a dodaný strop každé platby, ne celý HS263 worksheet; výsledkem může být konzervativně nižší kredit. [HMRC HS263](https://www.gov.uk/government/publications/calculating-foreign-tax-credit-relief-on-income-hs263-self-assessment-helpsheet/relief-for-foreign-tax-paid-2026-hs263).

ISA/pension obchody se vyřadí jako `sheltered`, související dividendy se nepředávají. Zvláštní nový FIG režim od 6. 4. 2025, remittance basis předtím, změny rezidence, trusts a OIG nejsou modelovány; obecná rezidence sama nedokazuje nárok na výjimky. [HMRC HS266 – FIG](https://www.gov.uk/government/publications/foreign-income-and-gains-fig-regime-self-assessment-helpsheet-hs266/hs266-foreign-income-and-gains-fig-regime-2026).

## Polsko

Prodeje akcií a běžných fondových investic v tomto rozsahu mají 19% daň bez obecného časového osvobození nebo roční allowance. Od 2024 lze relevantní příjmy fondů a prodeje cenných papírů vyrovnávat v PIT-38. Pořizovací výdaje se u cenných papírů uplatní při prodeji; pokud nelze určit prodávanou pozici, FIFO odděleně podle účtu. Dividendové příjmy jsou odděleně zdaněny 19 % a kapitálová ztráta z prodeje je nesníží. [Polská finanční správa – prodej akcií](https://www.podatki.gov.pl/podatki-osobiste/pit/informacje-podstawowe/co-jest-opodatkowane/zbycie-akcji), [oficiální brožura PIT-38 2024](https://www.podatki.gov.pl/media/10281/broszura-do-pit-38-za-2024-r.pdf).

Ztráty cenných papírů lze uplatnit v následujících pěti letech: standardně nejvýše 50 % původní ztráty v jednom roce, nebo jednorázově do 5 mil. PLN a zbytek v mezích 50 %. Je třeba znát původní částku, zbytek, rok a využití jednorázové možnosti. Engine čerpá nejstarší platné ročníky a vrací jejich nový stav. [Polská finanční správa – odpočet ztráty](https://www.podatki.gov.pl/ulgi-i-odliczenia/odliczenie-straty-pit).

Krypto má rovněž 19 %, ale **jiný výpočet**: roční výnos z relevantních úplatných převodů minus všechny uznatelné přímé náklady daného roku a přenesené náklady. Nákup nespotřebovaného tokenu může být nákladem už letos. Převod krypto→krypto je daňově neutrální; obě jeho nohy musí mít `cryptoExchange: true`. Převod na fiat, zboží nebo službu je realizací. Přebytek nákladů se přenáší jako náklady, nikoliv jako běžná pětiletá ztráta; nesmí snížit zisk z akcií. [Polská finanční správa – krypto](https://podatki.gov.pl/podatki-osobiste/pit/informacje-podstawowe/co-jest-opodatkowane/zbycie-kryptowalut).

Solidarity levy je 4 % z příslušného souhrnného základu nad 1 mil. PLN a zahrnuje i relevantní krypto příjem podle čl. 30b. Dividendy podle čl. 30a do tohoto základu nespadají. Profil dodává `otherSolidarityBase`; engine vrací přírůstek levy. [Oficiální interpretace krypto a solidarity](https://eureka.mf.gov.pl/informacje/podglad/614612), [zákon PIT, čl. 30h](https://eli.gov.pl/api/acts/DU/2023/2805/text.html).

Zahraniční dividendová srážka je uznána nejvýše do skutečně zaplacené částky, ověřeného smluvního stropu a polské 19% daně z platby. Přebytek je případný nárok vůči státu zdroje, ne další polská vratka. Engine neřeší IKE/IKZE, specifické IPO osvobození, podnikání ani kompletaci všech příloh zahraničních příjmů.

## API pro UI

### Výběr enginu a validace profilu

```ts
import { taxEngineFor, parseTaxProfile, validateTaxProfile } from "@/lib/tax/engines";
import type { TaxInput, TaxTrade } from "@/lib/tax/engines";

const taxProfile = parseTaxProfile({
  version: 1, residence: "US", year: 2025, filingStatus: "single",
  otherOrdinaryTaxableIncome: 50000, otherMagi: 70000,
  otherNetInvestmentIncome: 0,
  shortTermLossCarry: 0, longTermLossCarry: 0, foreignTaxCreditLimit: 0,
});
const ledger: TaxTrade[] = [
  { id: "buy-1", ticker: "AAPL", side: "BUY", shares: 20, price_usd: 100,
    executed_at: "2023-06-01T15:00:00Z", taxDate: "2023-06-01", broker: "T212", broker_account: "1" },
  { id: "sell-1", ticker: "AAPL", side: "SELL", shares: 10, price_usd: 150,
    executed_at: "2025-06-02T15:00:00Z", taxDate: "2025-06-02", broker: "T212", broker_account: "1" },
];
const input: TaxInput = {
  profile: taxProfile, trades: ledger, dividends: [],
  instruments: { AAPL: { assetId: "US0378331005", kind: "stock" } },
  completeThrough: "2026-01-30",
};
const engine = taxEngineFor(taxProfile.residence);
const report = engine.report(input); // 500 USD LT gain, odhad regular tax 75 USD
const validation = validateTaxProfile(taxProfile); // success/data nebo error.issues
```

Profily jsou diskriminované podle `residence`, verzované a **roční**. `parseTaxProfile` vyhodí chybu; pro formulář použijte `validateTaxProfile` a cesty `error.issues`. Neexistuje automatické doplnění „single, příjem 0“ při chybějícím profilu. Částky jsou konečná čísla v měně jurisdikce, loss carry jsou nezáporné. Neznámá pole, NaN, neplatný rok/status, duplicitní ročníky polských ztrát a neplatné limity se odmítnou.

| Profil | Povinná pole vedle version/residence/year |
|---|---|
| US | `filingStatus`, `otherOrdinaryTaxableIncome`, `otherMagi`, `otherNetInvestmentIncome`, `shortTermLossCarry`, `longTermLossCarry`, `foreignTaxCreditLimit` |
| SK | `otherTaxableIncome`, `securitiesAllowanceRemaining`, `healthInsurance` (`standard/disabled/not-insured`), `deductibleHealthContributions` |
| DE | `otherTaxableIncome`, `jointAssessment`, `churchTaxRate` (0/.08/.09), `saverAllowanceUsed`, `stockLossCarry`, `generalLossCarry`, `privateLossCarry`, `otherPrivateDisposalNet` |
| GB | `otherTaxableIncome`, `unusedPersonalAllowance`, `basicRateBand`, `higherRateBandEnd`, `lossCarry`, `annualExemptAmount`, `dividendAllowanceRemaining` |
| PL | `otherSolidarityBase`, `cryptoCostCarry`, `securityLosses: { year, original, remaining, oneOffUsed }[]` |

DB migrace není součástí změny. Doporučené uložení je JSON profil po daňových letech s verzí; profil pro 2024 nesmí být při výběru 2025 přepsán pouze změnou `year`, protože příjmy a přenosy se mění. Čisté funkce nečtou DB, localStorage, síť ani systémové „dnes“.

### Smlouva pro obchodní data

- Vstupem jsou **celé nákupy a prodeje**, nikoli již spárované české `disposals`. Pouhé přeznačení českého FIFO by zničilo britský pool a americké wash sales.
- `TaxTrade` rozšiřuje `FifoTx` o povinný `taxDate: YYYY-MM-DD`, tedy skutečný místní daňový obchodní den. `executed_at` slouží k pořadí uvnitř dne. Import musí správně vyhodnotit časové pásmo a pravidla settlementu; API neřeže libovolný UTC timestamp a nevydává jej za místní daňový den.
- `instruments[ticker]` povinně obsahuje explicitní `kind: stock/etf/crypto` a stabilní `assetId`. Různé tickery stejné třídy akcie musí sdílet assetId. Různé instrumenty s podobným názvem jej sdílet nesmějí. US `washGroup` může sdružovat podstatně totožné instrumenty, které nemají totožné ID; kvalifikaci musí určit uživatel/import.
- `broker` a `broker_account` musí být skutečné identity. Převody mezi účty, corporate actions, splity, spin-offy a fúze musí mít právně správně rekonstruovanou historii/basis. Rozpoznané legacy `:split:`, `:merger:` a `:mergercash:` značky blokují nový report; český matcher jejich dosavadní zpracování zachovává.
- `accountType` je ve výchozím stavu `taxable`; `sheltered` se vynechá. `ira` je relevantní pro US náhradní nákupy, nikoliv pro běžné zdanění jeho prodejů. Dividendový vstup musí být již očištěn o platby chráněných účtů.
- US `lots: [{ buyId, shares }]` na SELL vyžaduje přesný součet prodaných kusů, platná ID, dostupné množství na stejném účtu. U ostatních zemí je tento vstup odmítnut, aby se neobcházela jejich metoda párování.
- `completeThrough` je tvrzení o úplnosti historie. Pro US je nutný 30. leden po konci roku, pro GB 5. květen po konci období; ostatní země potřebují konec roku. Neuzavřený rok má blokující `incomplete-ledger`, známé řádky lze přesto zobrazit. Úplnost neodvozujte z data posledního obchodu.
- `openLots` US ukazuje stav po zpracování **celého dodaného ledgeru**, včetně náhradních nákupů po konci roku; nejde o účetní snímek k 31. 12. UK `breakdown.poolShares:*` a `poolCost:*` jsou rovněž konečné pooly. SK/DE/PL nyní otevřené loty nevracejí, protože jejich report je realizovaný roční přehled.
- Pro DE/GB `priorFundIncome` vyjadřuje součet již zohledněných fondových příjmů připadajících na celý původní BUY lot, před částečným osvobozením, v EUR/GBP. Musí zahrnout částky relevantní pro danou dispozici. Při rozdílných úpravách pro části lotu je nutno lot při importu rozdělit. Není to částka na jednu akcii. `fundIncome.amount` je roční zdanitelný domnělý příjem v lokální měně. Nesmí být současně přidán podruhé jako vyplacená dividenda.

### Dividendy

Nový `TaxDividend` vyžaduje přesné `grossUsd`, `withholdingUsd`, daňový den a `creditLimit` v lokální měně. Existující `DividendRecord` nemá vždy hrubou částku, typ dividendy ani prokázanou srážku, proto se automaticky nepřebírá jeho český 15% gross-up. Importujte pouze zaznamenané platby (statement/API/manual), odstraňte duplicity a projekce. Při chybějícím gross/net rozlišení je třeba údaj doplnit; nepředávejte čistou dividendu jako hrubou. `qualified` je povinné pro US; `profitYear` a `skCategory` určují slovenský režim.

`creditLimit: 0` výslovně znamená bez uplatněného zahraničního kreditu. Limit musí odrážet konkrétní smlouvu a právně uznatelnou srážku. Nelze automaticky předpokládat jednotnou „EU srážku“: rezidence investora, stát emitenta, typ příjmu a právní forma fondu mění zacházení. Zaplacená domácí záloha/srážka není automaticky zahraniční kredit. Report počítá daňovou povinnost portfolia, nikoliv hotový nedoplatek po všech domácích zálohách.

### Výstup a simulace

`TaxReport` obsahuje období/měnu, prodejní řádky s `classification`, `gain`, `taxableGain`, `exemptGain`, `washDisallowed` a FX referencemi, dividendy, souhrnný `taxableBase`, `taxBeforeCredit`, `foreignTaxCredit`, `estimatedTax`, oddělené zdravotní pojistné, `carryforward`, `breakdown` a varování. Řádkové taxableGain se obecně **nerovná** ročnímu základu: až souhrn provádí netting, allowance a loss carry. U polského krypta je řádkový náklad/zisk záměrně `null`; základ se počítá z ročního cost poolu v breakdown. US odpočet proti běžnému příjmu je v `breakdown.capitalLossDeduction`; `taxableBase` udává kladnou kapitálovou/dividendovou složku před tímto odpočtem.

`estimatedTax` běžně vyjadřuje přírůstek daně způsobený portfoliem při dodaných ostatních příjmech (u německé §23 složky viz zahrnutí `otherPrivateDisposalNet` výše). Může být záporný při americké úspoře z kapitálové ztráty. Německý kredit mění také základ surcharges, takže prosté `taxBeforeCredit - foreignTaxCredit` nemusí odpovídat `estimatedTax`. `healthContributions` není zahrnuto v `estimatedTax`.

`complete: false` znamená blokující chybějící data; celkový základ/daň/pojistné jsou `null`, částečné řádky a breakdown zůstávají pro diagnostiku. Neúplné přenosy se **nesmějí automaticky uložit jako počáteční stav dalšího roku**. `complete: true` pouze potvrzuje dostatek vstupů v podporovaném rozsahu. Vždy zobrazte i `warnings` a `fxMode`; ČNB odhad může být datově úplný, ale není tím potvrzen místní zákonný kurz.

```ts
const simulation = engine.simulate(input, {
  trade: {
    id: "scenario-sale", ticker: "AAPL", side: "SELL", shares: 2, price_usd: 200,
    taxDate: "2025-12-01", executed_at: "2025-12-01T15:00:00Z",
    broker: "T212", broker_account: "1", fee_usd: 1,
  },
  // assumedFx: 0.92, // pouze evropská hypotetická prodejní USD→local sazba
});
// { before, after, taxDelta }; null delta při neúplnosti kteréhokoliv reportu
```

Simulace přepočítá celý rok před/po, nepoužije jen „sazba × nový zisk“. Nic neukládá. Vyžaduje unikátní ID, prodej v profilu zvoleného období, dostupnou historii a pokrytí `completeThrough` i pro scénář. Hypotetickou budoucnost a kurzy musí volající přiznat jako předpoklad; změna budoucích nákupů může změnit wash sale i britské párování. GBP assumedFx nesmí přepsat historické nákupní kurzy jiných dnů.

### Zapojení do stávající aplikace

`TaxResidence` a `normalizeResidence` nyní rozpoznávají CZ/US/SK/DE/GB/PL/OTHER. `SUPPORTED_TAX_RESIDENCES` je úplný seznam. **`TAX_RESIDENCES` zůstává CZ/OTHER**, protože jej již renderuje UI bez nových překladů/profilových formulářů. `jurisdictionFor(code).annualEngine` nabízí nové API. Staré `.engine` zůstává české rozhraní nebo `null`; tím se nemění existující volání.

Staré capability flags nových zemí zůstávají vypnuté: například `Taxes.tsx` podle `caps.taxEstimate` bez dalšího přepíná přímo na **český** report. Jejich zapnutí by tedy ukazovalo chybné české výpočty cizím rezidentům. Při implementaci UI připojte nové reporty, překlady a profily, teprve potom oddělte schopnosti enginu od připravenosti obrazovek a rozšiřte výběr rezidencí. Zobrazovací `BaseCurrency` zatím zůstává CZK/USD; daňová `TaxCurrency` je samostatná a určuje ji jurisdikce. DB migraci, UI a jejich zapnutí má podle zadání dokončit vlastník projektu.

## Ověření a další práce vlastníka projektu

Nové ručně spočítané testy pokrývají ST/LT hranici, částečné/předcházející/přeshraniční/řetězené wash sales, IRA, specific ID, poplatky, netting, 3 000/1 500 USD, nulová a 15/20% pásma, běžná pásma, NIIT, qualified dividends; UK pool/same-day/30-day, změnu sazby a dividend 2026; slovenské časové podmínky, pásma a pojistné; německé loss pots/Teilfreistellung/církevní daň/crypto hranici; polské roční crypto náklady, expiraci ztrát, solidarity a oddělené dividendy. Testovány jsou i nulové/chybějící kurzy, historický přepočet každé strany, parser ČNB, validace a neměnnost vstupů.

V dosavadním testu rezidencí byla nutná jedna změna očekávání: DE již není neznámá země, tuto roli nyní testuje FR. České číselné testy nebyly měněny.

Kontrolní příkazy (v tomto PowerShellu je nutný přímo `.cmd`, protože execution policy blokuje `npx.ps1`):

```sh
npx.cmd tsc --noEmit -p tsconfig.app.json
npx.cmd vitest run
```

Vlastník projektu musí stáhnout nové ČNB kurzy uvedeným příkazem (nebo dodat místní FX provider), připravit DB profilů po letech a nové UI. Import musí dodat právní klasifikace a kompletní data včetně návazných nákupů, fondových výnosů, skutečných srážek a předchozích ztrát. Automatické získávání NAV/Vorabpauschale/ERI, celé osobní přiznání, korporátní akce jednotlivých zemí a speciální režimy nejsou součástí této změny.
