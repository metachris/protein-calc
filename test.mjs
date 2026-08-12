/*
 * Interaction tests for index.html — run against a simulated DOM.
 *
 *   npm i jsdom && node test.mjs
 *
 * Covers the search combobox, unit conversion, per-row and total protein math,
 * the daily-target bar, localStorage round-tripping, USDA response parsing,
 * and HTML escaping of food names coming from the API.
 *
 * Also asserts every built-in protein value still matches the USDA SR28 record
 * pinned for it in sources.json, so editing a number by hand fails the suite.
 */
import { JSDOM } from "jsdom";
import fs from "fs";

const html = fs.readFileSync(new URL("index.html", import.meta.url), "utf8");
const dom = new JSDOM(html, { runScripts: "dangerously", url: "https://localhost/", pretendToBeVisual: true });
const { window } = dom;
const doc = window.document;
const $ = id => doc.getElementById(id);
let fail = 0;
const check = (label, cond, extra = "") => {
  if (!cond) fail++;
  console.log((cond ? "PASS " : "FAIL ") + label + (extra ? "  " + extra : ""));
};

const type = (el, v) => { el.value = v; el.dispatchEvent(new window.Event("input", { bubbles: true })); };
const click = el => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
const mousedown = el => el.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true }));
const totalProtein = () => parseFloat($("total").textContent);
const rows = () => [...$("rows").querySelectorAll("tr")].filter(r => !r.querySelector("td.empty"));
const cells = tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim());

check("page booted without errors", !!$("search") && !!$("rows"));
check("empty state shown", $("rows").textContent.includes("Nothing added yet"));
check("total starts at 0.0 g", $("total").textContent.trim() === "0.0 g", `got "${$("total").textContent.trim()}"`);

// --- add 3 eggs via the search dropdown ---
type($("search"), "egg");
const opts = [...$("results").querySelectorAll(".result")];
check("dropdown lists egg matches", opts.length >= 3, `${opts.length} results, first="${opts[0]?.querySelector(".name").textContent}"`);
check("match is bolded", !!opts[0].querySelector("b"));
mousedown(opts[0]);
check("row added, search cleared", rows().length === 1 && $("search").value === "");
let tr = rows()[0];
check("defaults to 1 large egg", cells(tr)[1] === "" && tr.querySelector("select").value === "large egg");
type(tr.querySelector("input[type=number]"), "3");
tr = rows()[0];
check("3 eggs = 150 g", cells(tr)[3] === "150 g", `got ${cells(tr)[3]}`);
check("3 eggs = 18.9 g protein", cells(tr)[4] === "18.9 g", `got ${cells(tr)[4]}`);

// --- add 300 g lean steak ---
type($("search"), "lean steak");
const steak = [...$("results").querySelectorAll(".result")].find(r => r.textContent.includes("raw"));
mousedown(steak);
tr = rows()[1];
const sel = tr.querySelector("select");
check("steak has no named units, defaults to 100 g", sel.value === "g" && cells(tr)[1] === "");
type(tr.querySelector("input[type=number]"), "300");
tr = rows()[1];
check("300 g steak = 65.7 g protein", cells(tr)[4] === "65.7 g", `got ${cells(tr)[4]}`);

// --- unit switching ---
type($("search"), "almond");
const almondOpts = [...$("results").querySelectorAll(".result")].map(r => r.querySelector(".name").textContent.trim());
check("exact name beats compound prefix (Almonds > Almond milk)", almondOpts[0] === "Almonds", almondOpts.slice(0,2).join(" | "));
mousedown($("results").querySelector(".result"));
tr = rows()[2];
const asel = tr.querySelector("select");
check("almonds offer g/oz/handful/almond", [...asel.options].map(o => o.value).join(",") === "g,oz,handful (28 g),almond",
  [...asel.options].map(o => o.value).join(","));
asel.value = "oz";
asel.dispatchEvent(new window.Event("change", { bubbles: true }));
tr = rows()[2];
check("switching to oz recomputes grams (28.35 g displays as 28)", cells(tr)[3] === "28 g", `got ${cells(tr)[3]}`);

