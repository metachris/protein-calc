/*
 * Interaction tests for index.html — run against a simulated DOM.
 *
 *   npm i jsdom && node test.mjs
 *
 * Covers the search combobox, unit conversion, per-row and total protein math,
 * the daily-target bar, localStorage round-tripping, USDA response parsing,
 * and HTML escaping of food names coming from the API.
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
check("300 g steak = 66.0 g protein", cells(tr)[4] === "66.0 g", `got ${cells(tr)[4]}`);

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
const expected = 18.9 + 66.0 + 28.3495 * 0.212;
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

console.log("\n" + (fail ? fail + " FAILURE(S)" : "all checks passed"));
process.exit(fail ? 1 : 0);
