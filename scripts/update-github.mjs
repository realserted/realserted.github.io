#!/usr/bin/env node
// Refreshes the baked GitHub contribution snapshot inside index.html.
//
// The site is a single self-contained bundle: index.html carries a
// __bundler/manifest of gzip+base64 modules, one of which holds the GITHUB
// data object the Contributions section renders. This script queries the
// GraphQL API, recomputes that object, and repacks it in place.
//
// Run by .github/workflows/update-github.yml. Needs a token with read:user —
// a workflow's default GITHUB_TOKEN cannot read a user's contribution calendar.

import fs from "node:fs";
import zlib from "node:zlib";

const TOKEN = process.env.GH_STATS_TOKEN;
const LOGIN = process.env.GH_LOGIN || "realserted";
const FILE = process.env.GH_TARGET || "index.html";

if (!TOKEN) {
  console.error("GH_STATS_TOKEN is not set (needs a PAT with read:user).");
  process.exit(1);
}

const MANIFEST_PREFIX = '  <script type="__bundler/manifest">';
const CLOSE_TAG = "<" + "/script>";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const LEVELS = {
  NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2,
  THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4,
};

const iso = (d) => d.toISOString().slice(0, 10);

// No from/to: the API rejects a span longer than a year, but the calendar's
// own trailing-year window is 53 weeks. Taking the default gives exactly the
// grid github.com shows — Sunday-aligned, with a partial final week.
const QUERY = `
  query($login: String!) {
    user(login: $login) {
      contributionsCollection {
        restrictedContributionsCount
        contributionCalendar {
          weeks { contributionDays { date contributionCount contributionLevel } }
        }
        commitContributionsByRepository(maxRepositories: 100) {
          repository { nameWithOwner }
          contributions { totalCount }
        }
      }
      # commitContributionsByRepository only itemises repositories the token can
      # see, so private work would vanish from the "and N other" count. These
      # totals include it.
      publicRepos: repositoriesContributedTo(
        contributionTypes: [COMMIT], includeUserRepositories: true, privacy: PUBLIC
      ) { totalCount }
      privateRepos: repositoriesContributedTo(
        contributionTypes: [COMMIT], includeUserRepositories: true, privacy: PRIVATE
      ) { totalCount }
    }
  }`;

async function collect() {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: "bearer " + TOKEN,
      "Content-Type": "application/json",
      "User-Agent": "realserted-portfolio-stats",
    },
    body: JSON.stringify({ query: QUERY, variables: { login: LOGIN } }),
  });

  if (!res.ok) throw new Error("GitHub API " + res.status + " " + (await res.text()));
  const body = await res.json();
  if (body.errors) throw new Error("GraphQL: " + JSON.stringify(body.errors));

  const user = body.data.user;
  const c = user.contributionsCollection;
  const repoCount = user.publicRepos.totalCount + user.privateRepos.totalCount;

  // The grid is laid out column-by-column with 7 rows, so the days have to stay
  // in calendar order — GitHub's weeks already begin on Sunday.
  const days = c.contributionCalendar.weeks.flatMap((w) => w.contributionDays);
  if (!days.length) throw new Error("empty contribution calendar for " + LOGIN);

  const counts = days.map((d) => d.contributionCount);
  const levels = days.map((d) => LEVELS[d.contributionLevel] ?? 0);

  const start = new Date(days[0].date + "T00:00:00Z");
  const end = new Date(days[days.length - 1].date + "T00:00:00Z");
  if (start.getUTCDay() !== 0) throw new Error("calendar does not start on a Sunday");

  let activeDays = 0;
  let streak = 0;
  let longestStreak = 0;
  let busiest = { date: days[0].date, count: 0 };
  counts.forEach((n, i) => {
    if (n > 0) {
      activeDays++;
      streak++;
      if (streak > longestStreak) longestStreak = streak;
      if (n > busiest.count) busiest = { date: days[i].date, count: n };
    } else {
      streak = 0;
    }
  });

  const repos = c.commitContributionsByRepository
    .slice()
    .sort((a, b) => b.contributions.totalCount - a.contributions.totalCount)
    .map((r) => r.repository.nameWithOwner);

  // Most of the work is in private client repos, which the calendar counts but
  // does not itemise. The card surfaces that share rather than a commits-vs-PRs
  // ratio, which is always 100% for someone who commits straight to main.
  const total = counts.reduce((a, b) => a + b, 0);
  const privateShare = total === 0
    ? 0
    : Math.round((c.restrictedContributionsCount / total) * 100);

  return {
    user: LOGIN,
    url: "https://github.com/" + LOGIN,
    from: iso(start),
    to: iso(end),
    // Rendered as "Updated · 29 Aug 2026" — the day matters, the refresh is daily.
    asOf: end.getUTCDate() + " " + MONTHS[end.getUTCMonth()] + " " + end.getUTCFullYear(),
    total,
    activeDays,
    longestStreak,
    busiest,
    privateShare,
    repos: repos.slice(0, 3),
    otherRepos: Math.max(0, repoCount - Math.min(3, repos.length)),
    levels: levels.join(""),
    counts,
  };
}