// --- total ---
const expected = 18.9 + 65.7 + 28.3495 * 0.212;
check("total sums all rows", Math.abs(totalProtein() - expected) < 0.06, `total=${totalProtein()} expected≈${expected.toFixed(1)}`);

// --- target + progress bar ---
check("bar hidden with no target", $("bar").hidden);
type($("target"), "150");
check("bar shown with target", !$("bar").hidden);
const w = parseFloat($("bar").firstElementChild.style.width);
check("bar width tracks progress", Math.abs(w - totalProtein() / 150 * 100) < 0.6, `width=${w}%`);
check("note counts remaining", /g to go/.test($("target-note").textContent), $("target-note").textContent);
type($("target"), "50");
check("over target says 'over'", /over/.test($("target-note").textContent), $("target-note").textContent);
check("bar clamps at 100%", parseFloat($("bar").firstElementChild.style.width) === 100);

// --- persistence ---
const stored = JSON.parse(window.localStorage.getItem("protein-calc.v1"));
check("saved to localStorage", stored.entries.length === 3 && stored.target === 50, `${stored.entries.length} entries, target ${stored.target}`);

// --- delete ---
click(rows()[0].querySelector("button.ghost"));
check("delete removes one row", rows().length === 2);
check("total drops after delete", Math.abs(totalProtein() - (expected - 18.9)) < 0.06, `total=${totalProtein()}`);

// --- reload restores state ---
const dom2 = new JSDOM(html, { runScripts: "dangerously", url: "https://localhost/", pretendToBeVisual: true,
  beforeParse(w) { w.localStorage.setItem("protein-calc.v1", window.localStorage.getItem("protein-calc.v1")); } });
const d2 = dom2.window.document;
const rows2 = [...d2.getElementById("rows").querySelectorAll("tr")].filter(r => !r.querySelector("td.empty"));
check("state restored on reload", rows2.length === 2, `${rows2.length} rows`);
check("target restored", d2.getElementById("target").value === "50");
check("no duplicate keys after reload", new Set(JSON.parse(dom2.window.localStorage.getItem("protein-calc.v1")).entries.map(e => e.key)).size === 2);

// --- no-match path ---
type($("search"), "qqqzzz");
check("no-match points at USDA", $("results").textContent.includes("USDA"));

// --- USDA panel: parse a canned API response (network is firewalled here) ---
const usdaSample = { foods: [
  { fdcId: 1, description: "GREEK YOGURT, PLAIN", dataType: "Branded", brandName: "ACME FOODS",
    servingSize: 170, servingSizeUnit: "g",
    foodNutrients: [{ nutrientId: 1003, nutrientName: "Protein", value: 10.6, unitName: "G" }] },
  { fdcId: 2, description: "Skyr, plain", dataType: "Foundation",
    foodNutrients: [{ nutrientNumber: "203", nutrientName: "Protein", value: 11.2 }] },
  { fdcId: 3, description: "Water, bottled", dataType: "Branded", foodNutrients: [] },
] };
window.renderUsdaResults(usdaSample.foods.map(f => ({ raw: f, p: window.usdaProtein(f) })).filter(f => f.p !== null));
const urs = [...$("usda-results").querySelectorAll(".ur")];
check("USDA: protein read from both id and number forms", urs.length === 2, `${urs.length} rows`);
check("USDA: SHOUTED name title-cased", urs[0].querySelector(".name").textContent.startsWith("Greek Yogurt, Plain"),
  urs[0].querySelector(".name").textContent);
check("USDA: mixed-case name left alone", urs[1].querySelector(".name").textContent.startsWith("Skyr, plain"));
check("USDA: protein shown per 100 g", urs[0].querySelector(".val").textContent === "10.6 g /100 g", urs[0].querySelector(".val").textContent);
click(urs[0].querySelector("button"));
const added = rows().at(-1);
check("USDA: Add appends a row", cells(added)[0].includes("Greek Yogurt, Plain"));
check("USDA: serving size became the default unit", added.querySelector("select").value === "serving (170 g)",
  added.querySelector("select").value);
