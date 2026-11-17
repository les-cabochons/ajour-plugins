// The default prompt template plugin.json declares, checked with the rules
// Ajour applies to capabilities.handoff.promptTemplate. The SDK doesn't ship
// them, so this file repeats, as of les-cabochons/ajour 436b146e,
// packages/shared/agent-task-templates.ts
// (the slot pattern and fillTemplate) and handoff-templates.ts (the slots,
// the 16 KB limit, and a template that fills with every slot empty).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const manifest = JSON.parse(
  readFileSync(new URL("../plugin.json", import.meta.url), "utf8"),
);
const template = manifest.capabilities.handoff.promptTemplate;

const SLOT_PATTERN =
  /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*(?:\s*\|\s*[A-Za-z_][A-Za-z0-9_-]*)?)\s*\}\}/g;
const HANDOFF_SLOTS = [
  "item.key",
  "item.title",
  "item.description",
  "item.url",
  "item.type",
  "item.parent.key",
  "item.parent.title",
  "project.name",
  "repo.name",
];
// Ajour's own default title template, which names the thread.
const TITLE_TEMPLATE = "[{{item.key}}] {{item.title}}";

function slug(value) {
  return (
    value
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "") || "item"
  );
}

function fillTemplate(text, values) {
  return text.replace(SLOT_PATTERN, (_match, expression) => {
    const [slot = "", filter, ...extra] = expression
      .split("|")
      .map((part) => part.trim());
    if (extra.length || filter === "")
      throw new Error(`The template uses {{${expression}}}.`);
    if (!Object.hasOwn(values, slot))
      throw new Error(
        `The template uses {{${slot}}}, which Ajour does not fill.`,
      );
    if (filter && filter !== "slug")
      throw new Error(`The template uses {{${slot}|${filter}}}.`);
    return filter === "slug" ? slug(values[slot]) : values[slot];
  });
}

const listSlots = (text) => [
  ...new Set(
    [...text.matchAll(SLOT_PATTERN)].map((m) => m[1].split("|")[0].trim()),
  ),
];

/** The errors Ajour's handoffTemplateSchema gives a template. */
function templateErrors(text) {
  if (typeof text !== "string") return ["Not a string."];
  const errors = [];
  if (new TextEncoder().encode(text).length > 16384)
    errors.push("Template exceeds 16 KB.");
  try {
    fillTemplate(text, Object.fromEntries(HANDOFF_SLOTS.map((s) => [s, ""])));
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

const fill = (values) =>
  fillTemplate(template, {
    "item.key": "AJ-42",
    "item.title": "Hand off to Copilot CLI",
    "item.description": "",
    "item.url": "https://example.com/AJ-42",
    "item.type": "Task",
    "item.parent.key": "",
    "item.parent.title": "",
    "project.name": "Ajour",
    "repo.name": "ajour",
    ...values,
  });

test("the manifest declares a default prompt template Ajour accepts", () => {
  assert.equal(typeof template, "string");
  assert.deepEqual(templateErrors(template), []);
  for (const slot of listSlots(template))
    assert.ok(HANDOFF_SLOTS.includes(slot), slot);
});

test("the check refuses what Ajour refuses", () => {
  assert.deepEqual(templateErrors("{{item.key}} {{item.title|slug}}"), []);
  assert.deepEqual(templateErrors("{{item.id}}"), [
    "The template uses {{item.id}}, which Ajour does not fill.",
  ]);
  assert.equal(templateErrors("{{item.title|upper}}").length, 1);
  assert.equal(templateErrors("{{weekOf}}").length, 1);
  assert.deepEqual(templateErrors("x".repeat(16385)), [
    "Template exceeds 16 KB.",
  ]);
});

test("the prompt gives the item's key, title, description, link, type and parent", () => {
  for (const slot of [
    "item.key",
    "item.title",
    "item.description",
    "item.url",
    "item.type",
    "item.parent.key",
    "item.parent.title",
  ])
    assert.ok(listSlots(template).includes(slot), slot);
});

test("the prompt opens with the thread's name, [KEY] title", () => {
  assert.equal(template.split("\n", 1)[0], TITLE_TEMPLATE);
});

test("a filled prompt asks the agent to work in the repository", () => {
  assert.equal(
    fill({
      "item.description": "Start it.\n\n- Reopen it.",
      "item.parent.key": "AJ-7",
      "item.parent.title": "Agent handoff",
    }),
    "[AJ-42] Hand off to Copilot CLI\n" +
      "\n" +
      "Work on this Task in the ajour repository, from the folder you start in. Work on the branch you are on, and open a pull request when you are done.\n" +
      "\n" +
      "Link: https://example.com/AJ-42\n" +
      "Parent, if any: AJ-7 Agent handoff\n" +
      "\n" +
      "Start it.\n" +
      "\n" +
      "- Reopen it.",
  );
});

test("an item without a parent or description leaves no slot behind", () => {
  const prompt = fill({});
  assert.doesNotMatch(prompt, /\{\{|\}\}/);
  assert.ok(
    prompt.endsWith("Link: https://example.com/AJ-42\nParent, if any:  \n\n"),
  );
});