function render(g) {
  const rows = [];
  for (let i = 0; i < g.counts.length; i += 46) {
    rows.push("    " + g.counts.slice(i, i + 46).join(","));
  }

  return [
    "const GITHUB = {",
    "  user: " + JSON.stringify(g.user) + ",",
    "  url: " + JSON.stringify(g.url) + ",",
    "  from: " + JSON.stringify(g.from) + ",",
    "  to: " + JSON.stringify(g.to) + ",",
    "  asOf: " + JSON.stringify(g.asOf) + ",",
    "  total: " + g.total + ",",
    "  activeDays: " + g.activeDays + ",",
    "  longestStreak: " + g.longestStreak + ",",
    "  busiest: { date: " + JSON.stringify(g.busiest.date) + ", count: " + g.busiest.count + " },",
    "  privateShare: " + g.privateShare + ",",
    "  repos: [" + g.repos.map((r) => JSON.stringify(r)).join(", ") + "],",
    "  otherRepos: " + g.otherRepos + ",",
    "  // One character per day: GitHub's 0-4 intensity level.",
    "  levels:",
    "    " + JSON.stringify(g.levels) + ",",
    "  counts: [",
    rows.join(",\n"),
    "  ],",
    "};",
  ].join("\n");
}

function repack(g) {
  const lines = fs.readFileSync(FILE, "utf8").split("\n");
  const mi = lines.findIndex((l) => l.startsWith(MANIFEST_PREFIX));
  if (mi < 0) throw new Error("no __bundler/manifest in " + FILE);

  const eol = lines[mi].endsWith("\r") ? "\r" : "";
  let json = lines[mi].slice(MANIFEST_PREFIX.length).replace(/\r$/, "");
  const closed = json.endsWith(CLOSE_TAG);
  if (closed) json = json.slice(0, -CLOSE_TAG.length);
  const manifest = JSON.parse(json);

  // Find the module by content — the bundler's ids change when the site is
  // re-exported, so never hardcode one.
  let id = null;
  let source = null;
  for (const [key, entry] of Object.entries(manifest)) {
    if (!/javascript|jsx/.test(entry.mime)) continue;
    let buf = Buffer.from(entry.data, "base64");
    if (entry.compressed) buf = zlib.gunzipSync(buf);
    const text = buf.toString("utf8");
    if (text.includes("const GITHUB = {")) {
      id = key;
      source = text;
      break;
    }
  }
  if (!id) throw new Error("no module defines GITHUB");

  const marker = "\n};";
  const start = source.indexOf("const GITHUB = {");
  const end = source.indexOf(marker, start);
  if (end < 0) throw new Error("could not find the end of the GITHUB object");

  const updated = source.slice(0, start) + render(g) + source.slice(end + marker.length);
  if (updated === source) return false;

  const out = Buffer.from(updated, "utf8");
  manifest[id].data = (manifest[id].compressed ? zlib.gzipSync(out, { level: 9 }) : out)
    .toString("base64");

  lines[mi] = MANIFEST_PREFIX + JSON.stringify(manifest) + (closed ? CLOSE_TAG : "") + eol;
  fs.writeFileSync(FILE, lines.join("\n"));
  return true;
}

const stats = await collect();
const changed = repack(stats);
console.log(
  (changed ? "updated" : "no change") + ": " + stats.total + " contributions, " +
  stats.activeDays + " active days, streak " + stats.longestStreak + ", " +
  stats.privateShare + "% private, as of " + stats.asOf
);