check("USDA: 1 serving = 170 g", cells(added)[3] === "170 g", cells(added)[3]);
check("USDA: 1 serving = 18.0 g protein", cells(added)[4] === "18.0 g", cells(added)[4]);
check("USDA: food saved to custom list", JSON.parse(window.localStorage.getItem("protein-calc.v1")).customFoods.length === 1);
type($("search"), "greek yog");
check("USDA: saved food now searchable and ranked first",
  $("results").querySelector(".result .name").textContent.includes("Greek Yogurt, Plain"),
  $("results").querySelector(".result .name").textContent);

// --- XSS: a hostile food name must not execute or inject markup ---
const evil = { foods: [{ fdcId: 9, description: "<img src=x onerror=window.__pwned=1>Yogurt", dataType: "Branded",
  foodNutrients: [{ nutrientId: 1003, value: 5 }] }] };
window.renderUsdaResults(evil.foods.map(f => ({ raw: f, p: window.usdaProtein(f) })));
const evilRow = [...$("usda-results").querySelectorAll(".ur")][0];
check("hostile name is escaped, not parsed as HTML",
  !evilRow.querySelector("img") && window.__pwned === undefined && evilRow.querySelector(".name").textContent.includes("<img"));


// --- food database integrity ---
const dbSrc = html.slice(html.indexOf("const FOODS"), html.indexOf("/* ====", html.indexOf("const FOODS")));
const FOODS = window.eval(dbSrc + "\nFOODS");
const sources = JSON.parse(fs.readFileSync(new URL("sources.json", import.meta.url), "utf8"));
check("database has 130 foods", FOODS.length === 130, `${FOODS.length}`);
check("no duplicate food names", new Set(FOODS.map(f => f.name)).size === FOODS.length);

let drift = [];
for (const f of FOODS) {
  const ref = sources.foods[f.name];
  if (!ref) { if (!f.est) drift.push(`${f.name}: no source and not marked est`); continue; }
  if (f.est) drift.push(`${f.name}: marked est but has a USDA source`);
  // index.html stores one decimal, so it must agree to within half a decimal place.
  // Anything further off means a value was edited away from its source.
  if (Math.abs(f.p - ref.sr28ProteinPer100g) > 0.05 + 1e-9)
    drift.push(`${f.name}: ${f.p} != SR28 ${ref.sr28ProteinPer100g} (NDB ${ref.ndb})`);
}
check("every protein value matches its pinned USDA SR28 record", drift.length === 0, drift.slice(0,4).join("; "));
check("119 foods are USDA-sourced, 11 label-derived",
  FOODS.filter(f => !f.est).length === 119 && FOODS.filter(f => f.est).length === 11,
  `${FOODS.filter(f => !f.est).length}/${FOODS.filter(f => f.est).length}`);

const badUnit = [];
for (const f of FOODS) {
  if (!(f.p >= 0 && f.p <= 95)) badUnit.push(`${f.name}: implausible p=${f.p}`);
  if (!f.name || !f.group) badUnit.push(`${f.name}: missing field`);
  for (const [n, g] of f.units || []) {
    if (typeof n !== "string" || !(g > 0)) badUnit.push(`${f.name}: bad unit ${n}=${g}`);
    if (n === "g" || n === "oz") badUnit.push(`${f.name}: redefines base unit ${n}`);
  }
  const names = (f.units || []).map(u => u[0]);
  if (new Set(names).size !== names.length) badUnit.push(`${f.name}: duplicate unit name`);
}
check("all units well-formed and non-conflicting", badUnit.length === 0, badUnit.slice(0,4).join("; "));

// --- label-derived rows are visibly marked ---
type($("search"), "whey isolate");
check("label-only row marked with ≈ in dropdown",
  $("results").querySelector(".result .val").textContent.startsWith("≈"),
  $("results").querySelector(".result .val").textContent);
mousedown($("results").querySelector(".result"));
check("label-only row explains itself in the table",
  /product labels/.test(cells(rows().at(-1))[0]), cells(rows().at(-1))[0]);
type($("search"), "egg, whole");
check("USDA-sourced row has no ≈ marker",
  !$("results").querySelector(".result .val").textContent.startsWith("≈"),
  $("results").querySelector(".result .val").textContent);


