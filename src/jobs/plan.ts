import path from "node:path";

export interface PlanStep {
  step: number;
  title: string;
  text: string;
  files: string[];
  testBlocks: { path: string; content: string }[];
}

export function planTitle(markdown: string): string {
  const match = markdown.match(/^#\s+(.*)$/m);
  return match ? match[1].trim() : "";
}

export function parsePlanStep(markdown: string, step: number): PlanStep {
  const lines = markdown.split(/\r?\n/);
  const stepRegex = new RegExp(`^(#{2,4})\\s+Task\\s+${step}[:.]\\s*(.*)$`);

  let startLineIdx = -1;
  let headingLevel = 0;
  let title = "";

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(stepRegex);
    if (match) {
      headingLevel = match[1].length;
      title = match[2].trim();
      startLineIdx = i;
      break;
    }
  }

  if (startLineIdx === -1) {
    throw new Error(`step ${step} not found`);
  }

  let endLineIdx = lines.length;
  const nextHeadingRegex = new RegExp(`^#{1,${headingLevel}}\\s+`);
  for (let i = startLineIdx + 1; i < lines.length; i++) {
    if (nextHeadingRegex.test(lines[i])) {
      endLineIdx = i;
      break;
    }
  }

  const sectionLines = lines.slice(startLineIdx, endLineIdx);
  const text = sectionLines.join("\n");

  const files: string[] = [];
  const fileLineRegex = /^\s*(?:-\s*(?:Create|Modify|Test):|\*\*Files:\*\*)/;

  for (const line of sectionLines) {
    if (fileLineRegex.test(line)) {
      const backticks = Array.from(line.matchAll(/`([^`]+)`/g)).map((m) => m[1]);
      for (const bt of backticks) {
        const parts = bt.split(",").map((p) => p.trim());
        for (const part of parts) {
          const cleaned = part.replace(/:\d+(?:-\d+)?$/, "").trim();
          if (cleaned && !files.includes(cleaned)) {
            files.push(cleaned);
          }
        }
      }
    }
  }

  const testBlocks: { path: string; content: string }[] = [];
  let inFence = false;
  let fenceContentLines: string[] = [];
  let fenceTestPath: string | null = null;

  for (let i = 0; i < sectionLines.length; i++) {
    const line = sectionLines[i];
    if (!inFence) {
      if (/^```.*$/.test(line)) {
        inFence = true;
        fenceContentLines = [];
        fenceTestPath = null;

        for (let j = i - 1; j >= 0; j--) {
          const prevLine = sectionLines[j].trim();
          if (prevLine.length > 0) {
            const backticks = Array.from(prevLine.matchAll(/`([^`]+)`/g)).map((m) => m[1]);
            for (const bt of backticks) {
              const base = path.basename(bt);
              if (/(\.test\.|\.spec\.|_test\.|^test_)/.test(base)) {
                fenceTestPath = bt;
                break;
              }
            }
            break;
          }
        }
      }
    } else {
      if (/^```\s*$/.test(line)) {
        inFence = false;
        if (fenceTestPath !== null) {
          testBlocks.push({
            path: fenceTestPath,
            content: fenceContentLines.join("\n") + "\n",
          });
        }
      } else {
        fenceContentLines.push(line);
      }
    }
  }

  return {
    step,
    title,
    text,
    files,
    testBlocks,
  };
}
