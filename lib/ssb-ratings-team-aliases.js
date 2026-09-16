'use strict';

/**
 * Cross-source team-name canonicalizer for the external-ratings layer.
 *
 * Massey, Sagarin and Sasser each spell the same program differently (`Ohio St`
 * vs `Ohio State`, `Hawai'i` vs `Hawaii`). A cross-source join needs one key per
 * program, so this module maps whatever a source printed to a canonical team key.
 *
 * Canonical keys are ESPN's own published team strings, taken from the public
 * teams endpoint, so the keys are verified spellings rather than guessed ones:
 * the college leagues use the school (`location`, e.g. `Ohio State`), while the
 * pro leagues use the whole-team `displayName` because their `location` is only
 * the metro (`Los Angeles` covers both the Rams and the Chargers). Only the
 * identity of a program is stored here - never a rating, and never a third-party
 * payload.
 *
 * Two hard rules, both fail-closed (the same rule the tennis context resolver
 * follows):
 *
 *   1. Never guess. A name that is not a registered program is `null`, not a
 *      best-effort fuzzy match. `Nowhere Tech` and a bare nickname (`Bama`) stay
 *      unresolved until the registry knows them.
 *   2. Never resolve an ambiguity. If one key maps to more than one registered
 *      program in a league, it is `null`. `OSU` is registered for Ohio State,
 *      Oklahoma State and Oregon State, so it resolves to none of them. The
 *      ambiguity is derived from the registry, so a colliding alias added later
 *      fails closed on its own.
 *
 * The registry is seeded from the programs named in the ratings plan and the
 * verified Sagarin benchmark (docs/research/sagarin-ncaaf-benchmark-2026-09-06.md),
 * plus the full rosters of every league the ratings layer covers. Both college
 * leagues are seeded from ESPN's public teams endpoint and key on `location`:
 * NCAAF carries the full FBS roster so a complete Massey FBS table resolves (the
 * first live Massey snapshot left 54/138 rows unresolved against a partial list),
 * and NCAAB carries every program ESPN publishes for `basketball/mens-college-basketball`
 * (362 teams), because massey NCAAB is a covered league whose whole table
 * previously stayed unresolved.
 *
 * NCAAF is NOT FBS-only. The league's game universe is whatever the board
 * carries, and a live NoVigApp NCAAF scan on 2026-09-16 returned 142 teams of
 * which 44 were FCS programs (`Monmouth @ Albany`, `Villanova @ LIU`, ...), so
 * an FBS-only registry left those games with a rating no side could attach to.
 * The FCS programs Sagarin prints are therefore seeded too, keyed from the same
 * ESPN `football/college-football` roster (its own published `location`, e.g.
 * `UAlbany`, `UT Martin`, `Long Island University`). Sagarin prints a
 * `(AA)` marker on exactly the FCS rows of its CFB table, which is how the
 * FCS/FBS split was verified rather than assumed.
 *
 * Every source-printed spelling registered here was matched to an ESPN-published
 * identity by an exact normalized match on one of ESPN's own name fields, never
 * transliterated or inferred from an abbreviation: Sagarin's `Montana State`,
 * `Grambling State`, `Cal Poly-SLO`, `Fla. International` and `Miami-Florida` all
 * normalize onto a name the ESPN roster publishes. The handful that do not are
 * hand-mapped against the ESPN-published program they name, and each such
 * mapping is pinned by a test:
 *
 *   - `LouisianaMonroe(ULM)` -> `UL Monroe`, `Miami-Ohio` -> `Miami (OH)`,
 *     `SE Missouri State` -> `Southeast Missouri State`: the qualifier names the
 *     state, not a second program.
 *   - `LIU Post` -> `Long Island University`: the page is D1-only, its `(AA)`
 *     marker puts the row in FCS, and the same fixture is printed as
 *     `Villanova @ LIU Post` there and `Villanova @ LIU` on the live board.
 *   - `Texas A&M-Commerce` -> `East Texas A&M`, `Washington Redskins` ->
 *     `Washington Commanders`, `Los Angeles Clippers` -> `LA Clippers`: a
 *     program's former or current name, against the ESPN name for it today.
 *
 * Three printed spellings stay unresolved on purpose, because no ESPN-published
 * identity exists to seed against and inventing one is forbidden: Sagarin's
 * `UTRGV` (ESPN publishes no football team for UT Rio Grande Valley), `Hartford`
 * (left D1) and `St. Francis-NY` (the Brooklyn program, whose athletics were
 * discontinued).
 *
 * Four NCAAB programs appear in the live Massey NCAAB table but in none of that
 * basketball roster, and their keys are still ESPN's, not invented: they are
 * taken from the same ESPN teams family published under another sport, which is
 * the closest ESPN-verified `location` - `Queens University`, `Lindenwood` and
 * `Southern Indiana` under `basketball/womens-college-basketball` and
 * `baseball/college-baseball`, and `Saint Francis` under `baseball/college-baseball`
 * (the Loretto PA school, abbreviation `SFPA`). ESPN also publishes the separate
 * Brooklyn program as `St. Francis (BKN)`, so the PA entry registers only its
 * *qualified* source spellings (`St Francis PA`, `Saint Francis-Pa.`) and leaves
 * a bare `St Francis` unregistered rather than letting one name cover two
 * programs.
 *
 * This table tracks CURRENT D1 membership, and that membership churns: those four
 * arrived by recent D1 addition/reclassification, which is exactly why the
 * upstream roster lagged them. Re-verify against the live Massey table before
 * treating the list as complete - a program new to D1 shows up as `unresolved`
 * until it is seeded here, and a reclassified one can leave a stale entry behind.
 *
 * Each entry's variants are the other printed spellings for that program: an ESPN
 * abbreviation (`ACU`) plus the spellings the sources print (`Ohio St`,
 * `Connecticut`, `Miami FL`, `St Mary's CA`). Identity only, as above. Extend a
 * league by adding an entry to `TEAMS`; an unknown name staying unresolved is the
 * contract, not a bug.
 */

/** League spellings that adapters and the CLI use in place of the canonical code. */
const LEAGUE_ALIASES = Object.freeze({
  ncaaf: 'NCAAF',
  cfb: 'NCAAF',
  collegefootball: 'NCAAF',
  ncaab: 'NCAAB',
  nfl: 'NFL',
  nba: 'NBA',
  mlb: 'MLB',
  nhl: 'NHL',
  wnba: 'WNBA',
  mls: 'MLS'
});