// ============================================================
// BROWSE VIEW
// ============================================================
const brows = () => [...$("b-rows").querySelectorAll("tr")].filter(r => !r.querySelector("td.empty") && !r.classList.contains("pin-sep"));
const bcells = tr => [...tr.querySelectorAll("td")].map(td => td.textContent.trim());
const bnames = () => brows().map(r => r.querySelector(".bname").textContent.replace(/\s*≈$/, "").trim());
const header = key => doc.querySelector(`button.sorth[data-sort="${key}"]`);
const sortBy = key => click(header(key));

check("browse view starts hidden", $("view-browse").hidden && !$("view-calc").hidden);
click($("tab-browse"));
check("tab switches to browse", !$("view-browse").hidden && $("view-calc").hidden);
check("tabs report selection to a11y tree",
  $("tab-browse").getAttribute("aria-selected") === "true" && $("tab-calc").getAttribute("aria-selected") === "false");
check("browse lists every built-in food plus imported ones", brows().length === 131, `${brows().length}`);
check("browse includes USDA-imported custom foods",
  bnames().some(n => n.startsWith("Greek Yogurt, Plain")));

// --- default sort: protein per 100 g, descending ---
check("defaults to protein/100 g descending",
  header("p").closest("th").getAttribute("aria-sort") === "descending");
const p100 = brows().map(r => parseFloat(bcells(r)[2]));
check("protein/100 g column is sorted descending",
  p100.every((v, i) => i === 0 || p100[i-1] >= v), p100.slice(0,4).join(" "));
check("collagen tops protein/100 g", bnames()[0] === "Collagen peptides", bnames().slice(0,3).join(" | "));

// --- exactly one bar column, and it follows the sort ---
const barCols = tr => [...tr.querySelectorAll("td")].map(td => !!td.querySelector(".mbar-fill"));
check("exactly one column carries bars", barCols(brows()[0]).filter(Boolean).length === 1,
  barCols(brows()[0]).map(b => b ? "bar" : "-").join(","));
check("bar sits in the sorted column (protein/100 g)", barCols(brows()[0])[2] === true);
check("largest value gets a full-width bar",
  brows()[0].querySelector(".mbar-fill").style.width === "100%",
  brows()[0].querySelector(".mbar-fill").style.width);

sortBy("pk");
check("bar moves to protein/100 kcal when sorted there", barCols(brows()[0])[6] === true &&
  barCols(brows()[0]).filter(Boolean).length === 1);
const perKcal = brows().map(r => parseFloat(bcells(r)[6]));
check("protein/100 kcal sorted descending", perKcal.every((v,i) => i === 0 || perKcal[i-1] >= v));
check("per-calorie ranking is the educational one (egg white beats almonds)",
  bnames().indexOf("Egg white, raw") < bnames().indexOf("Almonds"),
  `egg white #${bnames().indexOf("Egg white, raw")+1}, almonds #${bnames().indexOf("Almonds")+1}`);

// --- sort direction toggles, name sort has no bars ---
sortBy("pk");
check("clicking the same header flips direction",
  header("pk").closest("th").getAttribute("aria-sort") === "ascending");
sortBy("name");
check("name sort is alphabetical ascending", bnames()[0] < bnames()[1] && bnames()[0] === "Almond milk, unsweetened", bnames()[0]);
check("no bars when sorting by name", barCols(brows()[0]).filter(Boolean).length === 0);
check("legend explains how to get bars", /Sort by a number/.test($("b-legend").textContent), $("b-legend").textContent);

// --- portion column ---
sortBy("pp");
const eggRow = brows().find(r => r.querySelector(".bname").textContent.startsWith("Egg, whole"));
check("portion column states the assumption", bcells(eggRow)[3] === "1 large egg · 50 g", bcells(eggRow)[3]);
check("protein per portion computed from it", bcells(eggRow)[4] === "6.3 g", bcells(eggRow)[4]);
const steakRow = brows().find(r => r.querySelector(".bname").textContent.startsWith("Beef steak, lean (sirloin), raw"));
check("unit-less food falls back to 100 g", bcells(steakRow)[3] === "100 g" && bcells(steakRow)[4] === "21.9 g",
  `${bcells(steakRow)[3]} / ${bcells(steakRow)[4]}`);

