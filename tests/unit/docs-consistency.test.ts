/**
 * The documentation makes claims the code can be checked against, so the claims are checked.
 *
 * The host-exec default is a posture: if `README.md` / `README.zh-CN.md` / `docs/configuration.md`
 * state a default that `DEFAULTS` does not implement, an operator follows the docs and gets the
 * opposite of what they were told. This is the weakest possible form of that check (the stated value
 * must equal the implemented one, and the two READMEs must agree with each other), and it is still
 * stronger than the grep it replaces: it fails when the default moves and a document does not.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/config.js";

const read = (path: string): string => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");

describe("documentation states the host-execution default the code implements", () => {
  it("docs/configuration.md names the implemented default", () => {
    const text = read("docs/configuration.md");

    expect(text).toContain("- `allow` — `boolean`, default **`" + String(DEFAULTS.hostExecution.allow) + "`**");
  });

  it("the English and Chinese READMEs agree on the example value", () => {
    const expected = `"hostExecution": { "allow": ${String(DEFAULTS.hostExecution.allow)} }`;

    expect(read("README.md")).toContain(expected);
    expect(read("README.zh-CN.md")).toContain(expected);
  });

  it("no operator-facing document (either language) still calls host execution deny-by-default", () => {
    // The SENTENCES an operator would read before the change. The Chinese bullet survived the posture change
    // because the old check only grepped the English phrasing (adversarial review).
    const forbidden = [
      "`true` only when **both** grant it",
      "destructive\n  actions, and host execution are all denied",
      "破坏性操作和宿主机执行默认全部被拒",
      "宿主机执行默认被拒",
    ];
    for (const path of ["README.md", "README.zh-CN.md", "docs/configuration.md", "docs/security.md", "SECURITY.md", "docs/troubleshooting.md"]) {
      const text = read(path);
      for (const sentence of forbidden) {
        expect(text, `${path} still describes the old posture: ${sentence}`).not.toContain(sentence);
      }
    }
  });

  it("the shipped posture sentence appears in both READMEs", () => {
    // The positive direction: the grant-by-default must be stated, not merely not-contradicted.
    expect(read("README.md")).toContain("host execution is the one surface granted by default");
    expect(read("README.zh-CN.md")).toContain("宿主执行是唯一默认开启的面");
  });
});
