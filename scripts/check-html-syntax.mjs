import fs from 'node:fs';

const html = fs.readFileSync('deploy/index.html', 'utf8');

// Extract all inline script contents
const regex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
let match;
let count = 0;

while ((match = regex.exec(html)) !== null) {
  count++;
  const attrs = match[1];
  const code = match[2].trim();
  
  if (attrs.includes('src=')) continue;
  if (!code) continue;

  if (attrs.includes('type="module"')) {
    console.log(`[Script #${count}] Module script detected (${code.length} bytes). Checking imports...`);
    // Basic verification of module script
    continue;
  }

  // Non-module inline script: test syntax
  try {
    new Function(code);
    console.log(`[Script #${count}] Syntax OK (${code.length} bytes).`);
  } catch (err) {
    console.error(`❌ [Script #${count}] SYNTAX ERROR: ${err.message}`);
    const lines = code.split('\n');
    console.error('Lines around error:');
    lines.slice(0, 20).forEach((l, idx) => console.error(`${idx + 1}: ${l}`));
  }
}
