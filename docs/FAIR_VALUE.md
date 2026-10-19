# Férová hodnota – metodika úkolu G

Kalibrace používá výhradně dodaný snapshot `src/__tests__/fixtures/fair-value-companies.json` z 18. 10. 2026. Ceny v tabulce nejsou nově načtené kotace. Výsledky jsou výchozí modelové odhady, nikoli cílové ceny analytiků. Implementace je v `src/lib/fairValue.ts`, integrace historie a ovládání v `src/components/fundamentals/FairValue.tsx`.

## Proč původní výchozí výsledky selhávaly

Původní kalkulačka počítala medián všech číselných metod. Neodlišovala vhodnost modelu od toho, zda jde vzorec numericky vyhodnotit. Současně započítávala běžné a růstové P/E jako dvě samostatné metody, všem firmám dávala P/E 15 a používala poslední FCF bez ohledu na investiční cyklus.

- **GOOGL:** V uživatelském příkladu dividendový model 11,44 USD a Graham 152,68 USD stáhly medián na 152,68 USD. Malá dividenda nevystihuje zisk, odkupy a reinvestice firmy; účetní kapitál nevystihuje hodnotu jejího nehmotného podnikání. Nad přiloženým snapshotem a původním kódem reprodukujeme stejný medián a rezervu −123,08 %, ale jiné dílčí DCF/P/E: 102,25 / 298,65 / 334,30 USD. Čísla DCF 137,89 a P/E 428 / 479 ze zadání tedy nepředstíráme jako přesnou reprodukci stejného nastavení. Výsledný problém je shodný. Investice rostou rychleji než tržby a poslední FCF nedává samo o sobě reprezentativní výchozí základ.
- **AAPL:** Staré výchozí ocenění 88,85 USD při ceně 343,46 USD; nízký účetní kapitál po odkupech a malá dividenda poskytují další nízká čísla, pevné P/E 15 ignoruje vlastní historii. Zobrazená „rezerva“ byla −286,58 %.
- **JPM, SOFI, NU:** Provozní cash flow může odrážet pohyb úvěrů a klientských zůstatků. Záporné FCF neznamená automaticky zápornou ekonomickou hodnotu banky; ani kladné FCF by nebylo oprávněním použít běžný průmyslový DCF. JPM dříve vyšlo přibližně 310,16 USD, ale náhodně vhodné výsledné číslo neospravedlňuje nevhodné složení metod.
- **INTC:** Původní souhrn byl 4,99 USD pouze z kladného posledního FCF, přestože firma vykazuje TTM účetní ztrátu. Jednoduchý růstový model nemá scénář ozdravení. Nově jsou EPS/FCF metody zablokované a zbývá výslovně relativní P/S.
- **O (Realty Income):** Chybí capex, vykázané FCF se rovná provoznímu CF a distribuce převyšují EPS. Medián 36,06 USD směšoval modely, které pro profil podobný REIT potřebují další údaje. Bez AFFO/NAV nevracíme souhrnné číslo.

Výraz `1 − cena / hodnota` je matematicky správná definice margin of safety, ale při ceně nad hodnotou není ztrátovým potenciálem a může klesnout libovolně pod −100 %. Chyba tedy byla v prezentaci a významu ukazatele, nikoli v aritmetice dělení.

## Profesionální přístupy a hranice automatizace

U běžné ziskové firmy analytik modeluje peněžní toky, reinvestice a postupný přechod k udržitelnému růstu. Toky pro akcionáře diskontuje náklady vlastního kapitálu; toky pro celou firmu WACC a následně přechází od hodnoty podniku k vlastnímu kapitálu. Dividendový model je zvláštní případ oceňování vlastního kapitálu, vhodný při reprezentativních výplatách. Srovnávací násobky jsou kontrolou předpokladů, nikoli zárukou vnitřní hodnoty. Viz [Damodaran: Valuation](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/val.html).

