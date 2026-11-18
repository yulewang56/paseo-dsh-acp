import assert from "node:assert/strict";
import { test } from "node:test";
import { apply } from "./agent-preset.mjs";

function harness() {
  const sections = [];
  const restrictions = [];
  const effects = [];
  const ctx = {
    systemPrompt: {
      getSectionOrder: (name) => {
        assert.equal(name, "DEPLOYMENT_PERSONA_PREFIX");
        return 10;
      },
      section: (section) => {
        sections.push(section);
        return () => {};
      },
    },
    tools: {
      definitions: () => [{ name: "read" }, { name: "bash" }, { name: "run_code" }],
      restrict: (filter) => {
        restrictions.push(filter);
        return () => {};
      },
    },
    effect: (callback) => {
      effects.push(callback());
      return () => {};
    },
  };
  return { ctx, sections, restrictions, effects };
}

test("installs a literal persona section and a tool restriction", () => {
  const h = harness();
  apply(h.ctx, { prompt: "Use {{literal}} braces.", tools: { allow: ["read"], deny: ["bash"] } });
  assert.equal(h.sections.length, 1);
  assert.deepEqual(h.sections[0], {
    name: "deployment:persona-prefix",
    order: 10,
    text: "Use {{literal}} braces.",
    interpolate: false,
  });
  assert.deepEqual(h.restrictions, [{ allow: ["read"], deny: ["bash"] }]);
});

test("does not restrict tools or add an empty persona when absent", () => {
  const h = harness();
  apply(h.ctx, { prompt: "  ", tools: null });
  assert.equal(h.sections.length, 0);
  assert.equal(h.restrictions.length, 0);
});

test("explicit empty tools deny every currently registered tool", () => {
  const h = harness();
  apply(h.ctx, { prompt: "Body", tools: { none: true } });
  assert.deepEqual(h.restrictions, [{ deny: ["read", "bash"] }]);
});
