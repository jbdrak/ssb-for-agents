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
 * college football uses the school (`location`, e.g. `Ohio State`), while the
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
 * plus the full rosters of the other leagues the plan covers (NCAAB is deliberately
 * absent: no adapter in this plan parses it, so its teams stay unresolved). Extend
 * a league by adding an entry to `TEAMS`; an unknown name staying unresolved is
 * the contract, not a bug.
 */

/** League spellings that adapters and the CLI use in place of the canonical code. */
const LEAGUE_ALIASES = Object.freeze({
  ncaaf: 'NCAAF',
  cfb: 'NCAAF',
  collegefootball: 'NCAAF',
  nfl: 'NFL',
  nba: 'NBA',
  mlb: 'MLB',
  nhl: 'NHL',
  wnba: 'WNBA',
  mls: 'MLS'
});

/**
 * Registered programs per league: `[canonicalName, [variant, ...]]`.
 * Canonical names are ESPN-verified: `location` for NCAAF, `displayName` for the
 * pro leagues (see the module header).
 */
const TEAMS = Object.freeze({
  NCAAF: [
    ['Air Force', ['AF']],
    ['Alabama', ['ALA']],
    ['App State', ['APP', 'Appalachian State']],
    ['Arizona', ['ARIZ']],
    ['Arizona State', ['Arizona St', 'ASU']],
    ['Arkansas', ['ARK']],
    ['Army', []],
    ['Auburn', ['AUB']],
    ['Baylor', ['BAY']],
    ['Boise State', ['Boise St', 'BOIS']],
    ['Boston College', ['BC']],
    ['BYU', []],
    ['California', ['CAL', 'Cal']],
    ['Charlotte', ['CLT']],
    ['Cincinnati', ['CIN']],
    ['Clemson', ['CLEM']],
    ['Colorado', ['COLO']],
    ['Duke', []],
    ['Florida', ['FLA']],
    ['Florida State', ['Florida St', 'FSU']],
    ['Georgia', ['UGA']],
    ['Georgia Tech', ['GT']],
    ["Hawai'i", ['HAW', 'Hawaii']],
    ['Houston', ['HOU']],
    ['Idaho State', ['Idaho St', 'IDST']],
    ['Illinois', ['ILL']],
    ['Indiana', ['IU']],
    ['Iowa', []],
    ['Iowa State', ['ISU']],
    ['Kansas', ['KU']],
    ['Kansas State', ['Kansas St', 'KSU']],
    ['Kentucky', ['UK']],
    ['Louisville', ['LOU']],
    ['LSU', ['Louisiana State']],
    ['Maryland', ['MD']],
    ['Massachusetts', ['UMass', 'MASS']],
    ['Memphis', ['MEM']],
    ['Miami', ['MIA', 'Miami (FL)', 'Miami FL']],
    ['Miami (OH)', ['M-OH', 'Miami OH']],
    ['Michigan', ['MICH']],
    ['Michigan State', ['Michigan St', 'MSU']],
    ['Minnesota', ['MINN']],
    ['Mississippi State', ['Mississippi St', 'MSST']],
    ['Missouri', ['MIZ']],
    ['Navy', []],
    ['NC State', ['NCSU', 'North Carolina State', 'North Carolina St']],
    ['Nebraska', ['NEB']],
    ['Nevada', ['NEV']],
    ['North Carolina', ['UNC']],
    ['Notre Dame', ['ND']],
    ['Ohio State', ['OSU']],
    ['Oklahoma', ['OU']],
    ['Oklahoma State', ['Oklahoma St', 'OKST', 'OSU']],
    ['Ole Miss', ['MISS']],
    ['Oregon', ['ORE']],
    ['Oregon State', ['Oregon St', 'ORST', 'OSU']],
    ['Penn State', ['PSU']],
    ['Pittsburgh', ['Pitt', 'PITT']],
    ['Purdue', ['PUR']],
    ['Rutgers', ['RUTG']],
    ['SMU', ['Southern Methodist']],
    ['South Carolina', ['SC']],
    ['Stanford', ['STAN']],
    ['Syracuse', ['SYR']],
    ['TCU', ['Texas Christian']],
    ['Tennessee', ['TENN']],
    ['Texas', ['TEX']],
    ['Texas A&M', ['TA&M']],
    ['Texas Tech', ['TTU']],
    ['The Citadel', ['CIT', 'Citadel']],
    ['Toledo', ['TOL']],
    ['Tulsa', ['TLSA']],
    ['UCF', ['Central Florida']],
    ['UCLA', ['California Los Angeles']],
    ['UNLV', ['Nevada Las Vegas']],
    ['USC', ['Southern California']],
    ['Utah', []],
    ['Utah State', ['USU']],
    ['Vanderbilt', ['VAN']],
    ['Virginia', ['UVA']],
    ['Virginia Tech', ['VT']],
    ['Wake Forest', ['WAKE']],
    ['Washington', ['WASH']],
    ['Washington State', ['Washington St', 'WSU']],
    ['West Virginia', ['WVU']],
    ['Western Kentucky', ['Western KY', 'WKU']],
    ['Wisconsin', ['WIS']]
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
    ['Washington Commanders', ['Commanders', 'WSH']]
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
    ['LA Clippers', ['Clippers', 'LAC']],
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
    ['Atlanta United FC', ['Atlanta', 'ATL']],
    ['Austin FC', ['Austin', 'ATX']],
    ['CF Montréal', ['MTL']],
    ['Charlotte FC', ['Charlotte', 'CLT']],
    ['Chicago Fire FC', ['Chicago', 'CHI']],
    ['Colorado Rapids', ['Colorado', 'COL']],
    ['Columbus Crew', ['Columbus', 'CLB']],
    ['D.C. United', ['DC']],
    ['FC Cincinnati', ['Cincinnati', 'CIN']],
    ['FC Dallas', ['Dallas', 'DAL']],
    ['Houston Dynamo FC', ['Houston', 'HOU']],
    ['Inter Miami CF', ['Miami', 'MIA']],
    ['LA Galaxy', ['LA']],
    ['LAFC', []],
    ['Minnesota United FC', ['Minnesota', 'MIN']],
    ['Nashville SC', ['Nashville', 'NSH']],
    ['New England Revolution', ['New England', 'NE']],
    ['New York City FC', ['NYCFC', 'NYC']],
    ['Orlando City SC', ['Orlando', 'ORL']],
    ['Philadelphia Union', ['Philadelphia', 'PHI']],
    ['Portland Timbers', ['Portland', 'POR']],
    ['Real Salt Lake', ['Salt Lake', 'RSL']],
    ['Red Bull New York', ['Red Bull NY', 'RBNY']],
    ['San Diego FC', ['San Diego', 'SD']],
    ['San Jose Earthquakes', ['San Jose', 'SJ']],
    ['Seattle Sounders FC', ['Seattle', 'SEA']],
    ['Sporting Kansas City', ['Kansas City', 'SKC']],
    ['St. Louis CITY SC', ['St. Louis', 'STL']],
    ['Toronto FC', ['Toronto', 'TOR']],
    ['Vancouver Whitecaps', ['Vancouver', 'VAN']]
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
