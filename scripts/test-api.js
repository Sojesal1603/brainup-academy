const fs = require('fs');

async function main() {
  const env = fs.readFileSync('.env', 'utf8');
  const key = env.match(/GEMINI_API_KEY="([^"]+)"/)[1];
  const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?key=' + key);
  const data = await res.json();
  const names = data.models ? data.models.map(m => m.name.replace('models/', '')) : data;
  console.log('Gemini model names count:', names.length);
  console.log('Flash models:', names.filter(n => n.includes('flash')));
}

main().catch(console.error);
