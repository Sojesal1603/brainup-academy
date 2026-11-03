const fs = require('fs');

const env = fs.readFileSync('.env', 'utf8');
const lines = env.split('\n');
const envMap = {};
for (const line of lines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) continue;
  const idx = trimmed.indexOf('=');
  if (idx > 0) {
    const k = trimmed.slice(0, idx).trim();
    let v = trimmed.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    envMap[k] = v;
  }
}

async function main() {
  console.log('Gemini key format:', envMap.GEMINI_API_KEY?.slice(0, 10));
  console.log('Groq key format:', envMap.GROQ_API_KEY?.slice(0, 10));

  // Test Groq
  try {
    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${envMap.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'Di hola en una palabra' }]
      })
    });
    const groqData = await groqRes.json();
    console.log('Groq status:', groqRes.status);
    console.log('Groq response:', JSON.stringify(groqData));
  } catch (err) {
    console.error('Groq fetch error:', err);
  }

  // Test Gemini
  try {
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${envMap.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Di hola' }] }]
      })
    });
    const geminiData = await geminiRes.json();
    console.log('Gemini status:', geminiRes.status);
    console.log('Gemini response:', JSON.stringify(geminiData));
  } catch (err) {
    console.error('Gemini fetch error:', err);
  }
}

main();
