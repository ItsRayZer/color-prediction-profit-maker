import fs from 'node:fs';

const html = fs.readFileSync('index.html', 'utf8');

const badSnippet = "    sp.innerHTML = `${sig.target} (${Math.round((sig.prob || 0.75) * 100)}%)`;\n  }\n    let pillClass = 'ai-signal-pill ';";

if (html.includes(badSnippet)) {
  const fixed = html.replace(badSnippet, "");
  fs.writeFileSync('index.html', fixed, 'utf8');
  console.log('✅ Found and removed badSnippet from index.html');
} else {
  console.error('❌ badSnippet not found');
}
