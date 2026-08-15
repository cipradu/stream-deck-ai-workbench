import { readFile, writeFile } from "node:fs/promises";

import { listStatusProviderOptions } from "../../../packages/action-status/src/index.ts";

const outputUrl = new URL("../com.blackice.ai-workbench.sdPlugin/ui/status-display.html", import.meta.url);
const args = process.argv.slice(2);
const checkOnly = args.length === 1 && args[0] === "--check";

if (args.length > 0 && !checkOnly) {
  throw new Error("Usage: generate-status-property-inspector.ts [--check]");
}

const html = renderStatusPropertyInspector();

if (checkOnly) {
  const current = await readFile(outputUrl, "utf8");
  if (current !== html) {
    throw new Error("Generated Status Property Inspector is stale. Run pnpm --filter @ai-workbench/streamdeck generate:status-pi.");
  }
} else {
  await writeFile(outputUrl, html, "utf8");
}

function renderStatusPropertyInspector(): string {
  const options = listStatusProviderOptions();
  const optionHtml = options
    .map((option) => `\t\t\t<option value="${escapeHtml(option.providerId)}">${escapeHtml(option.pickerLabel)}</option>`)
    .join("\n");

  return `<!DOCTYPE html>
<!-- Generated file. Edit scripts/generate-status-property-inspector.ts and the Status provider registry instead. -->
<html lang="en">
<head>
\t<meta charset="utf-8" />
\t<title>Status Settings</title>
\t<script src="sdpi-components.js"></script>
</head>
<body>
\t<sdpi-item label="Provider">
\t\t<sdpi-select setting="providerId" placeholder="Anthropic (default)">
${optionHtml}
\t\t</sdpi-select>
\t</sdpi-item>

\t<sdpi-item label="Refresh (s)">
\t\t<sdpi-textfield setting="intervalSeconds" type="number" placeholder="600 (min 60)"></sdpi-textfield>
\t</sdpi-item>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