/**
 * Registered programs per league: `[canonicalName, [variant, ...]]`.
 * Canonical names are ESPN-verified: `location` for the college leagues (NCAAF,
 * NCAAB), `displayName` for the pro leagues (see the module header).
 */
const TEAMS = Object.freeze({
  NCAAF: [
    ['Abilene Christian', []],
    ['Air Force', ['AF']],
    ['Akron', []],
    ['Alabama', ['ALA']],
    ['Alabama A&M', []],
    ['Alabama State', []],
    ['Alcorn State', []],
    ['App State', ['APP', 'Appalachian State']],
    ['Arizona', ['ARIZ']],
    ['Arizona State', ['Arizona St', 'ASU']],
    ['Arkansas', ['ARK']],
    ['Arkansas-Pine Bluff', ['Ark.-Pine Bluff']],
    ['Arkansas State', ['Arkansas St']],
    ['Army', ['Army West Point']],
    ['Auburn', ['AUB']],
    ['Austin Peay', []],
    ['Ball State', ['Ball St']],
    ['Baylor', ['BAY']],
    ['Bethune-Cookman', []],
    ['Boise State', ['Boise St', 'BOIS']],
    ['Boston College', ['BC']],
    ['Bowling Green', []],
    ['Brown', []],
    ['Bryant', []],
    ['Bucknell', []],
    ['Buffalo', []],
    ['Butler', []],
    ['BYU', []],
    ['Cal Poly', ['Cal Poly-SLO']],
    ['California', ['CAL', 'Cal']],
    ['Campbell', []],
    ['Central Arkansas', []],
    ['Central Connecticut', []],
    ['Central Michigan', ['C Michigan']],
    ['Charleston Southern', []],
    ['Charlotte', ['CLT']],
    ['Chattanooga', []],
    ['Chicago State', []],
    ['Cincinnati', ['CIN']],
    ['Clemson', ['CLEM']],
    ['Coastal Carolina', ['Coastal Car']],
    ['Colgate', []],
    ['Colorado', ['COLO']],
    ['Colorado State', ['Colorado St']],
    ['Columbia', []],
    ['Cornell', []],
    ['Dartmouth', []],
    ['Davidson', []],
    ['Dayton', []],
    ['Delaware', []],
    ['Delaware State', []],
    ['Drake', []],
    ['Duke', []],
    ['Duquesne', []],
    ['East Carolina', []],
    ['East Tennessee State', []],
    ['East Texas A&M', []],
    ['Eastern Illinois', []],
    ['Eastern Kentucky', []],
    ['Eastern Michigan', ['E Michigan']],
    ['Eastern Washington', []],
    ['Elon', []],
    ['Florida', ['FLA']],
    ['Florida A&M', []],
    ['Florida Atlantic', ['FL Atlantic']],
    ['Florida International', ['Florida Intl', 'Fla. International']],
    ['Florida State', ['Florida St', 'FSU']],
    ['Fordham', []],
    ['Fresno State', ['Fresno St']],
    ['Furman', []],
    ['Gardner-Webb', []],
    ['Georgetown', []],
    ['Georgia', ['UGA']],
    ['Georgia Southern', ['Ga Southern']],
    ['Georgia State', ['Georgia St']],
    ['Georgia Tech', ['GT']],
    ['Grambling', ['Grambling State']],
    ['Hampton', []],
    ['Harvard', []],
    ["Hawai'i", ['HAW', 'Hawaii']],
    ['Holy Cross', []],
    ['Houston', ['HOU']],
    ['Houston Christian', []],
    ['Howard', []],
    ['Idaho', []],
    ['Idaho State', ['Idaho St', 'IDST']],
    ['Illinois', ['ILL']],
    ['Illinois State', []],
    ['Incarnate Word', []],
    ['Indiana', ['IU']],
    ['Indiana State', []],
    ['Iowa', []],
    ['Iowa State', ['ISU']],
    ['Jackson State', []],
    ['Jacksonville State', ['Jacksonville St']],
    ['James Madison', []],
    ['Kansas', ['KU']],
    ['Kansas State', ['Kansas St', 'KSU']],
    ['Kennesaw State', ['Kennesaw']],
    ['Kent State', ['Kent']],
    ['Kentucky', ['UK']],
    ['Lafayette', []],
    ['Lamar', []],
    ['Lehigh', []],
    ['Liberty', []],
    ['Lindenwood', []],
    ['Long Island University', ['LIU Post', 'LIU']],
    ['Louisiana', ['Louisiana-Lafayette']],
    ['Louisiana Tech', []],
    ['Louisville', ['LOU']],
    ['LSU', ['Louisiana State']],
    ['Maine', []],
    ['Marist', []],
    ['Marshall', []],
    ['Maryland', ['MD']],
    ['Massachusetts', ['UMass', 'MASS']],
    ['McNeese', ['McNeese State']],
    ['Memphis', ['MEM']],
    ['Mercer', []],
    ['Mercyhurst', []],
    ['Merrimack', []],
    ['Miami', ['MIA', 'Miami (FL)', 'Miami FL', 'Miami-Florida']],
    ['Miami (OH)', ['M-OH', 'Miami OH', 'Miami-Ohio', 'Miami Ohio']],
    ['Michigan', ['MICH']],
    ['Michigan State', ['Michigan St', 'MSU']],
    ['Middle Tennessee', ['MTSU']],
    ['Minnesota', ['MINN']],
    ['Mississippi State', ['Mississippi St', 'MSST']],
    ['Mississippi Valley State', ['Miss. Valley State']],
    ['Missouri', ['MIZ']],
    ['Missouri State', ['Missouri St']],
    ['Monmouth', ['Monmouth-NJ']],
    ['Montana', []],
    ['Montana State', []],
    ['Morehead State', []],
    ['Morgan State', []],
    ['Murray State', []],
    ['Navy', []],
    ['NC State', ['NCSU', 'North Carolina State', 'North Carolina St']],
    ['Nebraska', ['NEB']],
    ['Nevada', ['NEV']],
    ['New Hampshire', []],
    ['New Haven', []],
    ['New Mexico', []],
    ['New Mexico State', ['New Mexico St']],
    ['Nicholls', ['Nicholls State']],
    ['Norfolk State', []],
    ['North Alabama', []],
    ['North Carolina', ['UNC']],
    ['North Carolina A&T', ['NC A&T']],
    ['North Carolina Central', ['NC Central']],
    ['North Dakota', []],
    ['North Dakota State', ['N Dakota St']],
    ['North Texas', []],
    ['Northern Arizona', []],
    ['Northern Colorado', []],
    ['Northern Illinois', ['N Illinois']],
    ['Northern Iowa', []],
    ['Northwestern', []],
    ['Northwestern State', []],
    ['Notre Dame', ['ND']],
    ['Ohio', []],
    ['Ohio State', ['OSU']],
    ['Oklahoma', ['OU']],
    ['Oklahoma State', ['Oklahoma St', 'OKST', 'OSU']],
    ['Old Dominion', []],
    ['Ole Miss', ['MISS', 'Mississippi']],
    ['Oregon', ['ORE']],
    ['Oregon State', ['Oregon St', 'ORST', 'OSU']],
    ['Penn State', ['PSU']],
    ['Pennsylvania', []],
    ['Pittsburgh', ['Pitt', 'PITT']],
    ['Portland State', []],
    ['Prairie View A&M', ['Prairie View']],
    ['Presbyterian', ['Presbyterian College']],
    ['Princeton', []],
    ['Purdue', ['PUR']],
    ['Rhode Island', []],
    ['Rice', []],
    ['Richmond', []],
    ['Robert Morris', []],
    ['Rutgers', ['RUTG']],
    ['Sacramento State', ['CS Sacramento']],
    ['Sacred Heart', []],
    ['Sam Houston', ['Sam Houston St']],
    ['Samford', []],
    ['San Diego', []],
    ['San Diego State', ['San Diego St']],
    ['San José State', ['San Jose St']],
    ['SE Louisiana', ['Southeastern Louisiana']],
    ['SMU', ['Southern Methodist']],
    ['South Alabama', []],
    ['South Carolina', ['SC']],
    ['South Carolina State', ['SC State']],
    ['South Dakota', []],
    ['South Dakota State', []],
    ['South Florida', []],
    ['Southeast Missouri State', ['SE Missouri State']],
    ['Southern', ['Southern U.']],
    ['Southern Illinois', []],
    ['Southern Miss', ['Southern Mississippi']],
    ['Southern Utah', []],
    ['St. Thomas', ['St. Thomas-Mn.']],
    ['Stanford', ['STAN']],
    ['Stephen F. Austin', []],
    ['Stetson', []],
    ['Stonehill', ['Stonehill College']],
    ['Stony Brook', []],
    ['Syracuse', ['SYR']],
    ['Tarleton State', []],
    ['TCU', ['Texas Christian']],
    ['Temple', []],
    ['Tennessee', ['TENN']],
    ['Tennessee State', []],
    ['Tennessee Tech', []],
    ['Texas', ['TEX']],
    ['Texas A&M', ['TA&M']],
    ['Texas Southern', []],
    ['Texas State', ['Texas St']],
    ['Texas Tech', ['TTU']],
    ['The Citadel', ['CIT', 'Citadel']],
    ['Toledo', ['TOL']],
    ['Towson', []],
    ['Troy', []],
    ['Tulane', []],
    ['Tulsa', ['TLSA']],
    ['UAB', []],
    ['UAlbany', ['Albany-NY', 'Albany']],
    ['UC Davis', []],
    ['UCF', ['Central Florida', 'Central Florida(UCF)']],
    ['UCLA', ['California Los Angeles']],
    ['UConn', ['Connecticut']],
    ['UL Monroe', ['ULM', 'LouisianaMonroe(ULM)', 'Louisiana Monroe']],
    ['UNLV', ['Nevada Las Vegas']],
    ['USC', ['Southern California']],
    ['UT Martin', ['Tennessee-Martin']],
    ['Utah Tech', []],
    ['UTEP', []],
    ['UTSA', ['UT San Antonio']],
    ['Utah', []],
    ['Utah State', ['USU']],
    ['Valparaiso', []],
    ['Vanderbilt', ['VAN']],
    ['Villanova', []],
    ['Virginia', ['UVA']],
    ['Virginia Tech', ['VT']],
    ['VMI', []],
    ['Wagner', []],
    ['Wake Forest', ['WAKE']],
    ['Washington', ['WASH']],
    ['Washington State', ['Washington St', 'WSU']],
    ['Weber State', []],
    ['West Florida', []],
    ['West Georgia', []],
    ['West Virginia', ['WVU']],
    ['Western Carolina', []],
    ['Western Illinois', []],
    ['Western Kentucky', ['Western KY', 'WKU']],
    ['Western Michigan', ['W Michigan']],
    ['William & Mary', []],
    ['Wisconsin', ['WIS']],
    ['Wofford', []],
    ['Wyoming', []],
    ['Yale', []],
    ['Youngstown State', []]
  ],
  NFL: [
    ['Arizona Cardinals', ['Cardinals', 'ARI']],
    ['Atlanta Falcons', ['Falcons', 'ATL']],
    ['Baltimore Ravens', ['Ravens', 'BAL']],
    ['Buffalo Bills', ['Bills', 'BUF']],
    ['Carolina Panthers', ['Panthers', 'CAR']],
    ['Chicago Bears', ['Bears', 'CHI']],
    ['Cincinnati Bengals', ['Bengals', 'CIN']],
    ['Cleveland Browns', ['Browns', 'CLE']],
    ['Dallas Cowboys', ['Cowboys', 'DAL']],
    ['Denver Broncos', ['Broncos', 'DEN']],
    ['Detroit Lions', ['Lions', 'DET']],
    ['Green Bay Packers', ['Packers', 'GB']],
    ['Houston Texans', ['Texans', 'HOU']],
    ['Indianapolis Colts', ['Colts', 'IND']],
    ['Jacksonville Jaguars', ['Jaguars', 'JAX']],
    ['Kansas City Chiefs', ['Chiefs', 'KC']],
    ['Las Vegas Raiders', ['Raiders', 'LV']],
    ['Los Angeles Chargers', ['Chargers', 'LAC']],
    ['Los Angeles Rams', ['Rams', 'LAR']],
    ['Miami Dolphins', ['Dolphins', 'MIA']],
    ['Minnesota Vikings', ['Vikings', 'MIN']],
    ['New England Patriots', ['Patriots', 'NE']],
    ['New Orleans Saints', ['Saints', 'NO']],
    ['New York Giants', ['Giants', 'NYG']],
    ['New York Jets', ['Jets', 'NYJ']],
    ['Philadelphia Eagles', ['Eagles', 'PHI']],
    ['Pittsburgh Steelers', ['Steelers', 'PIT']],
    ['San Francisco 49ers', ['49ers', 'SF']],
    ['Seattle Seahawks', ['Seahawks', 'SEA']],
    ['Tampa Bay Buccaneers', ['Buccaneers', 'TB']],
    ['Tennessee Titans', ['Titans', 'TEN']],
    ['Washington Commanders', ['Commanders', 'WSH', 'Washington Redskins']]
  ],
  NBA: [
    ['Atlanta Hawks', ['Hawks', 'ATL']],
    ['Boston Celtics', ['Celtics', 'BOS']],
    ['Brooklyn Nets', ['Nets', 'BKN']],
    ['Charlotte Hornets', ['Hornets', 'CHA']],
    ['Chicago Bulls', ['Bulls', 'CHI']],
    ['Cleveland Cavaliers', ['Cavaliers', 'CLE']],
    ['Dallas Mavericks', ['Mavericks', 'DAL']],
    ['Denver Nuggets', ['Nuggets', 'DEN']],
    ['Detroit Pistons', ['Pistons', 'DET']],
    ['Golden State Warriors', ['Warriors', 'GS']],
    ['Houston Rockets', ['Rockets', 'HOU']],
    ['Indiana Pacers', ['Pacers', 'IND']],
    ['LA Clippers', ['Clippers', 'LAC', 'Los Angeles Clippers']],
    ['Los Angeles Lakers', ['Lakers', 'LAL']],
    ['Memphis Grizzlies', ['Grizzlies', 'MEM']],
    ['Miami Heat', ['Heat', 'MIA']],
    ['Milwaukee Bucks', ['Bucks', 'MIL']],
    ['Minnesota Timberwolves', ['Timberwolves', 'MIN']],
    ['New Orleans Pelicans', ['Pelicans', 'NO']],
    ['New York Knicks', ['Knicks', 'NY']],
    ['Oklahoma City Thunder', ['Thunder', 'OKC']],
    ['Orlando Magic', ['Magic', 'ORL']],
    ['Philadelphia 76ers', ['76ers', 'PHI']],
    ['Phoenix Suns', ['Suns', 'PHX']],
    ['Portland Trail Blazers', ['Trail Blazers', 'POR']],
    ['Sacramento Kings', ['Kings', 'SAC']],
    ['San Antonio Spurs', ['Spurs', 'SA']],
    ['Toronto Raptors', ['Raptors', 'TOR']],
    ['Utah Jazz', ['Jazz', 'UTAH']],
    ['Washington Wizards', ['Wizards', 'WSH']]
  ],
  NHL: [
    ['Anaheim Ducks', ['Ducks', 'ANA']],
    ['Boston Bruins', ['Bruins', 'BOS']],
    ['Buffalo Sabres', ['Sabres', 'BUF']],
    ['Calgary Flames', ['Flames', 'CGY']],
    ['Carolina Hurricanes', ['Hurricanes', 'CAR']],
    ['Chicago Blackhawks', ['Blackhawks', 'CHI']],
    ['Colorado Avalanche', ['Avalanche', 'COL']],
    ['Columbus Blue Jackets', ['Blue Jackets', 'CBJ']],
    ['Dallas Stars', ['Stars', 'DAL']],
    ['Detroit Red Wings', ['Red Wings', 'DET']],
    ['Edmonton Oilers', ['Oilers', 'EDM']],
    ['Florida Panthers', ['Panthers', 'FLA']],
    ['Los Angeles Kings', ['Kings', 'LA']],
    ['Minnesota Wild', ['Wild', 'MIN']],
    ['Montreal Canadiens', ['Canadiens', 'MTL']],
    ['Nashville Predators', ['Predators', 'NSH']],
    ['New Jersey Devils', ['Devils', 'NJ']],
    ['New York Islanders', ['Islanders', 'NYI']],
    ['New York Rangers', ['Rangers', 'NYR']],
    ['Ottawa Senators', ['Senators', 'OTT']],
    ['Philadelphia Flyers', ['Flyers', 'PHI']],
    ['Pittsburgh Penguins', ['Penguins', 'PIT']],
    ['San Jose Sharks', ['Sharks', 'SJ']],
    ['Seattle Kraken', ['Kraken', 'SEA']],
    ['St. Louis Blues', ['Blues', 'STL']],
    ['Tampa Bay Lightning', ['Lightning', 'TB']],
    ['Toronto Maple Leafs', ['Maple Leafs', 'TOR']],
    ['Utah Mammoth', ['Mammoth', 'UTAH']],
    ['Vancouver Canucks', ['Canucks', 'VAN']],
    ['Vegas Golden Knights', ['Golden Knights', 'VGK']],
    ['Washington Capitals', ['Capitals', 'WSH']],
    ['Winnipeg Jets', ['Jets', 'WPG']]
  ],
  MLB: [
    ['Arizona Diamondbacks', ['Diamondbacks', 'ARI']],
    ['Athletics', ['ATH']],
    ['Atlanta Braves', ['Braves', 'ATL']],
    ['Baltimore Orioles', ['Orioles', 'BAL']],
    ['Boston Red Sox', ['Red Sox', 'BOS']],
    ['Chicago Cubs', ['Cubs', 'CHC']],
    ['Chicago White Sox', ['White Sox', 'CHW']],
    ['Cincinnati Reds', ['Reds', 'CIN']],
    ['Cleveland Guardians', ['Guardians', 'CLE']],
    ['Colorado Rockies', ['Rockies', 'COL']],
    ['Detroit Tigers', ['Tigers', 'DET']],
    ['Houston Astros', ['Astros', 'HOU']],
    ['Kansas City Royals', ['Royals', 'KC']],
    ['Los Angeles Angels', ['Angels', 'LAA']],
    ['Los Angeles Dodgers', ['Dodgers', 'LAD']],
    ['Miami Marlins', ['Marlins', 'MIA']],
    ['Milwaukee Brewers', ['Brewers', 'MIL']],
    ['Minnesota Twins', ['Twins', 'MIN']],
    ['New York Mets', ['Mets', 'NYM']],
    ['New York Yankees', ['Yankees', 'NYY']],
    ['Philadelphia Phillies', ['Phillies', 'PHI']],
    ['Pittsburgh Pirates', ['Pirates', 'PIT']],
    ['San Diego Padres', ['Padres', 'SD']],
    ['San Francisco Giants', ['Giants', 'SF']],
    ['Seattle Mariners', ['Mariners', 'SEA']],
    ['St. Louis Cardinals', ['Cardinals', 'STL']],
    ['Tampa Bay Rays', ['Rays', 'TB']],
    ['Texas Rangers', ['Rangers', 'TEX']],
    ['Toronto Blue Jays', ['Blue Jays', 'TOR']],
    ['Washington Nationals', ['Nationals', 'WSH']]
  ],
  WNBA: [
    ['Atlanta Dream', ['Dream', 'ATL']],
    ['Chicago Sky', ['Sky', 'CHI']],
    ['Connecticut Sun', ['Sun', 'CON']],
    ['Dallas Wings', ['Wings', 'DAL']],
    ['Golden State Valkyries', ['Valkyries', 'GS']],
    ['Indiana Fever', ['Fever', 'IND']],
    ['Las Vegas Aces', ['Aces', 'LV']],
    ['Los Angeles Sparks', ['Sparks', 'LA']],
    ['Minnesota Lynx', ['Lynx', 'MIN']],
    ['New York Liberty', ['Liberty', 'NY']],
    ['Phoenix Mercury', ['Mercury', 'PHX']],
    ['Portland Fire', ['Fire', 'POR']],
    ['Seattle Storm', ['Storm', 'SEA']],
    ['Toronto Tempo', ['Tempo', 'TOR']],
    ['Washington Mystics', ['Mystics', 'WSH']]
  ],
  MLS: [
    ['Atlanta United FC', ['Atlanta', 'ATL', 'Atlanta United']],
    ['Austin FC', ['Austin', 'ATX']],
    ['CF Montréal', ['MTL']],
    ['Charlotte FC', ['Charlotte', 'CLT']],
    ['Chicago Fire FC', ['Chicago', 'CHI']],
    ['Colorado Rapids', ['Colorado', 'COL']],
    ['Columbus Crew', ['Columbus', 'CLB', 'Columbus Crew SC']],
    ['D.C. United', ['DC']],
    ['FC Cincinnati', ['Cincinnati', 'CIN']],
    ['FC Dallas', ['Dallas', 'DAL']],
    ['Houston Dynamo FC', ['Houston', 'HOU']],
    ['Inter Miami CF', ['Miami', 'MIA']],
    ['LA Galaxy', ['LA']],
    ['LAFC', ['Los Angeles FC']],
    ['Minnesota United FC', ['Minnesota', 'MIN']],
    ['Nashville SC', ['Nashville', 'NSH']],
    ['New England Revolution', ['New England', 'NE']],
    ['New York City FC', ['NYCFC', 'NYC']],
    ['Orlando City SC', ['Orlando', 'ORL']],
    ['Philadelphia Union', ['Philadelphia', 'PHI']],
    ['Portland Timbers', ['Portland', 'POR']],
    ['Real Salt Lake', ['Salt Lake', 'RSL']],
    ['Red Bull New York', ['Red Bull NY', 'RBNY', 'New York Red Bulls']],
    ['San Diego FC', ['San Diego', 'SD']],
    ['San Jose Earthquakes', ['San Jose', 'SJ']],
    ['Seattle Sounders FC', ['Seattle', 'SEA']],
    ['Sporting Kansas City', ['Kansas City', 'SKC']],
    ['St. Louis CITY SC', ['St. Louis', 'STL', 'St. Louis CITY FC']],
    ['Toronto FC', ['Toronto', 'TOR']],
    ['Vancouver Whitecaps', ['Vancouver', 'VAN', 'Vancouver Whitecaps FC']]
  ],
  NCAAB: [
    ['Abilene Christian', ['ACU', 'Abilene Chr']],
    ['Air Force', ['AF']],
    ['Akron', ['AKR']],
    ['Alabama', ['ALA']],
    ['Alabama A&M', ['AAMU']],
    ['Alabama State', ['ALST']],
    ['Alcorn State', ['ALCN']],
    ['American University', ['AMER', 'American Univ', 'American U.']],
    ['App State', ['APP', 'Appalachian St']],
    ['Arizona', ['ARIZ']],
    ['Arizona State', ['ASU']],
    ['Arkansas', ['ARK']],
    ['Arkansas State', ['ARST']],
    ['Arkansas-Pine Bluff', ['UAPB', 'Ark Pine Bluff']],
    ['Army', ['Army West Point']],
    ['Auburn', ['AUB']],
    ['Austin Peay', ['APSU']],
    ['BYU', []],
    ['Ball State', ['BALL']],
    ['Baylor', ['BAY']],
    ['Bellarmine', ['BELL']],
    ['Belmont', ['BEL']],
    ['Bethune-Cookman', ['BCU']],
    ['Binghamton', ['BING', 'Binghamton-NY']],
    ['Boise State', ['BOIS']],
    ['Boston College', ['BC']],
    ['Boston University', ['BU', 'Boston Univ', 'Boston U.']],
    ['Bowling Green', ['BGSU']],
    ['Bradley', ['BRAD']],
    ['Brown', ['BRWN']],
    ['Bryant', ['BRY']],
    ['Bucknell', ['BUCK']],
    ['Buffalo', ['BUF']],
    ['Butler', ['BTLR']],
    ['Cal Poly', ['CP', 'Cal Poly-SLO']],
    ['Cal State Bakersfield', ['CSUB', 'CS Bakersfield']],
    ['Cal State Fullerton', ['CSUF', 'CS Fullerton']],
    ['Cal State Northridge', ['CSUN', 'CS Northridge']],
    ['California', ['CAL']],
    ['California Baptist', ['CBU', 'Cal Baptist']],
    ['Campbell', ['CAM']],
    ['Canisius', ['CAN']],
    ['Central Arkansas', ['CARK', 'Cent Arkansas']],
    ['Central Connecticut', ['CCSU', 'Central Conn', 'Central Connecticut St.']],
    ['Central Michigan', ['CMU', 'C Michigan']],
    ['Charleston', ['COFC', 'Col Charleston', 'College of Charleston']],
    ['Charleston Southern', ['CHSO', 'Charleston So']],
    ['Charlotte', ['CLT']],
    ['Chattanooga', ['UTC']],
    ['Chicago State', ['CHST']],
    ['Cincinnati', ['CIN']],
    ['Clemson', ['CLEM']],
    ['Cleveland State', ['CLE']],
    ['Coastal Carolina', ['CCU', 'Coastal Car']],
    ['Colgate', ['COLG']],
    ['Colorado', ['COLO']],
    ['Colorado State', ['CSU']],
    ['Columbia', ['COLU']],
    ['Coppin State', ['COPP']],
    ['Cornell', ['COR']],
    ['Creighton', ['CREI']],
    ['Dartmouth', ['DART']],
    ['Davidson', ['DAV']],
    ['Dayton', ['DAY']],
    ['DePaul', ['DEP']],
    ['Delaware', ['DEL']],
    ['Delaware State', ['DSU']],
    ['Denver', ['DEN']],
    ['Detroit Mercy', ['DETM', 'Detroit']],
    ['Drake', ['DRKE']],
    ['Drexel', ['DREX']],
    ['Duke', []],
    ['Duquesne', ['DUQ']],
    ['East Carolina', ['ECU']],
    ['East Tennessee State', ['ETSU', 'East Tennessee State(ETS']],
    ['East Texas A&M', ['ETAM', 'Texas A&M-Commerce']],
    ['Eastern Illinois', ['EIU', 'E Illinois']],
    ['Eastern Kentucky', ['EKU', 'E Kentucky']],
    ['Eastern Michigan', ['EMU', 'E Michigan']],
    ['Eastern Washington', ['EWU', 'E Washington']],
    ['Elon', []],
    ['Evansville', ['EVAN']],
    ['Fairfield', ['FAIR']],
    ['Fairleigh Dickinson', ['FDU', 'F Dickinson']],
    ['Florida', ['FLA']],
    ['Florida A&M', ['FAMU']],
    ['Florida Atlantic', ['FAU', 'FL Atlantic']],
    ['Florida Gulf Coast', ['FGCU']],
    ['Florida International', ['FIU', 'Florida Intl', 'Fla. International']],
    ['Florida State', ['FSU']],
    ['Fordham', ['FOR']],
    ['Fresno State', ['FRES']],
    ['Furman', ['FUR']],
    ['Gardner-Webb', ['GWEB']],
    ['George Mason', ['GMU']],
    ['George Washington', ['GW', 'G Washington']],
    ['Georgetown', ['GTWN']],
    ['Georgia', ['UGA']],
    ['Georgia Southern', ['GASO', 'Ga Southern']],
    ['Georgia State', ['GAST']],
    ['Georgia Tech', ['GT']],
    ['Gonzaga', ['GONZ']],
    ['Grambling', ['GRAM', 'Grambling State']],
    ['Grand Canyon', ['GCU']],
    ['Green Bay', ['GB', 'WI Green Bay']],
    ['Hampton', ['HAMP']],
    ['Harvard', ['HARV']],
    ["Hawai'i", ['HAW']],
    ['High Point', ['HPU']],
    ['Hofstra', ['HOF']],
    ['Holy Cross', ['HC']],
    ['Houston', ['HOU']],
    ['Houston Christian', ['HCU', 'Houston Chr']],
    ['Howard', ['HOW']],
    ['IU Indianapolis', ['IUIN', 'IUPUI']],
    ['Idaho', ['IDHO']],
    ['Idaho State', ['IDST']],
    ['Illinois', ['ILL']],
    ['Illinois State', ['ILST']],
    ['Incarnate Word', ['UIW']],
    ['Indiana', ['IU']],
    ['Indiana State', ['INST']],
    ['Iona', []],
    ['Iowa', []],
    ['Iowa State', ['ISU']],
    ['Jackson State', ['JKST']],
    ['Jacksonville', ['JAX']],
    ['Jacksonville State', ['JXST']],
    ['James Madison', ['JMU']],
    ['Kansas', ['KU']],
    ['Kansas City', ['KC', 'Missouri KC', 'Kansas City(UMKC)']],
    ['Kansas State', ['KSU']],
    ['Kennesaw State', ['KENN', 'Kennesaw']],
    ['Kent State', ['KENT']],
    ['Kentucky', ['UK']],
    ['LSU', []],
    ['LSU New Orleans', ['NOLA', 'New Orleans']],
    ['La Salle', ['LAS']],
    ['Lafayette', ['LAF']],
    ['Lamar', ['LAM']],
    ['Le Moyne', ['LEM']],
    ['Lehigh', ['LEH']],
    ['Liberty', ['LIB']],
    ['Lindenwood', ['Lindenwood University']],
    ['Lipscomb', ['LIP']],
    ['Little Rock', ['LR', 'Ark Little Rock']],
    ['Long Beach State', ['LBSU']],
    ['Long Island University', ['LIU', 'LIU Brooklyn', 'Long Island U.(LIU)']],
    ['Longwood', ['LONG']],
    ['Louisiana', ['UL']],
    ['Louisiana Tech', ['LT']],
    ['Louisville', ['LOU']],
    ['Loyola Chicago', ['LUC']],
    ['Loyola Maryland', ['L-MD', 'Loyola MD']],
    ['Loyola Marymount', ['LMU', 'Loy Marymount']],
    ['Maine', ['ME']],
    ['Manhattan', ['MAN']],
    ['Marist', ['MRST']],
    ['Marquette', ['MARQ']],
    ['Marshall', ['MRSH']],
    ['Maryland', ['MD']],
    ['Maryland Eastern Shore', ['UMES', 'MD E Shore', 'Md.-Eastern Shore(UMES)']],
    ['Massachusetts', ['MASS']],
    ['McNeese', ['MCN', 'McNeese St']],
    ['Memphis', ['MEM']],
    ['Mercer', ['MER']],
    ['Mercyhurst', ['MERC']],
    ['Merrimack', ['MRMK']],
    ['Miami', ['MIA', 'Miami FL', 'Miami-Florida']],
    ['Miami (OH)', ['M-OH', 'Miami OH', 'Miami-Ohio']],
    ['Michigan', ['MICH']],
    ['Michigan State', ['MSU']],
    ['Middle Tennessee', ['MTSU']],
    ['Milwaukee', ['MILW', 'WI Milwaukee']],
    ['Minnesota', ['MINN']],
    ['Mississippi State', ['MSST']],
    ['Mississippi Valley State', ['MVSU', 'MS Valley St', 'MVSU(Miss. Valley St.)']],
    ['Missouri', ['MIZ']],
    ['Missouri State', ['MOST']],
    ['Monmouth', ['MONM', 'Monmouth NJ']],
    ['Montana', ['MONT']],
    ['Montana State', ['MTST']],
    ['Morehead State', ['MORE']],
    ['Morgan State', ['MORG']],
    ["Mount St. Mary's", ['MSM', "Mt St Mary's"]],
    ['Murray State', ['MUR']],
    ['NC State', ['NCSU']],
    ['NJIT', ['NJIT(New Jersey Tech)']],
    ['Navy', []],
    ['Nebraska', ['NEB']],
    ['Nevada', ['NEV']],
    ['New Hampshire', ['UNH']],
    ['New Haven', ['NHVN']],
    ['New Mexico', ['UNM']],
    ['New Mexico State', ['NMSU']],
    ['Niagara', ['NIA']],
    ['Nicholls', ['NICH', 'Nicholls St']],
    ['Norfolk State', ['NORF']],
    ['North Alabama', ['UNA']],
    ['North Carolina', ['UNC']],
    ['North Carolina A&T', ['NCAT', 'NC A&T']],
    ['North Carolina Central', ['NCCU', 'NC Central']],
    ['North Dakota', ['UND']],
    ['North Dakota State', ['NDSU', 'N Dakota St']],
    ['North Florida', ['UNF', 'North Florida(UNF)']],
    ['North Texas', ['UNT']],
    ['Northeastern', ['NE']],
    ['Northern Arizona', ['NAU']],
    ['Northern Colorado', ['UNCO', 'N Colorado']],
    ['Northern Illinois', ['NIU', 'N Illinois']],
    ['Northern Iowa', ['UNI']],
    ['Northern Kentucky', ['NKU', 'N Kentucky']],
    ['Northwestern', ['NU']],
    ['Northwestern State', ['NWST', 'Northwestern LA']],
    ['Notre Dame', ['ND']],
    ['Oakland', ['OAK', 'Oakland-Mich.']],
    ['Ohio', []],
    ['Ohio State', ['OSU']],
    ['Oklahoma', ['OU']],
    ['Oklahoma State', ['OKST']],
    ['Old Dominion', ['ODU']],
    ['Ole Miss', ['MISS', 'Mississippi']],
    ['Omaha', ['OMA', 'NE Omaha', 'Omaha(Neb.-Omaha)']],
    ['Oral Roberts', ['ORU']],
    ['Oregon', ['ORE']],
    ['Oregon State', ['ORST']],
    ['Pacific', ['PAC']],
    ['Penn State', ['PSU']],
    ['Pennsylvania', ['PENN']],
    ['Pepperdine', ['PEPP']],
    ['Pittsburgh', ['PITT']],
    ['Portland', ['PORT']],
    ['Portland State', ['PRST']],
    ['Prairie View A&M', ['PV', 'Prairie View']],
    ['Presbyterian', ['PRES', 'Presbyterian College']],
    ['Princeton', ['PRIN']],
    ['Providence', ['PROV']],
    ['Purdue', ['PUR']],
    ['Purdue Fort Wayne', ['PFW', 'Fort Wayne(PFW)']],
    ['Queens University', ['Queens NC', 'Queens University of Charlotte']],
    ['Quinnipiac', ['QUIN']],
    ['Radford', ['RAD']],
    ['Rhode Island', ['URI']],
    ['Rice', []],
    ['Richmond', ['RICH']],
    ['Rider', ['RID']],
    ['Robert Morris', ['RMU']],
    ['Rutgers', ['RUTG']],
    ['SE Louisiana', ['SELA']],
    ['SIU Edwardsville', ['SIUE']],
    ['SMU', []],
    ['Sacramento State', ['SAC', 'CS Sacramento']],
    ['Sacred Heart', ['SHU']],
    ['Saint Francis', ['Saint Francis University', 'St Francis PA', 'Saint Francis-Pa.']],
    ["Saint Joseph's", ['JOES', "St Joseph's PA", "Saint Joseph's-Pa."]],
    ['Saint Louis', ['SLU', 'St Louis']],
    ["Saint Mary's", ['SMC', "St Mary's CA", "Saint Mary's-Cal."]],
    ["Saint Peter's", ['SPU', "St Peter's"]],
    ['Sam Houston', ['SHSU', 'Sam Houston St']],
    ['Samford', ['SAM']],
    ['San Diego', ['USD']],
    ['San Diego State', ['SDSU']],
    ['San Francisco', ['SF']],
    ['San José State', ['SJSU']],
    ['Santa Clara', ['SCU']],
    ['Seattle U', ['SEA', 'Seattle']],
    ['Seton Hall', ['HALL']],
    ['Siena', ['SIE']],
    ['South Alabama', ['USA']],
    ['South Carolina', ['SC']],
    ['South Carolina State', ['SCST', 'S Carolina St', 'SC State']],
    ['South Carolina Upstate', ['UPST', 'SC Upstate', 'USC Upstate']],
    ['South Dakota', ['SDAK']],
    ['South Dakota State', ['SDST', 'S Dakota St']],
    ['South Florida', ['USF']],
    ['Southeast Missouri State', ['SEMO', 'SE Missouri St', 'SE Missouri State(SEMO)']],
    ['Southern', ['SOU', 'Southern Univ', 'Southern U.']],
    ['Southern Illinois', ['SIU', 'S Illinois']],
    ['Southern Indiana', ['University of Southern Indiana']],
    ['Southern Miss', ['USM']],
    ['Southern Utah', ['SUU']],
    ['St. Bonaventure', ['SBU']],
    ["St. John's", ['SJU']],
    ['St. Thomas', ['STMN', 'St Thomas MN']],
    ['Stanford', ['STAN']],
    ['Stephen F. Austin', ['SFA', 'SF Austin']],
    ['Stetson', ['STET']],
    ['Stonehill', ['STO']],
    ['Stony Brook', ['STBK', 'Stony Brook-NY']],
    ['Syracuse', ['SYR']],
    ['TCU', []],
    ['Tarleton State', ['TAR']],
    ['Temple', ['TEM']],
    ['Tennessee', ['TENN']],
    ['Tennessee State', ['TNST']],
    ['Tennessee Tech', ['TNTC']],
    ['Texas', ['TEX']],
    ['Texas A&M', ['TA&M']],
    ['Texas A&M-Corpus Christi', ['AMCC', 'TAM C. Christi', 'Texas A&M-CorpusChristi']],
    ['Texas Southern', ['TXSO', 'TX Southern']],
    ['Texas State', ['TXST']],
    ['Texas Tech', ['TTU']],
    ['The Citadel', ['CIT']],
    ['Toledo', ['TOL']],
    ['Towson', ['TOW']],
    ['Troy', []],
    ['Tulane', ['TULN']],
    ['Tulsa', ['TLSA']],
    ['UAB', []],
    ['UAlbany', ['UALB', 'SUNY Albany', 'Albany-NY']],
    ['UC Davis', ['UCD']],
    ['UC Irvine', ['UCI']],
    ['UC Riverside', ['UCR']],
    ['UC San Diego', ['UCSD']],
    ['UC Santa Barbara', ['UCSB']],
    ['UCF', ['Central Florida(UCF)']],
    ['UCLA', []],
    ['UConn', ['CONN', 'Connecticut']],
    ['UIC', ['IL Chicago', 'Illinois-Chicago']],
    ['UL Monroe', ['ULM']],
    ['UMBC', []],
    ['UMass Lowell', ['UML', 'MA Lowell']],
    ['UNC Asheville', ['UNCA', 'NC Asheville']],
    ['UNC Greensboro', ['UNCG', 'NC Greensboro']],
    ['UNC Wilmington', ['UNCW', 'NC Wilmington']],
    ['UNLV', []],
    ['USC', ['Southern California']],
    ['UT Arlington', ['UTA']],
    ['UT Martin', ['UTM', 'TN Martin', 'Tennessee-Martin']],
    ['UT Rio Grande Valley', ['RGV', 'UTRGV']],
    ['UTEP', []],
    ['UTSA', ['UT San Antonio']],
    ['Utah', []],
    ['Utah State', ['USU']],
    ['Utah Tech', ['UTU']],
    ['Utah Valley', ['UVU']],
    ['VCU', ['VCU(Va. Commonwealth)']],
    ['VMI', []],
    ['Valparaiso', ['VAL']],
    ['Vanderbilt', ['VAN']],
    ['Vermont', ['UVM']],
    ['Villanova', ['VILL']],
    ['Virginia', ['UVA']],
    ['Virginia Tech', ['VT']],
    ['Wagner', ['WAG']],
    ['Wake Forest', ['WAKE']],
    ['Washington', ['WASH']],
    ['Washington State', ['WSU']],
    ['Weber State', ['WEB']],
    ['West Florida', ['UWF']],
    ['West Georgia', ['WGA']],
    ['West Virginia', ['WVU']],
    ['Western Carolina', ['WCU', 'W Carolina']],
    ['Western Illinois', ['WIU', 'W Illinois']],
    ['Western Kentucky', ['WKU']],
    ['Western Michigan', ['WMU', 'W Michigan']],
    ['Wichita State', ['WICH']],
    ['William & Mary', ['W&M']],
    ['Winthrop', ['WIN']],
    ['Wisconsin', ['WIS']],
    ['Wofford', ['WOF']],
    ['Wright State', ['WRST']],
    ['Wyoming', ['WYO']],
    ['Xavier', ['XAV', 'Xavier-Ohio']],
    ['Yale', []],
    ['Youngstown State', ['YSU']]
  ]
});