// --- filtering ---
type($("b-q"), "cheese");
check("text filter narrows the table", brows().length > 3 && brows().length < 20, `${brows().length} rows`);
check("filter count is reported", /food/.test($("b-count").textContent), $("b-count").textContent);
type($("b-q"), "zzzznope");
check("empty filter state shown", $("b-rows").textContent.includes("No food matches"));
type($("b-q"), "");
$("b-group").value = "Fish & seafood";
$("b-group").dispatchEvent(new window.Event("change", { bubbles: true }));
check("group filter works", brows().every(r => r.querySelector(".bgrp").textContent.startsWith("Fish & seafood")),
  `${brows().length} rows`);

// --- pinning: the anchor behaviour ---
const pinRow = name => {
  const r = brows().find(x => x.querySelector(".bname").textContent.startsWith(name));
  click(r.querySelector(".pin-btn"));
};
pinRow("Cod, raw");
check("pinned row is marked", brows()[0].classList.contains("pinned") &&
  brows()[0].querySelector(".bname").textContent.startsWith("Cod, raw"));
check("pin button reports pressed state", brows()[0].querySelector(".pin-btn").getAttribute("aria-pressed") === "true");
$("b-group").value = "Nuts & seeds";
$("b-group").dispatchEvent(new window.Event("change", { bubbles: true }));
check("pinned food survives a filter that excludes it",
  bnames()[0] === "Cod, raw" && brows().length > 1, bnames().slice(0,3).join(" | "));
check("separator divides pins from the rest",
  !!$("b-rows").querySelector("tr.pin-sep"));
type($("b-q"), "zzzznope");
check("pins remain visible even with no other matches", bnames().length === 1 && bnames()[0] === "Cod, raw");
type($("b-q"), "");
check("pin count surfaced", /1 pinned/.test($("b-count").textContent), $("b-count").textContent);
check("pins persisted to localStorage",
  JSON.parse(window.localStorage.getItem("protein-calc.v1")).pins.includes("Cod, raw"));
// unpin
click(brows()[0].querySelector(".pin-btn"));
check("unpinning removes the anchor", bnames()[0] !== "Cod, raw" &&
  !JSON.parse(window.localStorage.getItem("protein-calc.v1")).pins.includes("Cod, raw"));
$("b-group").value = "";
$("b-group").dispatchEvent(new window.Event("change", { bubbles: true }));

// --- add to calculator from browse ---
const before = rows().length;
const target = brows().find(r => r.querySelector(".bname").textContent.startsWith("Tempeh"));
click(target.querySelector(".add-btn"));
check("+ adds the food to the calculator", rows().length === before + 1);
check("stays on the browse tab after adding", !$("view-browse").hidden, "browse still visible");
check("tab badge counts calculator items", $("tab-count").textContent === String(before + 1) && !$("tab-count").hidden,
  $("tab-count").textContent);
check("added row uses the food's default portion",
  rows().at(-1).querySelector("select").value === "1/2 cup",
  rows().at(-1).querySelector("select").value);

// --- sort choice persists ---
sortBy("k");
const stored2 = JSON.parse(window.localStorage.getItem("protein-calc.v1"));
check("sort column and direction persisted", stored2.sort === "k" && stored2.dir === -1,
  `${stored2.sort} ${stored2.dir}`);

// --- energy data integrity ---
let kbad = [];
for (const f of FOODS) {
  if (!(f.k >= 0 && f.k <= 900)) kbad.push(`${f.name}: k=${f.k}`);
  if (f.p * 4 > f.k * 1.15 + 1) kbad.push(`${f.name}: ${f.p}g protein needs ${(f.p*4).toFixed(0)} kcal but k=${f.k}`);
}
check("every food has plausible energy data", kbad.length === 0, kbad.slice(0,3).join("; "));

console.log("\n" + (fail ? fail + " FAILURE(S)" : "all checks passed"));
process.exit(fail ? 1 : 0);