U bank je vhodnější oceňování vlastního kapitálu, dividend, přebytečných výnosů či kapitálu nutného k růstu. P/E a P/B dávají smysl společně s ROE a rizikem; běžný FCF a podnikový dluh mají u finančních firem jiný význam. Viz [Damodaran: Financial service company characteristics](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/littlebook/financialsvccompanies.htm) a [Valuing Financial Service Firms](https://pages.stern.nyu.edu/~adamodar/pdfiles/papers/finfirm09.pdf).

U cyklických firem se normalizují zisky či marže přes cyklus. U mladé ztrátové firmy je třeba explicitně modelovat přechod k rentabilitě, reinvestice a financování; historické P/S zde zůstává pouze relativním srovnáním. Automatické převzetí kladného roku by takový scénář nenahradilo. Viz [Damodaran: Normalizing earnings](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/valquestions/normearn.htm) a [Valuation, části o cyklických a problémových firmách](https://pages.stern.nyu.edu/~adamodar/New_Home_Page/lectures/val.html).

Níže uvedené váhy, prahy a sazby jsou naše transparentní implementační volba pro dostupná data, nikoli tvrzení o jednotném profesionálním standardu. Čtyři roční výkazy nestačí na úplnou analýzu cyklu. Kalkulačka proto nepřevádí ztráty automaticky na historický kladný zisk a nenutí modelovou hodnotu kopírovat cenu.

## Výběr profilu a metod

Datový typ neobsahuje sektor ani ověřený druh podnikání. Klasifikace nepoužívá ticker ani skupinu z fixtures. Používá tyto znaky v daném pořadí:

1. **Ztráta:** EPS nebo čistý zisk za TTM / poslední rok je nekladný. DCF, P/FCF, P/E, růstové P/E a Graham jsou nepoužitelné. P/S smí být souhrnem jen s dostatečnou vlastní historií a s označením „Relativní ocenění · historické P/S“.
2. **Finanční profil:** Kladné tržby a kapitál, dostupný čistý zisk a současná absence gross profit, cost of revenue i operating income; alternativně provozní CF nad trojnásobkem kladného čistého zisku při dluhu převyšujícím kapitál. První větev zachytí bankovní strukturu výkazů, druhá konzervativně zachytí také smíšené podnikání MELI. Obě blokují DCF, P/FCF, reverzní DCF i citlivost. Jde o heuristiku: vysoká konverze zisku sama nedokazuje úvěrové podnikání a chybějící členění může být i vadou dat. UI proto uvádí „profil podle výkazů“, nikoli potvrzený sektor.
3. **Majetkový příjmový profil:** Nefinanční firma s dividendami nad 120 % EPS a bez údaje capex. Bez AFFO / hodnoty aktiv zůstává souhrn nedostupný s konkrétním důvodem.
4. **Dividendový profil:** Výplatní poměr dividendy na akcii / EPS v rozsahu 25–100 % a dividendový výnos alespoň 1,5 %. Chybějící cena neumožní ověřit výnos; dividendový model se v takovém případě nepoužije. Dividendy jsou ve zdroji záporným peněžním tokem, kladný příjem se nepřevádí na výplatu.
5. **Stabilní hodnotový profil:** Alespoň tři dostupné kladné roční EPS z posledních čtyř, poměr nejvyššího a nejnižšího pod 3, historický růst nejvýše 6 %, kladný kapitál, dostupné kladné tržby, vykázané R&D pod 5 % tržeb a výchozí P/E nejvýše 18. Chybějící R&D zde znamená absenci doložené vysoké výzkumné náročnosti, ne důkaz nulových výdajů. Graham se může započítat jen v tomto profilu.
6. **Růstový profil:** Historický růst nad 8 %. Ostatní firmy spadají do ostatního ziskového / pomalu rostoucího profilu.

| Profil | Výchozí váhy |
| --- | --- |
| Růstový | DCF 30 %, P/E 40 %, růstové P/E 10 %, P/FCF 20 % |
| Ostatní ziskový | DCF 30 %, P/E 50 %, P/FCF 20 % |
| Dividendový | DCF 20 %, P/E 45 %, P/FCF 25 %, dividendový model 10 % |
| Stabilní hodnotový | DCF 20 %, P/E 45 %, P/FCF 20 %, Graham 15 % |
| Finanční | P/E 75 %, P/B 25 % |
| Ztrátový s historií | P/S 100 %, výslovně relativní ocenění |
| Majetkový příjmový bez AFFO/NAV | Žádná metoda v souhrnu |

Souhrn je součet `hodnota metody × normalizovaná váha`. Neplatná či nekladná hodnota má váhu nula; zbývající původní váhy se poměrně normalizují na 100 %. Metody mimo profil se při výpadku jiné metody nepřidávají. Dvě varianty P/E sdílejí u růstových firem nejvýše polovinu původní alokace. DCF a P/FCF také nejsou nezávislé. Nízká váha dividend brání vydávání dílčí výplaty za celé ekonomické možnosti firmy. Graham zůstává u technologických firem pouze srovnávacím číslem. UI ukazuje skutečné váhy po normalizaci, popis profilu i „jen pro srovnání“.

## Historické násobky, růst a FCF

Historie pochází z existujícího `usePriceHistory(symbol)`, sdílí jeho query cache a předává se i do kalkulace při ručních změnách. `valuationSeries` zachovává splitovou úpravu akcií a publikační zpoždění 90 dní pro roční / 45 dní pro čtvrtletní výkazy. `medianOf` zpracuje posledních pět kalendářních let vůči `fundamentals.fetchedAt`, nikoli vůči hodinám počítače. Budoucí ceny, neplatné kotace a duplicitní datum se vyřadí. Je třeba alespoň 26 různých kladných pozorování násobku pokrývajících nejméně 365 dní. Nejde o pět let vymyšlených výkazů: fixtures mají typicky jen asi 3–4 roky skutečně použitelných násobků, i když cen je deset let. UI ukazuje počet, rozsah i původní medián.

| Předpoklad | Pravidlo |
| --- | --- |
| P/E | Vlastní medián, omezený na 8–45. Bez historie 15 pro finanční profil, 22 při růstu nad 8 %, jinak 18. |
| P/FCF | Vlastní medián, omezený na 8–50. Bez historie 25 při utlumeném růstu nad 6 %, jinak 18. |
| P/S | Vlastní medián, omezený na 0,3–12. Náhradní 2 je jen pracovní srovnání; u ztrátové firmy neumožňuje souhrn. |
| P/B | `(ROE − 0,025) / (diskont − 0,025)`, omezené na 0,5–4; ROE = EPS × akcie / poslední kapitál. Bez ROE pracovní násobek 1. Není vydáván za vlastní historické P/B. |
| Růst FCF a EPS | 75 % CAGR tržeb za nejvýše tři roky; pokud chybí, 75 % CAGR FCF. Omezení −5 až 20 %, při chybějících kladných základech náhradní 5 %. |
| Diskont | 12 % při ztrátě, 10 % pro finanční profil, 11 % při historickém růstu nad 20 %, jinak 9 %. Transparentní rizikové scénáře, nikoli dopočtená beta/WACC. |
| Terminální růst | 2,5 %. DCF má pět let výchozího růstu a pět let lineárního přechodu k terminálnímu růstu. |
| Růst dividend | Utlumený růst omezený na 0–4 %. |

Horní meze násobků omezují vliv téměř nulových zisků a historické euforie: například medián P/E PLTR je přibližně 645 a NVDA 95. Cena sama není cílem kalibrace, nevstupuje do ořezu hodnoty a nejsou zavedené žádné tickerové koeficienty. Změna kotace může změnit dividendový profil kvůli hranici dividendového výnosu; nejde o přizpůsobení výsledné ceny.

FCF se normalizuje **jen při pozorovatelném skoku investic**: potřebujeme tři starší roční dvojice FCF marže a capex/tržby, kladný aktuální provozní CF a EPS, kladný medián historické marže, investiční náročnost alespoň 1,4× historického mediánu a aktuální FCF marži pod 80 % historického mediánu. Základ je průměr aktuálního FCF a `medián historické FCF marže × aktuální tržby`, nejvýše 80 % aktuálního provozního CF. Musí zůstat kladný. Historie pro marže vylučuje poslední roční výkaz, aby nová investiční vlna neurčovala celý referenční základ. Nesplněné podmínky zachovají TTM / poslední rok.

Takto zůstává polovina aktuální investiční zátěže ve výpočtu. Není tím prokázáno, že investice skončí nebo přinesou výnos. U GOOGL se FCF/akcii zvýší přibližně z 4,33 na 6,01 USD, u MSFT z 9,00 na 10,76 USD; nejde o automatický návrat celé staré marže. Normalizuje se také META a AMZN. P/FCF používá stejný zvolený základ, jeho historický násobek ale pochází z vykázaného FCF; tato nesouměrnost je dalším důvodem omezené váhy metody.

Zachované volby jsou poslední TTM/rok, skutečný průměr tří úplných navazujících let a nová normalizace investic. Chybějící data nejsou nuly. Volitelné přičtení čisté hotovosti je nadále standardně vypnuté; provozní CF po úrocích minus capex není plnohodnotné FCFF ani přesně rekonstruované FCFE. Přičtení čisté hotovosti může započítat financování dvakrát. USD kontrola, výběr posledního počtu akcií, reverzní DCF a mřížka citlivosti zůstávají zachované. Nepoužitelný profil se neobchází ani přes citlivost.

## Potenciál, ruční změny a ověření

Potenciál je `hodnota / cena − 1`, při nezáporné hodnotě nikdy pod −100 %. Věta „cena je o X % pod/nad férovou hodnotou“ používá základ férové hodnoty, tedy absolutní velikost `cena / hodnota − 1`. Proto se procenta mohou lišit; nad férovou hodnotou smí být cena i o více než 100 %. Klasická bezpečnostní rezerva `1 − cena / hodnota` se zobrazí pouze při ceně pod hodnotou. Chybějící či nekladná cena skryje srovnání.

Například při hodnotě 100 a ceně 120 je potenciál −16,67 %, cena je o 20 % nad hodnotou a bezpečnostní rezerva se nezobrazuje. U nového GOOGL je potenciál +8,78 %, cena o 8,07 % pod hodnotou a bezpečnostní rezerva 8,07 %.

Posuvníky včetně nových P/FCF, P/B a P/S umožňují změnu předpokladů. Ruční hodnoty přežijí pozdější načtení historie, „Vrátit výchozí“ zruší všechny změny a použije aktuální firemní historii. Změna symbolu zruší předchozí úpravy. Použitelnost metod se řídí výkazy, nikoli posuvníkem růstu; uživatel tak nevnutí Graham do růstového profilu pouhým snížením růstu na nulu.

Ověřeno `npx.cmd tsc --noEmit -p tsconfig.app.json` a `npx.cmd vitest run` s testovacími `VITE_SUPABASE_URL=http://x`, `VITE_SUPABASE_PUBLISHABLE_KEY=x`. Všechny **56 testové soubory / 620 testů** prošly, včetně parity cs/en. Na Windows je `.cmd` ekvivalentem `npx` bez blokace PowerShell execution policy. Kalibrační soubor obsahuje 39 případů: pásma, skutečné váhy, banky i smíšený finanční profil, normalizaci, ztráty, nedostatek historie, ořez extrémů, neměnnost výsledku při přejmenování tickeru a nezávislost GOOGL na kotaci. UI ověřuje integraci historie, reset, překlady a oba směry cenového srovnání.

Všech devět předepsaných stabilních firem splňuje původní pásmo 0,5–1,7×; jejich skutečný rozsah je **0,731–1,231×**. Žádné pásmo nebylo rozšířeno. Ze všech 25 firem má 24 kladný výsledek, z toho čtyři výhradně relativní P/S. Rozsah číselných výsledků je **0,138–2,022× ceny**, žádný není záporný ani nad 5×. O nemá souhrn kvůli chybějícím AFFO/NAV. Nízká TSLA a PLTR nejsou zvýšeny podle tržní ceny: jednoduché modely nevystihují opční hodnotu dosud neprokázaných budoucích projektů. Vysoké APP naopak ukazuje citlivost na udržitelnost rychle rostoucích marží. Splnění pásem je regresní kontrola, nikoli důkaz správné vnitřní hodnoty.

## Kalibrace všech 25 firem

Hodnoty a ceny jsou v USD na akcii, poměry před zaokrouhlením. „P/E růst“ je diskontované růstové P/E, DDM je dividendový model. U P/S je číslo relativním oceněním, nikoli tvrzením o vnitřní férové hodnotě.

| Firma | Cena | Výsledná hodnota | Metody a skutečné váhy | Hodnota/cena | Komentář |
| --- | ---: | ---: | --- | ---: | --- |
| GOOGL | 340,59 | 370,50 | DCF 30 %, P/E 40 %, P/E růst 10 %, P/FCF 20 % | 1,088× | Normalizované investice; Graham a malá dividenda mimo souhrn. |
| MSFT | 529,05 | 528,29 | DCF 30 %, P/E 40 %, P/E růst 10 %, P/FCF 20 % | 0,999× | Normalizované investice, násobky z vlastní historie. |
| AAPL | 343,46 | 251,09 | DCF 30 %, P/E 50 %, P/FCF 20 % | 0,731× | Nízký růst tržeb; účetní kapitál po odkupech neurčuje souhrn. |
| META | 709,33 | 814,47 | DCF 30 %, P/E 40 %, P/E růst 10 %, P/FCF 20 % | 1,148× | Normalizované investice, utlumený růst, malá dividenda vyloučena. |
| AMZN | 250,00 | 292,42 | DCF 30 %, P/E 40 %, P/E růst 10 %, P/FCF 20 % | 1,170× | Normalizace capex, P/FCF omezeno na 50; silná citlivost na EPS. |
| NVDA | 214,13 | 295,02 | DCF 30 %, P/E 40 %, P/E růst 10 %, P/FCF 20 % | 1,378× | Růst omezen na 20 %, diskont 11 %, P/E 45 a P/FCF 50. |
| APP | 266,13 | 538,25 | DCF 30 %, P/E 40 %, P/E růst 10 %, P/FCF 20 % | 2,022× | Nejvyšší poměr; závisí na udržitelnosti současných zisků a marží. |
| RKLB | 50,84 | 14,66 (relativní) | P/S 100 % | 0,288× | Ztrátová; vlastní historické P/S omezeno na 12. |
| NBIS | 165,47 | 58,00 (relativní) | P/S 100 % | 0,350× | TTM ztráta a investiční expanze; vysoká nejistota historie měnícího se podnikání. |
| TSLA | 354,72 | 48,88 | DCF 30 %, P/E 50 %, P/FCF 20 % | 0,138× | Nízké současné EPS a utlumený růst; budoucí nové projekty nejsou explicitně oceněny. |
| PLTR | 186,03 | 53,86 | DCF 30 %, P/E 40 %, P/E růst 10 %, P/FCF 20 % | 0,290× | Extrémní historické násobky oříznuty, růst nejvýše 20 %. |
| MELI | 1 834,00 | 1 350,68 | P/E 75 %, P/B 25 % | 0,736× | Smíšený finanční profil: vysoké CF/zisk a dluh/kapitál; FCF vyloučeno. |
| SOFI | 14,55 | 16,79 | P/E 75 %, P/B 25 % | 1,154× | Bankovní struktura, záporné FCF není vstupem DCF. |
| NU | 14,56 | 19,16 | P/E 75 %, P/B 25 % | 1,316× | Finanční profil; P/B z ROE, nikoli z historie cen. |
| JPM | 339,72 | 307,64 | P/E 75 %, P/B 25 % | 0,906× | P/E ukotvené ve vlastní historii, doplněné kapitálem a ROE. |
| KO | 93,90 | 79,85 | DCF 20 %, P/E 45 %, P/FCF 25 %, DDM 10 % | 0,850× | Významný plátce; dividenda má pouze podpůrnou váhu. |
| PG | 159,35 | 141,89 | DCF 20 %, P/E 45 %, P/FCF 25 %, DDM 10 % | 0,890× | Nízký růst, zisk a cash flow zůstávají hlavním základem. |
| JNJ | 255,56 | 191,00 | DCF 20 %, P/E 45 %, P/FCF 25 %, DDM 10 % | 0,747× | Ziskové výkyvy; model nepředstírá detailní očištění jednorázových položek. |
| PEP | 131,49 | 161,85 | DCF 20 %, P/E 45 %, P/FCF 25 %, DDM 10 % | 1,231× | Významný plátce s historickými násobky a nízkým růstem. |
| XOM | 178,98 | 92,29 | DCF 20 %, P/E 45 %, P/FCF 25 %, DDM 10 % | 0,516× | Klesající tržby vůči silnému počátku historie; výrazné cyklické omezení. |
| T | 23,44 | 30,56 | DCF 20 %, P/E 45 %, P/FCF 25 %, DDM 10 % | 1,304× | Nízký růst, vlastní nízké násobky, významné dividendy. |
| O | 56,08 | — | Žádná | — | Chybí AFFO / hodnota aktiv; účetní zisk a CF nestačí. |
| INTC | 89,85 | 26,89 (relativní) | P/S 100 % | 0,299× | TTM ztráta vylučuje i kladné poslední FCF z ocenění. |
| PFE | 29,58 | 18,60 | DCF 30 %, P/E 50 %, P/FCF 20 % | 0,629× | Dividendy převyšují aktuální EPS; Gordon vyloučen, silný pokles proti pandemické základně. |
| F | 12,43 | 14,14 (relativní) | P/S 100 % | 1,138× | Účetní ztráta; kladné FCF se nepoužije, P/S má dolní mez 0,3. |
