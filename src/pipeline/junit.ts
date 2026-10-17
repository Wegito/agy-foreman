export interface TestCounts {
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  failed: string[];
}

export function parseJUnit(xml: string): TestCounts {
  const result: TestCounts = {
    tests: 0,
    failures: 0,
    errors: 0,
    skipped: 0,
    failed: [],
  };

  if (!xml || !xml.trim()) {
    return result;
  }

  const testcaseRegex = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  let match: RegExpExecArray | null;

  while ((match = testcaseRegex.exec(xml)) !== null) {
    result.tests++;
    const attrs = match[1] || "";
    const body = match[2] || "";

    const classnameMatch = attrs.match(/\bclassname=["']([^"']*)["']/i);
    const nameMatch = attrs.match(/\bname=["']([^"']*)["']/i);

    const classname = classnameMatch ? classnameMatch[1].trim() : "";
    const name = nameMatch ? nameMatch[1].trim() : "";

    const label = classname && name ? `${classname} > ${name}` : name || classname;

    const hasFailure = /<failure\b/i.test(body);
    const hasError = /<error\b/i.test(body);
    const hasSkipped = /<skipped\b/i.test(body);

    if (hasFailure) {
      result.failures++;
    }
    if (hasError) {
      result.errors++;
    }
    if (hasFailure || hasError) {
      result.failed.push(label);
    }
    if (hasSkipped) {
      result.skipped++;
    }
  }

  return result;
}