const INDEXES = new Map();

/**
 * Fold one printed name to a comparison key: strip accents, drop apostrophes,
 * ampersands and periods (so `A&M` === `AM`, `Hawai'i` === `Hawaii`), treat every
 * other run of non-alphanumerics as a word separator, drop a leading `The`.
 *
 * @param {unknown} value
 * @returns {string} comparison key, or "" when there is nothing to key on
 */
function normalizeTeamKey(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[&.'`\u2019]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ');
}

/**
 * Trailing `St` and `State` name the same program (`Ohio St` -> `Ohio State`).
 * Only the final token is rewritten, so `St. Louis` is left alone.
 *
 * @param {string} key - result of normalizeTeamKey
 * @returns {string}
 */
function expandStateSuffix(key) {
  return key.endsWith(' st') ? `${key.slice(0, -3)} state` : key;
}

/**
 * Build (once per league) the key -> canonical-set index used for lookups.
 *
 * @param {string} league - canonical league code
 * @returns {Map<string, Set<string>>}
 */
function indexFor(league) {
  const cached = INDEXES.get(league);
  if (cached) return cached;

  const index = new Map();
  for (const [canonical, aliases] of TEAMS[league] || []) {
    for (const raw of [canonical, ...aliases]) {
      const key = normalizeTeamKey(raw);
      if (!key) continue;
      for (const candidate of new Set([key, expandStateSuffix(key)])) {
        if (!index.has(candidate)) index.set(candidate, new Set());
        index.get(candidate).add(canonical);
      }
    }
  }
  INDEXES.set(league, index);
  return index;
}

/**
 * Resolve the league argument to a seeded canonical code, or null.
 *
 * @param {unknown} league
 * @returns {string|null}
 */
function resolveLeague(league) {
  if (typeof league !== 'string') return null;
  const key = league
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!key) return null;
  const resolved = LEAGUE_ALIASES[key];
  return resolved && TEAMS[resolved] ? resolved : null;
}

/**
 * Canonical key for one source-printed team name.
 *
 * @param {unknown} name - a team name exactly as a source printed it
 * @param {unknown} league - canonical league code or a known alias (e.g. `CFB`)
 * @returns {string|null} the canonical team, or null when unknown, ambiguous, or
 *   the league carries no registry
 */
function canonicalTeam(name, league) {
  const resolved = resolveLeague(league);
  if (!resolved) return null;

  const key = normalizeTeamKey(name);
  if (!key) return null;

  const index = indexFor(resolved);
  const matches = new Set();
  for (const candidate of new Set([key, expandStateSuffix(key)])) {
    const found = index.get(candidate);
    if (found) for (const canonical of found) matches.add(canonical);
  }

  return matches.size === 1 ? [...matches][0] : null;
}

module.exports = { canonicalTeam };
